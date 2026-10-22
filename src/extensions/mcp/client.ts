import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import type { Tool } from '../../tools/base.js';
import { errorMessage } from '../../util/errors.js';
import type { Logger } from '../../util/log.js';
import { VERSION } from '../../version.js';
import { type McpServerConfig, expandEnvValue } from './config.js';

export interface McpAnnotationHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpAnnotationHints;
}

export interface McpContentItem {
  type?: string;
  text?: string;
  uri?: string;
  [key: string]: unknown;
}

export interface McpCallResult {
  content?: McpContentItem[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface McpClientLike {
  listTools(
    params?: Record<string, never>,
    options?: { timeout?: number },
  ): Promise<{ tools: McpToolInfo[] }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpConnection {
  name: string;
  client: McpClientLike;
}

export interface ConnectMcpResult {
  tools: Tool[];
  connections: McpConnection[];
}

export async function connectMcpServers(
  configs: McpServerConfig[],
  logger: Logger,
): Promise<ConnectMcpResult> {
  const tools: Tool[] = [];
  const connections: McpConnection[] = [];
  const usedNames = new Set<string>();

  const results = await Promise.all(
    configs.map(async (config) => {
      try {
        const client = await connectOne(config, logger);
        const listed = await client.listTools(undefined, { timeout: config.timeoutMs });
        return { config, client, tools: listed.tools };
      } catch (error) {
        logger.warn(`MCP Server "${config.name}" 连接失败：${errorMessage(error)}`);
        return undefined;
      }
    }),
  );

  for (const result of results) {
    if (!result) continue;

    connections.push({ name: result.config.name, client: result.client });

    for (const info of result.tools) {
      const tool = wrapMcpTool(result.config, result.client, info, usedNames);
      usedNames.add(tool.name);
      tools.push(tool);
    }
  }

  return { tools, connections };
}

async function connectOne(config: McpServerConfig, logger: Logger): Promise<McpClientLike> {
  const client = new Client({ name: 'pocket-agent', version: VERSION }, { capabilities: {} });

  const transport =
    'url' in config
      ? new StreamableHTTPClientTransport(new URL(expandEnvValue(config.url)), {
          requestInit: {
            headers: Object.fromEntries(
              Object.entries(config.headers ?? {}).map(([key, value]) => [
                key,
                expandEnvValue(value),
              ]),
            ),
          },
        })
      : new StdioClientTransport({
          command: expandEnvValue(config.command),
          args: config.args.map(expandEnvValue),
          env: buildEnv(config.env),
          cwd: config.cwd ? expandEnvValue(config.cwd) : undefined,
          stderr: 'pipe',
        });

  try {
    await withTimeout(
      client.connect(transport),
      config.timeoutMs,
      `MCP Server "${config.name}" 连接超时`,
    );
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }

  logger.debug(`MCP Server "${config.name}" 已连接`);
  return client as unknown as McpClientLike;
}

export function wrapMcpTool(
  config: McpServerConfig,
  client: McpClientLike,
  info: McpToolInfo,
  usedNames: Set<string>,
): Tool {
  let fullName = `mcp__${sanitize(config.name)}__${sanitize(info.name)}`;
  if (usedNames.has(fullName)) {
    fullName = `${fullName}_${usedNames.size}`;
  }

  return {
    name: fullName,
    description: `[MCP ${config.name}] ${info.description ?? info.name}`,
    inputSchema: z.record(z.unknown()),
    jsonSchema: normaliseJsonSchema(info.inputSchema),
    isReadOnly: () => info.annotations?.readOnlyHint === true,
    isConcurrencySafe: () => info.annotations?.readOnlyHint === true,
    isDestructive: () => info.annotations?.destructiveHint === true,
    async call(input) {
      const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

      const result = await client.callTool({ name: info.name, arguments: args }, undefined, {
        timeout: config.timeoutMs,
      });

      return {
        output: formatMcpResult(result),
        isError: result.isError === true,
      };
    },
  };
}

function formatMcpResult(result: McpCallResult): string {
  const parts: string[] = [];

  for (const item of result.content ?? []) {
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    } else if (item.type === 'image') {
      parts.push('[MCP 图片内容已省略]');
    } else if (item.type === 'resource') {
      parts.push(`[MCP 资源：${String(item.uri ?? 'unknown')}]`);
    } else if (item.type === 'resource_link') {
      parts.push(`[MCP 资源链接：${String(item.uri ?? 'unknown')}]`);
    } else {
      parts.push(JSON.stringify(item));
    }
  }

  if (result.structuredContent !== undefined) {
    parts.push(`结构化结果：\n${JSON.stringify(result.structuredContent, null, 2)}`);
  }

  return parts.join('\n') || '(MCP 工具无输出)';
}

function normaliseJsonSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema as Record<string, unknown>;
  }
  return { type: 'object', properties: {} };
}

function sanitize(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  return cleaned.length > 0 ? cleaned : 'unnamed';
}

function buildEnv(overrides: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    env[key] = expandEnvValue(value);
  }

  return env;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
