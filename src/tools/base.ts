import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { AgentPaths } from '../bootstrap/paths.js';
import type { HookConfig } from '../extensions/hooks.js';
import type { PermissionGate } from '../permissions/gate.js';
import type { Provider, ToolSchema } from '../providers/types.js';
import type { Logger } from '../util/log.js';
import type { ShellKind } from '../util/shell.js';
import type { ToolRegistry } from './registry.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export interface ReadFileRecord {
  mtimeMs: number;
  size: number;
  sha256: string;
  readAt: number;
}

export type ReadFileState = Map<string, ReadFileRecord>;

export interface ToolLimits {
  readMaxLines: number;
  globMaxResults: number;
  grepMaxResults: number;
  bashTimeoutMs: number;
  bashMaxOutputBytes: number;
  toolOutputBytes: number;
}

export interface ToolContext {
  agentRoot: string;
  cwd: string;
  /** 已规范化的允许根目录（含 additionalDirectories）。 */
  roots: string[];
  sessionId: string;
  signal: AbortSignal;
  logger: Logger;
  readFiles: ReadFileState;
  modifiedFiles: Set<string>;
  todos: TodoItem[];
  limits: ToolLimits;
  shell: ShellKind;
  paths: AgentPaths;
  /** 以下字段用于 Task / MCP / Hooks 等扩展能力。 */
  provider?: Provider;
  registry?: ToolRegistry;
  permissionGate?: PermissionGate;
  subagentDepth?: number;
  hooks?: HookConfig;
}

export interface ToolResult {
  output: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
}

export class ToolInputError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ToolInputError';
  }
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  /** MCP 等外部工具可直接提供 JSON Schema，避免从 Zod 反向转换。 */
  jsonSchema?: Record<string, unknown>;
  isReadOnly(input: unknown): boolean;
  isConcurrencySafe(input: unknown): boolean;
  isDestructive(input: unknown): boolean;
  call(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool(tool: Tool): Tool {
  return tool;
}

export function toToolSchema(tool: Tool): ToolSchema {
  if (tool.jsonSchema) {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.jsonSchema,
    };
  }

  const schema = zodToJsonSchema(tool.inputSchema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  const jsonSchema = Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== '$schema'),
  );

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: jsonSchema,
  };
}
