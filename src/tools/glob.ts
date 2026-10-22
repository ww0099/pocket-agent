import fs from 'node:fs';
import path from 'node:path';

import { glob } from 'tinyglobby';
import { z } from 'zod';

import { type Tool, ToolInputError, defineTool } from './base.js';
import { resolveToolPath } from './path-guard.js';

const GlobInputSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});

const IGNORE = ['**/node_modules/**', '**/.git/**'];

export const globTool: Tool = defineTool({
  name: 'Glob',
  description:
    '按 glob 模式查找文件（相对模式，如 **/*.ts）。默认忽略 node_modules 与 .git。返回相对路径列表。',
  inputSchema: GlobInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  async call(input, ctx) {
    const args = GlobInputSchema.parse(input);

    if (path.isAbsolute(args.pattern)) {
      throw new ToolInputError('pattern 必须是相对模式；请用 path 参数指定搜索目录');
    }

    const root = args.path ? resolveToolPath(args.path, ctx) : ctx.cwd;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      throw new ToolInputError(`搜索目录不存在：${args.path ?? root}`);
    }
    if (!stat.isDirectory()) {
      throw new ToolInputError(`不是目录：${args.path ?? root}`);
    }

    const matches = await glob({
      patterns: args.pattern,
      cwd: root,
      ignore: IGNORE,
      dot: true,
      onlyFiles: true,
      absolute: false,
    });

    matches.sort((a, b) => a.localeCompare(b));
    const limit = args.limit ?? ctx.limits.globMaxResults;
    const shown = matches.slice(0, limit);

    if (shown.length === 0) {
      return { output: `未找到匹配 ${args.pattern} 的文件`, isError: false };
    }

    const relativeRoot = path.relative(ctx.cwd, root) || '.';
    const footer =
      matches.length > shown.length
        ? `\n\n[共 ${matches.length} 个匹配，仅显示前 ${shown.length} 个]`
        : '';

    return {
      output: `搜索目录：${relativeRoot}\n匹配 ${matches.length} 个文件：\n${shown.join('\n')}${footer}`,
      isError: false,
      metadata: { total: matches.length, shown: shown.length },
    };
  },
});
