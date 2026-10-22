import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { readJsoncFile } from '../../bootstrap/config.js';

const CommonSchema = z.object({
  timeoutMs: z.number().int().positive().max(300_000).default(10_000),
});

export const McpServerSchema = z.union([
  CommonSchema.extend({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
  }).strict(),
  CommonSchema.extend({
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  }).strict(),
]);

export const McpConfigSchema = z
  .object({
    mcpServers: z.record(z.string().min(1), McpServerSchema).default({}),
  })
  .strict();

export type McpServerConfig = z.infer<typeof McpServerSchema> & { name: string };

export function loadMcpConfig(agentRoot: string, cwd: string): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();

  for (const file of [
    path.join(agentRoot, 'config', 'mcp.json'),
    path.join(cwd, '.agent', 'mcp.json'),
  ]) {
    if (!fs.existsSync(file)) continue;

    const config = readJsoncFile(file, McpConfigSchema);
    for (const [name, server] of Object.entries(config.mcpServers)) {
      merged.set(name, { ...server, name } as McpServerConfig);
    }
  }

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandEnvValue(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    return process.env[name] ?? '';
  });
}
