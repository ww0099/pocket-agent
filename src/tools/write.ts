import fs from 'node:fs';

import { z } from 'zod';

import { atomicWriteFile, detectBinary, formatBytes, sha256, stripBom } from '../util/fsx.js';
import { type Tool, ToolInputError, defineTool } from './base.js';
import { resolveToolPath } from './path-guard.js';

const WriteInputSchema = z.object({
  file_path: z.string().min(1),
  content: z.string(),
});

export const writeTool: Tool = defineTool({
  name: 'Write',
  description:
    '写入文件（覆盖）。若目标文件已存在，必须先 Read 该文件；文件在读取后被外部修改时会拒绝写入。父目录会自动创建。',
  inputSchema: WriteInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,
  async call(input, ctx) {
    const args = WriteInputSchema.parse(input);
    const file = resolveToolPath(args.file_path, ctx, { write: true });
    const existed = fs.existsSync(file);

    if (existed) {
      const state = ctx.readFiles.get(file);
      if (!state) {
        throw new ToolInputError(`目标文件已存在，写入前必须先 Read：${args.file_path}`);
      }

      const buffer = fs.readFileSync(file);
      if (detectBinary(buffer)) {
        throw new ToolInputError('目标是二进制文件，拒绝用文本覆盖；请用 Bash 明确处理');
      }

      const current = stripBom(buffer.toString('utf8'));
      if (sha256(current) !== state.sha256) {
        throw new ToolInputError('文件在读取后被修改（内容哈希不一致），请重新 Read 后再写入');
      }
    }

    atomicWriteFile(file, args.content);

    const stat = fs.statSync(file);
    ctx.readFiles.set(file, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: sha256(args.content),
      readAt: Date.now(),
    });
    ctx.modifiedFiles.add(file);

    const bytes = Buffer.byteLength(args.content, 'utf8');
    return {
      output: `已写入 ${file}\n${formatBytes(bytes)}，${args.content.split('\n').length} 行`,
      isError: false,
      metadata: { bytes, created: !existed },
    };
  },
});
