import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensureDefaultConfig, loadConfig } from '../src/bootstrap/config.js';
import { ensureRuntimeDirs } from '../src/bootstrap/paths.js';
import { loadSecrets } from '../src/bootstrap/secrets.js';
import type { AgentEvent } from '../src/core/events.js';
import { userText } from '../src/core/messages.js';
import type { Provider, ProviderCapabilities, StreamRequest } from '../src/providers/types.js';
import { SessionRuntime } from '../src/runtime/session-runtime.js';
import { silentLogger } from '../src/util/log.js';
import { collect, makeTempDir } from './helpers/index.js';

const CAPABILITIES: ProviderCapabilities = {
  toolUse: true,
  parallelToolCalls: true,
  streaming: true,
  promptCaching: false,
  maxContextTokens: 1000,
  maxOutputTokens: 100,
};

function stubProvider(): Provider {
  return {
    id: 'stub',
    type: 'openai',
    model: 'stub-model',
    capabilities: CAPABILITIES,
    async *stream(_request: StreamRequest): AsyncGenerator<AgentEvent> {
      yield { type: 'text_delta', text: 'hello' };
      yield { type: 'stop', reason: 'end' };
    },
  };
}

function setup() {
  const root = makeTempDir('runtime');
  ensureDefaultConfig(root);
  const config = loadConfig({ root });
  ensureRuntimeDirs(config.paths);
  const secrets = loadSecrets(config.paths.configDir, config.providers, {} as NodeJS.ProcessEnv);

  const runtime = new SessionRuntime({
    config,
    secrets,
    provider: stubProvider(),
    providerId: 'stub',
    logger: silentLogger,
    cwd: root,
    ask: async () => true,
  });

  return { root, runtime };
}

describe('SessionRuntime', () => {
  it('runTurn 记录用户与助手消息', async () => {
    const { runtime } = setup();

    const events = await collect(runtime.runTurn('hi'));
    expect(events.some((event) => event.type === 'text_delta')).toBe(true);

    const history = runtime.history();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: 'user' });
    expect(history[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  it('newSession 清空历史并生成新 ID', async () => {
    const { runtime } = setup();
    await collect(runtime.runTurn('hi'));

    const oldId = runtime.session.id;
    const next = runtime.newSession();

    expect(next.id).not.toBe(oldId);
    expect(runtime.history()).toHaveLength(0);
  });

  it('支持切换权限模式、模型与追加规则', () => {
    const { runtime } = setup();
    const before = runtime.permissionRules.length;

    runtime.setPermissionMode('plan');
    expect(runtime.permissionMode).toBe('plan');

    runtime.setModel('custom-model');
    expect(runtime.model).toBe('custom-model');

    runtime.addAllowRule('Bash(echo runtime-test)');
    expect(runtime.permissionRules.length).toBe(before + 1);

    runtime.addAllowRule('Bash(echo runtime-test)');
    expect(runtime.permissionRules.length).toBe(before + 1);
  });

  it('把 AGENTS.md 与 MEMORY.md 注入系统提示', async () => {
    const root = makeTempDir('runtime-memory');
    ensureDefaultConfig(root);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '项目规范：使用中文注释。', 'utf8');
    fs.mkdirSync(path.join(root, '.agent', 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.agent', 'memory', 'MEMORY.md'),
      '- [偏好](pref.md)\n',
      'utf8',
    );

    const config = loadConfig({ root });
    ensureRuntimeDirs(config.paths);
    const secrets = loadSecrets(config.paths.configDir, config.providers, {} as NodeJS.ProcessEnv);

    let capturedSystem = '';
    const provider: Provider = {
      ...stubProvider(),
      async *stream(request: StreamRequest): AsyncGenerator<AgentEvent> {
        capturedSystem = request.system;
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', reason: 'end' };
      },
    };

    const runtime = new SessionRuntime({
      config,
      secrets,
      provider,
      providerId: 'stub',
      logger: silentLogger,
      cwd: root,
      ask: async () => true,
    });

    await collect(runtime.runTurn('hi'));

    expect(capturedSystem).toContain('项目规范：使用中文注释');
    expect(capturedSystem).toContain('偏好');
  });

  it('统计 usage 并按价格表估算费用', async () => {
    const root = makeTempDir('runtime-cost');
    const configDir = path.join(root, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'stub' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(configDir, 'providers.json'),
      JSON.stringify({
        default: 'stub',
        providers: {
          stub: {
            type: 'openai',
            baseUrl: 'https://stub.test',
            model: 'stub-model',
            apiKeyEnv: 'STUB_KEY',
            maxContextTokens: 100_000,
            maxOutputTokens: 1_000,
            pricing: {
              currency: 'USD',
              inputPerMillion: 1,
              outputPerMillion: 2,
            },
          },
        },
      }),
      'utf8',
    );

    const config = loadConfig({ root });
    ensureRuntimeDirs(config.paths);
    const secrets = loadSecrets(config.paths.configDir, config.providers, {} as NodeJS.ProcessEnv);

    const provider: Provider = {
      ...stubProvider(),
      async *stream(): AsyncGenerator<AgentEvent> {
        yield {
          type: 'usage',
          usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
        };
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', reason: 'end' };
      },
    };

    const runtime = new SessionRuntime({
      config,
      secrets,
      provider,
      providerId: 'stub',
      logger: silentLogger,
      cwd: root,
      ask: async () => true,
    });

    await collect(runtime.runTurn('hi'));

    expect(runtime.getUsage()).toMatchObject({ input: 1_000_000, output: 500_000 });
    expect(runtime.formatUsage()).toContain('USD 2.0000');
  });

  it('超过窗口阈值时自动压缩并写入会话记录', async () => {
    const { runtime } = setup();

    for (let index = 0; index < 10; index += 1) {
      runtime.session.appendMessage(userText(`old user message ${index} `.repeat(30)));
      runtime.session.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `old assistant message ${index} `.repeat(30) }],
      });
    }

    const events = await collect(runtime.runTurn('final question'));

    expect(events.some((event) => event.type === 'compaction')).toBe(true);
    expect(runtime.session.records.some((record) => record.type === 'compaction')).toBe(true);
    expect(runtime.history().length).toBeLessThan(22);
  });

  it('展开项目自定义命令并记录展开后的提示', async () => {
    const { runtime } = setup();
    fs.mkdirSync(path.join(runtime.cwd, '.agent', 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(runtime.cwd, '.agent', 'commands', 'review.md'),
      '---\ndescription: 审查\n---\n审查 ${1} 的改动',
      'utf8',
    );

    expect(runtime.expandCustomCommand('/review main')).toBe('审查 main 的改动');
    expect(runtime.expandCustomCommand('/nope')).toBeUndefined();

    await collect(runtime.runTurn('/review main'));

    const history = runtime.history();
    expect(history[0]?.content[0]).toMatchObject({
      type: 'text',
      text: '审查 main 的改动',
    });
  });

  it('compactNow 手动压缩当前会话', async () => {
    const { runtime } = setup();

    for (let index = 0; index < 20; index += 1) {
      runtime.session.appendMessage(userText(`message ${index} `.repeat(20)));
    }

    const result = await runtime.compactNow();

    expect(result).toBeDefined();
    expect(runtime.history().length).toBeLessThan(20);
  });
});
