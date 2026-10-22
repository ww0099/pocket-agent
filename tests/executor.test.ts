import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../src/core/events.js';
import { runAgent } from '../src/core/loop.js';
import { userText } from '../src/core/messages.js';
import { PermissionGate } from '../src/permissions/gate.js';
import type { Provider, ProviderCapabilities, StreamRequest } from '../src/providers/types.js';
import { createToolExecutor } from '../src/tools/executor.js';
import { createCoreTools } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { collect, createTestContext } from './helpers/index.js';

function setup(ask: boolean, mode: 'default' | 'acceptEdits' = 'acceptEdits') {
  const context = createTestContext();
  const registry = new ToolRegistry(createCoreTools());
  const gate = new PermissionGate({
    mode,
    rules: [],
    cwd: context.cwd,
    ask: async () => ask,
  });
  const executor = createToolExecutor({ registry, context, gate });
  return { context, registry, executor };
}

const CAPABILITIES: ProviderCapabilities = {
  toolUse: true,
  parallelToolCalls: true,
  streaming: true,
  promptCaching: false,
  maxContextTokens: 1000,
  maxOutputTokens: 100,
};

describe('tool executor', () => {
  it('执行 Write 后文件落盘，并可被 Read 读回', async () => {
    const { context, executor } = setup(false);

    const writeResults = await executor(
      [{ id: 'c1', name: 'Write', input: { file_path: 'a.txt', content: 'hello tool' } }],
      context.signal,
    );
    expect(writeResults[0]?.isError).toBe(false);
    expect(fs.readFileSync(path.join(context.cwd, 'a.txt'), 'utf8')).toBe('hello tool');

    const readResults = await executor(
      [{ id: 'c2', name: 'Read', input: { file_path: 'a.txt' } }],
      context.signal,
    );
    expect(readResults[0]?.isError).toBe(false);
    expect(readResults[0]?.output).toContain('hello tool');
  });

  it('权限拒绝时不执行工具', async () => {
    const { context, executor } = setup(false, 'default');

    const results = await executor(
      [{ id: 'c1', name: 'Write', input: { file_path: 'b.txt', content: 'nope' } }],
      context.signal,
    );

    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.output).toContain('权限拒绝');
    expect(fs.existsSync(path.join(context.cwd, 'b.txt'))).toBe(false);
  });

  it('未知工具与非法参数返回结构化错误', async () => {
    const { context, executor } = setup(true);

    const results = await executor(
      [
        { id: 'c1', name: 'Nope', input: {} },
        { id: 'c2', name: 'Read', input: {} },
      ],
      context.signal,
    );

    expect(results[0]?.output).toContain('未知工具');
    expect(results[1]?.output).toContain('参数校验失败');
  });

  it('超长输出截断并把全文写入 tool-outputs', async () => {
    const { context, executor } = setup(true);
    context.limits.toolOutputBytes = 80;

    const content = Array.from({ length: 100 }, (_, index) => `line-${index}`).join('\n');
    fs.writeFileSync(path.join(context.cwd, 'big.txt'), content, 'utf8');

    const results = await executor(
      [{ id: 'big', name: 'Read', input: { file_path: 'big.txt' } }],
      context.signal,
    );

    const output = results[0]?.output ?? '';
    expect(output).toContain('输出已截断');
    expect(output).toContain('完整内容');

    const match = /完整内容：(.+?)\]/s.exec(output);
    expect(match?.[1]).toBeDefined();
    expect(fs.existsSync(match?.[1] ?? '')).toBe(true);
  });

  it('接入 runAgent 后完成“模型调用工具 → 工具结果 → 继续回答”的闭环', async () => {
    const { context, registry, executor } = setup(true);
    let calls = 0;

    const provider: Provider = {
      id: 'stub',
      type: 'openai',
      model: 'stub',
      capabilities: CAPABILITIES,
      async *stream(_request: StreamRequest): AsyncGenerator<AgentEvent> {
        calls += 1;
        if (calls === 1) {
          yield { type: 'tool_call_start', id: 'call_1', name: 'Write' };
          yield {
            type: 'tool_call_end',
            id: 'call_1',
            name: 'Write',
            input: { file_path: 'note.txt', content: 'from tool' },
          };
          yield { type: 'stop', reason: 'tool_use' };
          return;
        }

        yield { type: 'text_delta', text: 'DONE' };
        yield { type: 'stop', reason: 'end' };
      },
    };

    const events = await collect(
      runAgent({
        provider,
        system: '',
        messages: [userText('write a file')],
        tools: registry.schemas(),
        maxTurns: 3,
        signal: context.signal,
        executeTools: executor,
      }),
    );

    expect(fs.readFileSync(path.join(context.cwd, 'note.txt'), 'utf8')).toBe('from tool');
    expect(events.filter((event) => event.type === 'turn_end')).toHaveLength(2);
    expect(events.some((event) => event.type === 'tool_result')).toBe(true);
    expect(events.some((event) => event.type === 'text_delta' && event.text === 'DONE')).toBe(true);
  });
});
