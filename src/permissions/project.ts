import fs from 'node:fs';
import path from 'node:path';

import { ConfigError } from '../util/errors.js';
import { atomicWriteFile } from '../util/fsx.js';
import { type PermissionsConfig, PermissionsFileSchema, loadPermissionsFile } from './config.js';
import type { PermissionRequest } from './gate.js';

export const PROJECT_AGENT_DIR = '.agent';

export function projectPermissionsFile(cwd: string): string {
  return path.join(cwd, PROJECT_AGENT_DIR, 'permissions.json');
}

export function loadProjectPermissions(cwd: string): PermissionsConfig {
  const file = projectPermissionsFile(cwd);
  if (!fs.existsSync(file)) {
    return { allow: [], deny: [], additionalDirectories: [] };
  }
  return loadPermissionsFile(file);
}

export function addProjectAllowRule(cwd: string, rule: string): { file: string; added: boolean } {
  const file = projectPermissionsFile(cwd);
  const current = loadProjectPermissions(cwd);

  if (current.allow.includes(rule)) {
    return { file, added: false };
  }

  const next: PermissionsConfig = {
    ...current,
    allow: [...current.allow, rule],
  };

  const validated = PermissionsFileSchema.parse(next);
  atomicWriteFile(file, `${JSON.stringify(validated, null, 2)}\n`);
  return { file, added: true };
}

/**
 * 把一次权限请求转换为可长期复用的规则。
 * 路径类规则相对于项目根；命令类规则使用精确匹配，避免一次授权扩散到任意命令。
 */
export function buildAllowRule(request: PermissionRequest, cwd: string): string {
  if (request.tool === 'Bash') {
    const command = extractString(request.input, 'command');
    if (!command || command.includes('(') || command.includes(')')) {
      return 'Bash';
    }
    return `Bash(${command})`;
  }

  const filePath =
    extractString(request.input, 'file_path') ?? extractString(request.input, 'path');
  if (filePath) {
    if (filePath.includes('(') || filePath.includes(')')) {
      return request.tool;
    }
    const absolute = path.resolve(cwd, filePath);
    const relative = path.relative(cwd, absolute);
    const normalized = (relative.startsWith('..') ? absolute : relative).split(path.sep).join('/');
    return `${request.tool}(${normalized})`;
  }

  return request.tool;
}

function extractString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : undefined;
}
