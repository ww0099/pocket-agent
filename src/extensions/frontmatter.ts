import { stripBom } from '../util/fsx.js';

export interface ParsedMarkdown {
  data: Record<string, unknown>;
  body: string;
}

/** 解析 YAML frontmatter；格式不合法时把全文当作正文。 */
export function parseFrontmatter(raw: string): ParsedMarkdown {
  const text = stripBom(raw);

  if (!text.startsWith('---')) {
    return { data: {}, body: text };
  }

  const lines = text.split(/\r?\n/);
  let closing = -1;

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') {
      closing = index;
      break;
    }
  }

  if (closing === -1) {
    return { data: {}, body: text };
  }

  const frontmatter = lines.slice(1, closing).join('\n');
  const body = lines.slice(closing + 1).join('\n');

  return { data: parseSimpleYaml(frontmatter), body };
}

/**
 * 只支持 frontmatter 常用子集：
 * key: value、key: [a, b]、key:\n  - a、布尔与整数。
 * 不引入完整 YAML 解析器，避免 CJS 依赖与打包问题。
 */
export function parseSimpleYaml(source: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    const raw = (match[2] ?? '').trim();
    if (!key) continue;

    if (!raw) {
      const items: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? '';
        const itemMatch = /^\s*-\s+(.*)$/.exec(next);
        if (!itemMatch) break;
        const item = unquote((itemMatch[1] ?? '').trim());
        if (item) items.push(item);
        index += 1;
      }
      result[key] = items;
      continue;
    }

    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim();
      result[key] =
        inner.length === 0
          ? []
          : inner
              .split(',')
              .map((item) => unquote(item.trim()))
              .filter(Boolean);
      continue;
    }

    if (raw === 'true' || raw === 'false') {
      result[key] = raw === 'true';
      continue;
    }

    if (/^-?\d+$/.test(raw)) {
      result[key] = Number.parseInt(raw, 10);
      continue;
    }

    result[key] = unquote(raw);
  }

  return result;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function stringValue(data: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function arrayValue(data: Record<string, unknown>, ...keys: string[]): string[] | undefined {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === 'string');
      if (items.length > 0) return items;
    }
    if (typeof value === 'string' && value.trim()) {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }
  return undefined;
}

export function numberValue(data: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}
