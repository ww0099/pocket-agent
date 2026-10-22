import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadHooks, runHooks } from '../src/extensions/hooks.js';
import { PermissionGate } from '../src/permissions/gate.js';
import { createToolExecutor } from '../src/tools/executor.js';
import { createCoreTools } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { silentLogger } from '../src/util/log.js';
import { createTestContext, writeTestFile } from './helpers/index.js';

describe('hooks config', () => {
  it('合并全局与项目 hooks', () => {
    const ctx = createTestContext();
    writeTestFile(
      ctx.agentRoot,
      'config/hooks.json',
      JSON.stringify({ PreToolUse: [{ matcher: 'Bash', command: 'exit 2' }] }),
    );
    writeTestFile(
      ctx.cwd,
      '.agent/hooks.json',
      JSON.stringify({ PostToolUse: [{ command: 'Write-Output ok' }] }),
    );

    const hooks = loadHooks(ctx.agentRoot, ctx.cwd);

    expect(hooks.preToolUse).toHaveLength(1);
    expect(hooks.preToolUse[0]).toMatchObject({ matcher: 'Bash', event: 'PreToolUse' });
    expect(hooks.postToolUse).toHaveLength(1);
    expect(hooks.postToolUse[0]).toMatchObject({ event: 'PostToolUse' });
  });
});

describe('hook execution', () => {
  it('退出码 2 阻止执行并返回原因', async () => {
    const ctx = createTestContext();
    const result = await runHooks(
      [
        {
          event: 'PreToolUse',
          matcher: 'Bash',
          command: 'Write-Output "blocked-by-hook"; exit 2',
          timeoutMs: 5_000,
        },
      ],
      { event: 'PreToolUse', tool: 'Bash', input: { command: 'echo hi' }, cwd: ctx.cwd },
      { cwd: ctx.cwd, logger: silentLogger },
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('blocked-by-hook');
  });

  it('正常 hook 返回输出但不阻止', async () => {
    const ctx = createTestContext();
    const result = await runHooks(
      [
        {
          event: 'PostToolUse',
          command: 'Write-Output "hook-ok"',
          timeoutMs: 5_000,
        },
      ],
      { event: 'PostToolUse', tool: 'Read', input: {}, cwd: ctx.cwd },
      { cwd: ctx.cwd, logger: silentLogger },
    );

    expect(result.blocked).toBe(false);
    expect(result.output).toContain('hook-ok');
  });

  it('PreToolUse 阻止时执行器不调用工具', async () => {
    const ctx = createTestContext();
    ctx.hooks = {
      preToolUse: [
        {
          event: 'PreToolUse',
          matcher: 'Write',
          command: 'exit 2',
          timeoutMs: 5_000,
        },
      ],
      postToolUse: [],
    };

    const registry = new ToolRegistry(createCoreTools());
    const gate = new PermissionGate({
      mode: 'acceptEdits',
      rules: [],
      cwd: ctx.cwd,
      ask: async () => true,
    });
    const executor = createToolExecutor({ registry, context: ctx, gate });

    const results = await executor(
      [
        {
          id: 'c1',
          name: 'Write',
          input: { file_path: 'blocked.txt', content: 'should not exist' },
        },
      ],
      ctx.signal,
    );

    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.output).toContain('Hook 阻止');
    expect(fs.existsSync(path.join(ctx.cwd, 'blocked.txt'))).toBe(false);
  });
});
