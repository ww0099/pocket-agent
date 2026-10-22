import fs from 'node:fs';

import { z } from 'zod';

import { detectBinary, formatBytes, sha256, stripBom } from '../util/fsx.js';
import { type Tool, ToolInputError, defineTool } from './base.js';
import { resolveToolPath } from './path-guard.js';

const ReadInputSchema = z.object({
  file_path: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const readTool: Tool = defineTool({
  name: 'Read',
  description:
    '读取文本文件并返回带行号的内容。默认最多 2000 行；可用 offset/limit 分段读取。修改文件前必须先 Read 该文件。',
  inputSchema: ReadInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  async call(input, ctx) {
    const args = ReadInputSchema.parse(input);
    const file = resolveToolPath(args.file_path, ctx);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new ToolInputError(`文件不存在：${args.file_path}`);
    }
    if (!stat.isFile()) {
      throw new ToolInputError(`不是普通文件：${args.file_path}`);
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new ToolInputError(`文件过大（${formatBytes(stat.size)}），请使用 Grep 定位或分段读取`);
    }

    const buffer = fs.readFileSync(file);
    if (detectBinary(buffer)) {
      throw new ToolInputError(`检测到二进制文件，拒绝读入上下文：${args.file_path}`);
    }

    const text = stripBom(buffer.toString('utf8'));
    const lines = text.split(/\r?\n/);
    const offset = args.offset ?? 1;
    const limit = args.limit ?? Math.min(ctx.limits.readMaxLines, 2000);

    if (lines.length > 0 && offset > lines.length) {
      throw new ToolInputError(`offset ${offset} 超出文件总行数 ${lines.length}`);
    }

    const startIndex = offset - 1;
    const endIndex = Math.min(startIndex + limit, lines.length);
    const slice = lines.slice(startIndex, endIndex);
    const numbered = slice.map((line, index) => `${startIndex + index + 1}\t${line}`).join('\n');

    const remaining = lines.length - endIndex;
    const footer =
      remaining > 0 ? `\n\n[还有 ${remaining} 行未显示，使用 offset=${endIndex + 1} 继续读取]` : '';

    ctx.readFiles.set(file, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: sha256(text),
      readAt: Date.now(),
    });

    return {
      output: `${file}\n行 ${offset}-${endIndex} / 共 ${lines.length} 行\n\n${numbered}${footer}`,
      isError: false,
      metadata: { lines: lines.length, bytes: stat.size },
    };
  },
});
