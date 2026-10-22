import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { buildShellInvocation } from '../util/shell.js';
import { type Tool, ToolInputError, defineTool } from './base.js';

const BashInputSchema = z.object({
  command: z.string().min(1).max(100_000),
  timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  run_in_background: z.boolean().optional(),
});

export interface CommandInspection {
  blocked?: string;
  destructive: boolean;
  reason?: string;
}

const BLOCK_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bformat\s+[a-z]:/i, reason: '格式化磁盘' },
  { pattern: /\bdiskpart\b/i, reason: '磁盘分区工具' },
  { pattern: /\bshutdown\b/i, reason: '关机/重启系统' },
  { pattern: /\bbcdedit\b/i, reason: '修改系统启动配置' },
  { pattern: /\breg\s+delete\s+hklm/i, reason: '删除注册表系统项' },
  { pattern: /\bmkfs(\.|\s|$)/i, reason: '格式化文件系统' },
  { pattern: /\bdd\s+if=/i, reason: '底层磁盘写入' },
  { pattern: /\bvssadmin\s+delete/i, reason: '删除卷影副本' },
  { pattern: /\bcipher\s+\/w/i, reason: '擦除磁盘空闲空间' },
  { pattern: /\brm\s+-rf\s+\/(\s|$)/i, reason: '递归删除根目录' },
  {
    pattern: /\b(del|erase)\s+\/[fsq]+\s+c:\\?\s*$/i,
    reason: '删除 C 盘内容',
  },
];

const DESTRUCTIVE_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, reason: '递归强制删除' },
  { pattern: /\bremove-item\b[^\n]*-recurse/i, reason: '递归删除目录' },
  { pattern: /\b(rd|rmdir)\s+\/s/i, reason: '递归删除目录' },
  { pattern: /\b(del|erase)\s+\/[fsq]/i, reason: '强制删除文件' },
  { pattern: /\bgit\s+clean\b[^\n]*-[a-z]*f/i, reason: 'git clean 会删除未跟踪文件' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: '丢弃未提交改动' },
  { pattern: /\bgit\s+push\b[^\n]*--force/i, reason: '强制推送远程' },
  { pattern: /\bnpm\s+publish\b/i, reason: '发布包到注册表' },
  { pattern: /\bdrop\s+(table|database)\b/i, reason: '删除数据库对象' },
  { pattern: /\btruncate\s+table\b/i, reason: '清空数据表' },
];

export function inspectCommand(command: string): CommandInspection {
  const normalized = command.replace(/\s+/g, ' ').trim();

  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(normalized)) {
      return { blocked: rule.reason, destructive: true, reason: rule.reason };
    }
  }

  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.pattern.test(normalized)) {
      return { destructive: true, reason: rule.reason };
    }
  }

  return { destructive: false };
}

export const bashTool: Tool = defineTool({
  name: 'Bash',
  description:
    '执行 shell 命令（Windows 默认 PowerShell）。支持超时与后台运行。危险命令会被安全策略直接拦截。',
  inputSchema: BashInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: (input) => {
    const parsed = BashInputSchema.safeParse(input);
    return parsed.success ? inspectCommand(parsed.data.command).destructive : false;
  },
  async call(input, ctx) {
    const args = BashInputSchema.parse(input);
    const inspection = inspectCommand(args.command);

    if (inspection.blocked) {
      throw new ToolInputError(`命令被安全策略拦截：${inspection.blocked}`);
    }

    if (args.run_in_background) {
      return runInBackground(args.command, ctx);
    }

    return runInForeground(args.command, args.timeout_ms ?? ctx.limits.bashTimeoutMs, ctx);
  },
});

async function runInForeground(
  command: string,
  timeoutMs: number,
  ctx: Parameters<Tool['call']>[1],
): Promise<{ output: string; isError: boolean; metadata: Record<string, unknown> }> {
  const invocation = buildShellInvocation(ctx.shell, command);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: ctx.cwd,
      env: process.env,
      windowsHide: true,
    });

    const stdout = createAccumulator(ctx.limits.bashMaxOutputBytes);
    const stderr = createAccumulator(ctx.limits.bashMaxOutputBytes);
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (code: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);

      if (error) {
        reject(new ToolInputError(`命令启动失败：${error.message}`, { cause: error }));
        return;
      }

      const duration = Date.now() - startedAt;
      const parts = [
        `$ ${command}`,
        `退出码：${code ?? 'null'}${timedOut ? '（超时）' : ''}${aborted ? '（已取消）' : ''}`,
        `耗时：${duration}ms`,
        '',
        'stdout:',
        stdout.text || '(空)',
      ];

      if (stderr.text) {
        parts.push('', 'stderr:', stderr.text);
      }
      if (stdout.truncated) {
        parts.push('', '[stdout 超过上限，已截断]');
      }
      if (stderr.truncated) {
        parts.push('', '[stderr 超过上限，已截断]');
      }

      resolve({
        output: parts.join('\n'),
        isError: code !== 0 || timedOut || aborted,
        metadata: { exitCode: code, timedOut, aborted, durationMs: duration },
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      killProcessTree(child.pid);
    };

    if (ctx.signal.aborted) {
      onAbort();
    } else {
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => appendCapped(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendCapped(stderr, chunk));
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code));
  });
}

async function runInBackground(
  command: string,
  ctx: Parameters<Tool['call']>[1],
): Promise<{ output: string; isError: boolean; metadata: Record<string, unknown> }> {
  const invocation = buildShellInvocation(ctx.shell, command);
  const logDir = path.join(ctx.paths.toolOutputsDir, ctx.sessionId);
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `bg-${Date.now()}.log`);
  const fd = fs.openSync(logFile, 'a');

  const child = spawn(invocation.command, invocation.args, {
    cwd: ctx.cwd,
    env: process.env,
    windowsHide: true,
    detached: true,
    stdio: ['ignore', fd, fd],
  });

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', (error) => reject(error));
  }).catch((error: unknown) => {
    fs.closeSync(fd);
    throw new ToolInputError(
      `后台命令启动失败：${error instanceof Error ? error.message : String(error)}`,
    );
  });

  child.unref();
  fs.closeSync(fd);

  return {
    output: `已在后台启动\nPID: ${child.pid ?? 'unknown'}\n日志: ${logFile}`,
    isError: false,
    metadata: { pid: child.pid, logFile },
  };
}

interface OutputAccumulator {
  text: string;
  bytes: number;
  truncated: boolean;
  limit: number;
}

function createAccumulator(limitBytes: number): OutputAccumulator {
  return { text: '', bytes: 0, truncated: false, limit: limitBytes };
}

function appendCapped(accumulator: OutputAccumulator, chunk: Buffer): void {
  if (accumulator.truncated) return;

  const remaining = accumulator.limit - accumulator.bytes;
  if (remaining <= 0) {
    accumulator.truncated = true;
    return;
  }

  const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  accumulator.text += slice.toString('utf8');
  accumulator.bytes += slice.length;

  if (slice.length < chunk.length) {
    accumulator.truncated = true;
  }
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;

  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => undefined);
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 进程可能已退出
  }
}
