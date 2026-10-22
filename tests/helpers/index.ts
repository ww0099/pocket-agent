import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureRuntimeDirs, getPaths } from '../../src/bootstrap/paths.js';
import type { ToolContext } from '../../src/tools/base.js';
import { canonicalPath } from '../../src/util/fsx.js';
import { silentLogger } from '../../src/util/log.js';
import { defaultShellKind } from '../../src/util/shell.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP_ROOT = path.join(PROJECT_ROOT, '.tmp');

/** 测试临时目录固定放在 D 盘项目内，避免写入系统临时目录（C 盘）。 */
export function makeTempDir(prefix = 'test'): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));
}

export function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

export async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of generator) {
    items.push(item);
  }
  return items;
}

export function createTestContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const root = overrides.cwd ?? makeTempDir('ctx');
  const paths = getPaths(root);
  ensureRuntimeDirs(paths);

  return {
    agentRoot: root,
    cwd: root,
    roots: [canonicalPath(root)],
    sessionId: 'test-session',
    signal: new AbortController().signal,
    logger: silentLogger,
    readFiles: new Map(),
    modifiedFiles: new Set(),
    todos: [],
    limits: {
      readMaxLines: 2000,
      globMaxResults: 500,
      grepMaxResults: 200,
      bashTimeoutMs: 120_000,
      bashMaxOutputBytes: 524_288,
      toolOutputBytes: 30_000,
    },
    shell: defaultShellKind(),
    paths,
    ...overrides,
  };
}

export function writeTestFile(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}
