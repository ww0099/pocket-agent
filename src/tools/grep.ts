import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { glob } from 'tinyglobby';
import { z } from 'zod';

import { detectBinary } from '../util/fsx.js';
import { type Tool, ToolInputError, defineTool } from './base.js';
import { resolveToolPath } from './path-guard.js';

const GrepInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  case_insensitive: z.boolean().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  head_limit: z.number().int().min(1).max(1000).optional(),
});

const IGNORE = ['**/node_modules/**', '**/.git/**'];
const MAX_FALLBACK_FILES = 5000;
const MAX_FALLBACK_FILE_BYTES = 1024 * 1024;

export const grepTool: Tool = defineTool({
  name: 'Grep',
  description:
    '搜索文件内容。优先使用内置 ripgrep；没有时回退到 JS 扫描。支持输出模式 content / files_with_matches / count。',
  inputSchema: GrepInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  async call(input, ctx) {
    const args = GrepInputSchema.parse(input);
    const root = args.path ? resolveToolPath(args.path, ctx) : ctx.cwd;
    const outputMode = args.output_mode ?? 'content';
    const headLimit = args.head_limit ?? 100;

    const rgPath = path.join(ctx.paths.toolsDir, 'ripgrep', 'rg.exe');
    const rg = fs.existsSync(rgPath) ? rgPath : 'rg';
    const rgResult = await tryRipgrep(rg, args, root, outputMode, headLimit, ctx.signal);

    if (rgResult.kind === 'ok') {
      return formatResult(rgResult.output, outputMode, headLimit, 'ripgrep');
    }
    if (rgResult.kind === 'invalid') {
      throw new ToolInputError(`搜索表达式无效：${rgResult.message}`);
    }

    const fallback = await fallbackSearch(args, root, outputMode, headLimit);
    return formatResult(fallback.output, outputMode, headLimit, '内置 JS 搜索（未找到 ripgrep）');
  },
});

interface RgSuccess {
  kind: 'ok';
  output: string[];
}

interface RgFailure {
  kind: 'missing' | 'invalid';
  message: string;
}

async function tryRipgrep(
  executable: string,
  args: z.infer<typeof GrepInputSchema>,
  root: string,
  outputMode: 'content' | 'files_with_matches' | 'count',
  headLimit: number,
  signal: AbortSignal,
): Promise<RgSuccess | RgFailure> {
  const cliArgs = [
    '--color',
    'never',
    '--no-heading',
    '--with-filename',
    '--line-number',
    '--glob',
    '!node_modules/**',
    '--glob',
    '!.git/**',
  ];

  if (args.case_insensitive) cliArgs.push('-i');
  if (args.glob) cliArgs.push('--glob', args.glob);
  if (outputMode === 'files_with_matches') cliArgs.push('-l');
  if (outputMode === 'count') cliArgs.push('-c');
  cliArgs.push('-e', args.pattern, root);

  return new Promise((resolve) => {
    const child = spawn(executable, cliArgs, {
      cwd: root,
      windowsHide: true,
      signal,
    });

    let stdout = '';
    let stderr = '';
    let spawnError: NodeJS.ErrnoException | undefined;

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.on('close', (code) => {
      if (spawnError?.code === 'ENOENT') {
        resolve({ kind: 'missing', message: 'ripgrep 未安装' });
        return;
      }
      if (spawnError) {
        resolve({ kind: 'missing', message: spawnError.message });
        return;
      }
      if (code === 1) {
        resolve({ kind: 'ok', output: [] });
        return;
      }
      if (code !== 0) {
        resolve({ kind: 'invalid', message: stderr.trim() || `ripgrep 退出码 ${code}` });
        return;
      }

      const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, headLimit);
      resolve({ kind: 'ok', output: lines });
    });
  });
}

interface FallbackResult {
  output: string[];
}

async function fallbackSearch(
  args: z.infer<typeof GrepInputSchema>,
  root: string,
  outputMode: 'content' | 'files_with_matches' | 'count',
  headLimit: number,
): Promise<FallbackResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern, args.case_insensitive ? 'i' : '');
  } catch (error) {
    throw new ToolInputError(
      `搜索表达式无效：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const files = await glob({
    patterns: args.glob ?? '**/*',
    cwd: root,
    ignore: IGNORE,
    dot: true,
    onlyFiles: true,
    absolute: false,
  });

  files.sort((a, b) => a.localeCompare(b));

  const output: string[] = [];
  let scanned = 0;

  for (const relative of files.slice(0, MAX_FALLBACK_FILES)) {
    const absolute = path.join(root, relative);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_FALLBACK_FILE_BYTES) continue;

    const buffer = fs.readFileSync(absolute);
    if (detectBinary(buffer)) continue;

    scanned += 1;
    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);

    if (outputMode === 'files_with_matches') {
      if (lines.some((line) => regex.test(line))) {
        output.push(relative);
        if (output.length >= headLimit) break;
      }
      continue;
    }

    if (outputMode === 'count') {
      const count = lines.reduce((sum, line) => sum + (regex.test(line) ? 1 : 0), 0);
      if (count > 0) output.push(`${relative}:${count}`);
      if (output.length >= headLimit) break;
      continue;
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line !== undefined && regex.test(line)) {
        output.push(`${relative}:${index + 1}:${line}`);
        if (output.length >= headLimit) break;
      }
    }
    if (output.length >= headLimit) break;
  }

  if (files.length > MAX_FALLBACK_FILES) {
    output.push(
      `[已扫描前 ${MAX_FALLBACK_FILES} 个文件（共 ${files.length} 个），可缩小 path 或 glob 范围]`,
    );
  } else if (scanned === 0) {
    output.push('[没有可扫描的文本文件]');
  }

  return { output };
}

function formatResult(
  lines: string[],
  outputMode: 'content' | 'files_with_matches' | 'count',
  headLimit: number,
  engine: string,
): { output: string; isError: boolean; metadata: Record<string, unknown> } {
  if (lines.length === 0) {
    return {
      output: `未找到匹配内容（引擎：${engine}）`,
      isError: false,
      metadata: { engine, matches: 0 },
    };
  }

  const shown = lines.slice(0, headLimit);
  const footer = lines.length > shown.length ? `\n\n[结果已按 head_limit=${headLimit} 截断]` : '';

  return {
    output: `引擎：${engine}\n模式：${outputMode}\n结果：\n${shown.join('\n')}${footer}`,
    isError: false,
    metadata: { engine, matches: lines.length },
  };
}
