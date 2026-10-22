import path from 'node:path';

import picomatch from 'picomatch';

import { ConfigError } from '../util/errors.js';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass';
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypass',
];
export type PermissionBehavior = 'allow' | 'deny';

export interface PermissionRule {
  raw: string;
  behavior: PermissionBehavior;
  tool: string;
  matcher?: string;
  source: string;
}

export interface RuleMatchContext {
  tool: string;
  input: unknown;
  cwd: string;
}

const RULE_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/;

export function parseRule(
  raw: string,
  behavior: PermissionBehavior,
  source = 'config',
): PermissionRule {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ConfigError('权限规则不能为空');
  }

  const match = RULE_PATTERN.exec(trimmed);
  if (!match) {
    if (trimmed.includes('(') || trimmed.includes(')')) {
      throw new ConfigError(`权限规则格式错误：${raw}`, {
        hint: '正确格式：Tool 或 Tool(模式)，例如 Bash(git status:*)',
      });
    }
    return { raw: trimmed, behavior, tool: trimmed, source };
  }

  const tool = match[1];
  const matcher = match[2]?.trim();
  if (!tool) {
    throw new ConfigError(`权限规则缺少工具名：${raw}`);
  }

  return { raw: trimmed, behavior, tool, matcher: matcher || undefined, source };
}

export function parseRules(
  rules: string[],
  behavior: PermissionBehavior,
  source = 'config',
): PermissionRule[] {
  return rules.map((rule) => parseRule(rule, behavior, source));
}

export function ruleMatches(rule: PermissionRule, context: RuleMatchContext): boolean {
  if (rule.tool !== context.tool) return false;
  if (rule.matcher === undefined) return true;

  if (rule.matcher.startsWith('domain:')) {
    const domain = rule.matcher.slice('domain:'.length).toLowerCase();
    const url = extractUrl(context.input);
    if (!url) return false;
    try {
      return new URL(url).hostname.toLowerCase() === domain;
    } catch {
      return false;
    }
  }

  if (rule.tool === 'Bash') {
    const command = extractCommand(context.input);
    return command ? matchCommand(rule.matcher, command) : false;
  }

  const filePath = extractPath(context.input);
  if (filePath) {
    return matchPath(rule.matcher, filePath, context.cwd);
  }

  return false;
}

export function matchCommand(pattern: string, command: string): boolean {
  const normalized = command.trim();

  if (pattern.endsWith(':*')) {
    return normalized.startsWith(pattern.slice(0, -2).trimEnd());
  }
  if (pattern.endsWith('*')) {
    return normalized.startsWith(pattern.slice(0, -1).trimEnd());
  }
  return normalized === pattern.trim();
}

export function matchPath(pattern: string, rawPath: string, cwd: string): boolean {
  const absolute = path.resolve(cwd, rawPath);
  const relative = path.relative(cwd, absolute).split(path.sep).join('/');
  const normalizedAbsolute = absolute.split(path.sep).join('/');

  const candidates = [relative, normalizedAbsolute];
  // 形如 **/.env 的规则也应匹配根目录下的 .env
  if (pattern.startsWith('**/')) {
    candidates.push(path.basename(relative));
  }

  const isMatch = picomatch(pattern, {
    dot: true,
    nocase: process.platform === 'win32',
  });

  return candidates.some((candidate) => isMatch(candidate));
}

function extractPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;

  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function extractCommand(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  return typeof record.command === 'string' ? record.command : undefined;
}

function extractUrl(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  return typeof record.url === 'string' ? record.url : undefined;
}
