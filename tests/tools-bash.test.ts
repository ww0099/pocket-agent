import { describe, expect, it } from 'vitest';

import { bashTool, inspectCommand } from '../src/tools/bash.js';
import { createTestContext } from './helpers/index.js';

describe('inspectCommand', () => {
  it('拦截灾难性命令', () => {
    expect(inspectCommand('format D:').blocked).toBeDefined();
    expect(inspectCommand('diskpart').blocked).toBeDefined();
    expect(inspectCommand('shutdown /s /t 0').blocked).toBeDefined();
    expect(inspectCommand('bcdedit /set safeboot minimal').blocked).toBeDefined();
  });

  it('标记破坏性命令但不直接拦截', () => {
    expect(inspectCommand('rm -rf build')).toMatchObject({ destructive: true });
    expect(inspectCommand('Remove-Item -Recurse -Force .\\dist')).toMatchObject({
      destructive: true,
    });
    expect(inspectCommand('npm test').destructive).toBe(false);
  });
});

describe('Bash tool', () => {
  it('执行命令并返回 stdout 与退出码', async () => {
    const ctx = createTestContext();

    const result = await bashTool.call({ command: 'Write-Output "hello-bash"' }, ctx);

    expect(result.isError).toBe(false);
    expect(result.output).toContain('hello-bash');
    expect(result.output).toContain('退出码：0');
  });

  it('非零退出码标记为错误', async () => {
    const ctx = createTestContext();

    const result = await bashTool.call({ command: 'exit 7' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('退出码：7');
  });

  it('被拦截的命令不会执行', async () => {
    const ctx = createTestContext();

    await expect(bashTool.call({ command: 'format D:' }, ctx)).rejects.toThrow(/安全策略拦截/);
  });

  it('超时会终止进程并标记', async () => {
    const ctx = createTestContext();

    const result = await bashTool.call(
      { command: 'Start-Sleep -Seconds 10', timeout_ms: 1000 },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.metadata?.timedOut).toBe(true);
  });
});
