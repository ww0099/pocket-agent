import fs from 'node:fs';

import { z } from 'zod';

import { atomicWriteFile, detectBinary, sha256, stripBom } from '../util/fsx.js';
import { type Tool, ToolInputError, defineTool } from './base.js';
import { resolveToolPath } from './path-guard.js';

const EditInputSchema = z.object({
  file_path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

export const editTool: Tool = defineTool({
  name: 'Edit',
  description:
    '精确字符串替换。默认要求 old_string 在文件中唯一；需要替换多处时设置 replace_all=true。必须先 Read 文件，且文件被外部修改后会拒绝执行。',
  inputSchema: EditInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,
  async call(input, ctx) {
    const args = EditInputSchema.parse(input);
    const file = resolveToolPath(args.file_path, ctx, { write: true });

    const state = ctx.readFiles.get(file);
    if (!state) {
      throw new ToolInputError(`编辑前必须先 Read 文件：${args.file_path}`);
    }
    if (!fs.existsSync(file)) {
      throw new ToolInputError(`文件已不存在：${args.file_path}`);
    }

    const buffer = fs.readFileSync(file);
    if (detectBinary(buffer)) {
      throw new ToolInputError('目标是二进制文件，无法执行文本替换');
    }

    const hadBom =
      buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    const original = stripBom(buffer.toString('utf8'));

    if (sha256(original) !== state.sha256) {
      throw new ToolInputError('文件在读取后被修改（内容哈希不一致），请重新 Read 后再编辑');
    }

    if (args.old_string === args.new_string) {
      throw new ToolInputError('old_string 与 new_string 相同，无需修改');
    }

    const firstIndex = original.indexOf(args.old_string);
    if (firstIndex === -1) {
      throw new ToolInputError('未找到 old_string。请确认内容与文件完全一致（含空格与缩进）');
    }

    const occurrences = countOccurrences(original, args.old_string);
    if (occurrences > 1 && !args.replace_all) {
      throw new ToolInputError(
        `old_string 在文件中出现 ${occurrences} 次，请提供更长的上下文或设置 replace_all=true`,
      );
    }

    const updated = args.replace_all
      ? original.split(args.old_string).join(args.new_string)
      : original.replace(args.old_string, args.new_string);

    const output = hadBom ? `﻿${updated}` : updated;
    atomicWriteFile(file, output);

    const stat = fs.statSync(file);
    ctx.readFiles.set(file, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: sha256(updated),
      readAt: Date.now(),
    });
    ctx.modifiedFiles.add(file);

    const line = original.slice(0, firstIndex).split('\n').length;
    return {
      output: `已编辑 ${file}\n替换 ${args.replace_all ? occurrences : 1} 处，首个匹配在第 ${line} 行`,
      isError: false,
      metadata: { occurrences, line },
    };
  },
});

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;

  while (true) {
    const found = text.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + needle.length;
  }

  return count;
}
