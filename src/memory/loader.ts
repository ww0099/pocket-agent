import fs from 'node:fs';
import path from 'node:path';

import { formatBytes, stripBom } from '../util/fsx.js';

const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;
const MAX_INSTRUCTION_BYTES = 20_000;

export interface LoadedMemory {
  text: string;
  globalFile?: string;
  projectFile?: string;
}

export interface LoadedInstructions {
  text: string;
  file?: string;
}

export function loadMemory(agentRoot: string, cwd: string): LoadedMemory {
  const globalFile = path.join(agentRoot, 'memory', 'MEMORY.md');
  const projectFile = path.join(cwd, '.agent', 'memory', 'MEMORY.md');
  const sections: string[] = [];

  const globalContent = readIndex(globalFile);
  if (globalContent) {
    sections.push(`## 全局记忆（${globalFile}）\n${globalContent}`);
  }

  const projectContent = readIndex(projectFile);
  if (projectContent) {
    sections.push(`## 项目记忆（${projectFile}）\n${projectContent}`);
  }

  return {
    text: sections.join('\n\n'),
    globalFile: globalContent ? globalFile : undefined,
    projectFile: projectContent ? projectFile : undefined,
  };
}

/**
 * 从 cwd 向上查找最近的 AGENTS.md；没有则回退 CLAUDE.md。
 * stopDir 可选，用于测试或显式限定搜索边界。
 */
export function loadProjectInstructions(cwd: string, stopDir?: string): LoadedInstructions {
  const stop = stopDir ? path.resolve(stopDir) : undefined;
  let current = path.resolve(cwd);

  for (let depth = 0; depth < 8; depth += 1) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = path.join(current, name);
      if (!fs.existsSync(file)) continue;

      const content = readText(file);
      if (!content.trim()) continue;

      return {
        file,
        text: `## 项目说明（${file}）\n${truncateByBytes(content, MAX_INSTRUCTION_BYTES)}`,
      };
    }

    if (stop && current === stop) break;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { text: '' };
}

function readIndex(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;

  const content = readText(file);
  if (!content.trim()) return undefined;

  const truncated = truncateIndex(content);
  return truncated;
}

function truncateIndex(content: string): string {
  const lines = content.trim().split(/\r?\n/);
  let result =
    lines.length > MAX_INDEX_LINES ? lines.slice(0, MAX_INDEX_LINES).join('\n') : content.trim();

  if (Buffer.byteLength(result, 'utf8') > MAX_INDEX_BYTES) {
    result = truncateByBytes(result, MAX_INDEX_BYTES);
  }

  if (result !== content.trim()) {
    result += `\n\n[记忆索引已截断（原 ${formatBytes(Buffer.byteLength(content))}），请整理 MEMORY.md]`;
  }

  return result;
}

function truncateByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  let result = text.slice(0, maxBytes);
  while (Buffer.byteLength(result, 'utf8') > maxBytes && result.length > 0) {
    result = result.slice(0, -1);
  }
  return `${result}\n\n[内容已截断]`;
}

function readText(file: string): string {
  return stripBom(fs.readFileSync(file, 'utf8'));
}
