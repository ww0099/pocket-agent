import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { readJsoncFile } from '../bootstrap/config.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/log.js';
import { buildShellInvocation, defaultShellKind } from '../util/shell.js';

const HookDefinitionSchema = z
  .object({
    matcher: z.string().optional(),
    command: z.string().min(1),
    timeoutMs: z.number().int().positive().max(60_000).default(5_000),
  })
  .strict();

export const HookFileSchema = z
  .object({
    PreToolUse: z.array(HookDefinitionSchema).default([]),
    PostToolUse: z.array(HookDefinitionSchema).default([]),
  })
  .strict();

export interface HookDefinition {
  matcher?: string;
  command: string;
  timeoutMs: number;
  event: 'PreToolUse' | 'PostToolUse';
}

export interface HookConfig {
  preToolUse: HookDefinition[];
  postToolUse: HookDefinition[];
}

export interface HookPayload {
  event: 'PreToolUse' | 'PostToolUse';
  tool: string;
  input: unknown;
  cwd: string;
}

export interface HookRunOptions {
  cwd: string;
  signal?: AbortSignal;
  logger: Logger;
}

export interface HookResult {
  blocked: boolean;
  reason?: string;
  output?: string;
}

export const EMPTY_HOOKS: HookConfig = { preToolUse: [], postToolUse: [] };

export function loadHooks(agentRoot: string, cwd: string): HookConfig {
  const preToolUse: HookDefinition[] = [];
  const postToolUse: HookDefinition[] = [];

  for (const file of [
    path.join(agentRoot, 'config', 'hooks.json'),
    path.join(cwd, '.agent', 'hooks.json'),
  ]) {
    if (!fs.existsSync(file)) continue;

    const config = readJsoncFile(file, HookFileSchema);
    for (const hook of config.PreToolUse) {
      preToolUse.push({ ...hook, event: 'PreToolUse' });
    }
    for (const hook of config.PostToolUse) {
      postToolUse.push({ ...hook, event: 'PostToolUse' });
    }
  }

  return { preToolUse, postToolUse };
}

export function matchesHook(hook: HookDefinition, toolName: string): boolean {
  return !hook.matcher || hook.matcher === '*' || hook.matcher === toolName;
}

export async function runHooks(
  hooks: HookDefinition[],
  payload: HookPayload,
  options: HookRunOptions,
): Promise<HookResult> {
  const result: HookResult = { blocked: false };

  for (const hook of hooks) {
    const hookResult = await runOne(hook, payload, options);

    if (hookResult.output) {
      result.output = [result.output, hookResult.output].filter(Boolean).join('\n');
    }
    if (hookResult.blocked) {
      return { ...result, blocked: true, reason: hookResult.reason };
    }
  }

  return result;
}

async function runOne(
  hook: HookDefinition,
  payload: HookPayload,
  options: HookRunOptions,
): Promise<HookResult> {
  const invocation = buildShellInvocation(defaultShellKind(), hook.command);

  return new Promise<HookResult>((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: HookResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killTree(child.pid);
      finish({ blocked: true, reason: `Hook 超时（${hook.timeoutMs}ms）` });
    }, hook.timeoutMs);

    const onAbort = (): void => {
      killTree(child.pid);
      finish({ blocked: true, reason: 'Hook 被取消' });
    };

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      options.logger.warn(`Hook 启动失败：${errorMessage(error)}`);
      finish({ blocked: false });
    });

    child.on('close', (code) => {
      if (code === 2) {
        finish({
          blocked: true,
          reason: stdout.trim() || stderr.trim() || 'Hook 返回退出码 2',
        });
        return;
      }
      finish({ blocked: false, output: stdout.trim() || undefined });
    });

    child.stdin?.write(JSON.stringify(payload));
    child.stdin?.end();
  });
}

function killTree(pid: number | undefined): void {
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
