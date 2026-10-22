import { ZodError } from 'zod';

import type { ToolCall, ToolExecution, ToolExecutor } from '../core/loop.js';
import { matchesHook, runHooks } from '../extensions/hooks.js';
import type { PermissionGate } from '../permissions/gate.js';
import { errorMessage } from '../util/errors.js';
import type { Tool, ToolContext } from './base.js';
import { persistToolOutput, truncateForContext } from './output.js';
import type { ToolRegistry } from './registry.js';

export interface CreateToolExecutorOptions {
  registry: ToolRegistry;
  context: ToolContext;
  gate: PermissionGate;
  onPermissionDecision?: (decision: {
    tool: string;
    behavior: 'allow' | 'deny';
    reason: string;
  }) => void;
}

interface Batch {
  concurrent: boolean;
  calls: ToolCall[];
}

/**
 * 工具执行器：只读且声明并发安全的工具成批并发，其余严格串行。
 */
export function createToolExecutor(options: CreateToolExecutorOptions): ToolExecutor {
  return async (calls, signal) => {
    const context: ToolContext = signal ? { ...options.context, signal } : options.context;
    const results: ToolExecution[] = [];

    for (const batch of partition(calls, options.registry)) {
      if (batch.concurrent) {
        const settled = await Promise.all(
          batch.calls.map((call) => executeOne(call, context, options)),
        );
        results.push(...settled);
      } else {
        for (const call of batch.calls) {
          results.push(await executeOne(call, context, options));
        }
      }
    }

    return results;
  };
}

function partition(calls: ToolCall[], registry: ToolRegistry): Batch[] {
  const batches: Batch[] = [];

  for (const call of calls) {
    const tool = registry.get(call.name);
    const concurrent = tool ? isConcurrencySafe(tool, call.input) : false;
    const last = batches[batches.length - 1];

    if (concurrent && last?.concurrent) {
      last.calls.push(call);
    } else {
      batches.push({ concurrent, calls: [call] });
    }
  }

  return batches;
}

async function executeOne(
  call: ToolCall,
  context: ToolContext,
  options: CreateToolExecutorOptions,
): Promise<ToolExecution> {
  const startedAt = Date.now();
  const tool = options.registry.get(call.name);

  if (!tool) {
    return { call, output: `未知工具：${call.name}`, isError: true };
  }

  let input: unknown;
  try {
    input = tool.inputSchema.parse(call.input);
  } catch (error) {
    return {
      call,
      output: `参数校验失败：${formatValidationError(error)}`,
      isError: true,
    };
  }

  try {
    const decision = await options.gate.decide({
      tool: tool.name,
      input,
      isReadOnly: safeBoolean(() => tool.isReadOnly(input)),
      isDestructive: safeBoolean(() => tool.isDestructive(input)),
    });

    options.onPermissionDecision?.({
      tool: tool.name,
      behavior: decision.behavior,
      reason: decision.reason,
    });

    if (decision.behavior === 'deny') {
      return { call, output: `权限拒绝：${decision.reason}`, isError: true };
    }

    const hooks = context.hooks;
    if (hooks) {
      const preHooks = hooks.preToolUse.filter((hook) => matchesHook(hook, tool.name));
      if (preHooks.length > 0) {
        const hookResult = await runHooks(
          preHooks,
          { event: 'PreToolUse', tool: tool.name, input, cwd: context.cwd },
          { cwd: context.cwd, signal: context.signal, logger: context.logger },
        );
        if (hookResult.blocked) {
          return {
            call,
            output: `Hook 阻止执行：${hookResult.reason ?? '未知原因'}`,
            isError: true,
          };
        }
      }
    }

    const result = await tool.call(input, context);

    if (hooks) {
      const postHooks = hooks.postToolUse.filter((hook) => matchesHook(hook, tool.name));
      if (postHooks.length > 0) {
        const hookResult = await runHooks(
          postHooks,
          { event: 'PostToolUse', tool: tool.name, input, cwd: context.cwd },
          { cwd: context.cwd, signal: context.signal, logger: context.logger },
        );
        if (hookResult.blocked) {
          context.logger.warn(
            `PostToolUse Hook 返回阻止状态（工具已执行）：${hookResult.reason ?? '未知原因'}`,
          );
        } else if (hookResult.output) {
          context.logger.debug(`PostToolUse Hook 输出：${hookResult.output}`);
        }
      }
    }
    const truncated = truncateForContext(result.output, context.limits.toolOutputBytes);
    let output = truncated.text;

    if (truncated.truncated) {
      const fullPath = persistToolOutput(
        context.paths.toolOutputsDir,
        context.sessionId,
        call.id,
        result.output,
      );
      output += `\n\n[输出已截断，完整内容：${fullPath}]`;
    }

    context.logger.debug(
      `tool ${call.name} ${result.isError ? 'error' : 'ok'} in ${Date.now() - startedAt}ms`,
    );
    return { call, output, isError: result.isError };
  } catch (error) {
    context.logger.debug(
      `tool ${call.name} failed in ${Date.now() - startedAt}ms: ${errorMessage(error)}`,
    );
    return { call, output: errorMessage(error), isError: true };
  }
}

function isConcurrencySafe(tool: Tool, input: unknown): boolean {
  return (
    safeBoolean(() => tool.isReadOnly(input)) && safeBoolean(() => tool.isConcurrencySafe(input))
  );
}

function safeBoolean(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

function formatValidationError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
  }
  return errorMessage(error);
}
