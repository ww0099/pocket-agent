import fs from 'node:fs';
import path from 'node:path';

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { SessionRuntime } from '../src/runtime/session-runtime.js';
import { ApprovalBroker } from '../src/ui/approval.js';
import { App } from '../src/ui/ink/App.js';
import { makeTempDir } from './helpers/index.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stubRuntime(cwd = process.cwd()): SessionRuntime {
  let currentModel = 'mock-model';

  return {
    providerId: 'deepseek',
    get model() {
      return currentModel;
    },
    permissionMode: 'default',
    cwd,
    session: { id: 'test-session-12345678' },
    history: () => [],
    permissionRules: [],
    setModel: (model?: string) => {
      currentModel = model?.trim() || 'mock-model';
    },
    switchProvider: vi.fn(),
    setPermissionMode: vi.fn(),
    newSession: vi.fn(),
    addAllowRule: vi.fn(),
    runTurn: vi.fn(),
    close: vi.fn(),
    formatUsage: () => 'usage',
    expandCustomCommand: () => undefined,
    compactNow: async () => undefined,
    listModels: async () => [],
  } as unknown as SessionRuntime;
}

describe('Ink App', () => {
  it('渲染欢迎信息、输入提示与状态栏', () => {
    const broker = new ApprovalBroker();
    const { lastFrame, unmount } = render(<App runtime={stubRuntime()} broker={broker} />);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('PocketAgent');
    expect(frame).toContain('/help');
    expect(frame).toContain('deepseek/mock-model');
    expect(frame).toContain('test-session-12345678'.slice(-8));

    unmount();
  });

  it('/model 更新状态栏模型', async () => {
    const broker = new ApprovalBroker();
    const { lastFrame, stdin, unmount } = render(<App runtime={stubRuntime()} broker={broker} />);

    stdin.write('/model deepseek-flash');
    stdin.write('\r');
    await delay(150);

    expect(lastFrame() ?? '').toContain('deepseek/deepseek-flash');
    unmount();
  });

  it('审批按键：d 拒绝、a 允许本次、↑/↓+Enter 始终允许', async () => {
    const cwd = makeTempDir('ink-approval');
    const broker = new ApprovalBroker();
    const runtime = stubRuntime(cwd);
    const { lastFrame, stdin, unmount } = render(<App runtime={runtime} broker={broker} />);

    const request = {
      tool: 'Write',
      input: { file_path: 'denied.txt', content: 'no' },
      isReadOnly: false,
      isDestructive: false,
    };

    const deny = broker.ask(request, '测试拒绝');
    await delay(60);
    expect(lastFrame() ?? '').toContain('需要授权');
    stdin.write('d');
    await expect(deny).resolves.toBe(false);

    const allowOnce = broker.ask(request, '测试允许');
    await delay(60);
    stdin.write('a');
    await expect(allowOnce).resolves.toBe(true);

    const always = broker.ask(request, '测试始终允许');
    await delay(60);
    // 模拟快速按键：↓ 选中“本项目始终允许”，紧接着 Enter（验证同步 ref）
    stdin.write('[B');
    stdin.write('\r');
    await expect(always).resolves.toBe(true);

    const permissionsFile = path.join(cwd, '.agent', 'permissions.json');
    expect(fs.existsSync(permissionsFile)).toBe(true);
    expect(fs.readFileSync(permissionsFile, 'utf8')).toContain('Write(denied.txt)');

    const rapidDeny = broker.ask(request, '测试快速拒绝');
    await delay(60);
    stdin.write('3');
    stdin.write('\r');
    await expect(rapidDeny).resolves.toBe(false);

    // 未选择时按 Enter 不应授权（防止输入法提交误触）
    const untouched = broker.ask(request, '测试未选择');
    await delay(60);
    let settled = false;
    void untouched.then(() => {
      settled = true;
    });
    stdin.write('\r');
    await delay(80);
    expect(settled).toBe(false);
    stdin.write('d');
    await expect(untouched).resolves.toBe(false);

    unmount();
  });
});
