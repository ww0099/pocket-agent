import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { atomicWriteFile } from '../util/fsx.js';
import { type Tool, defineTool } from './base.js';

const MemoryInputSchema = z.object({
  scope: z.enum(['project', 'global']),
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'name 只能包含小写字母、数字与连字符'),
  description: z.string().min(1).max(200),
  content: z.string().min(1).max(20_000),
  type: z.enum(['user', 'feedback', 'project', 'reference']).default('project'),
  reason: z.string().min(1).max(500),
});

const INDEX_HEADER = `# 记忆索引

<!-- 每条记忆一行，由 MemoryWrite 自动维护 -->
`;

export const memoryTool: Tool = defineTool({
  name: 'MemoryWrite',
  description:
    '保存值得长期保留的用户偏好或项目约束。scope=project 写入 <project>/.agent/memory；scope=global 写入 Agent 根目录 memory/。必须说明 reason，便于追溯。',
  inputSchema: MemoryInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async call(input, ctx) {
    const args = MemoryInputSchema.parse(input);
    const dir =
      args.scope === 'project'
        ? path.join(ctx.cwd, '.agent', 'memory')
        : path.join(ctx.agentRoot, 'memory');
    fs.mkdirSync(dir, { recursive: true });

    const file = path.join(dir, `${args.name}.md`);
    const indexFile = path.join(dir, 'MEMORY.md');
    const today = new Date().toISOString().slice(0, 10);

    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8');
      atomicWriteFile(
        file,
        `${existing.trimEnd()}\n\n---\n\n## 更新 ${today}\n\n${args.content.trim()}\n`,
      );
    } else {
      const frontmatter = [
        '---',
        `name: ${args.name}`,
        `description: ${singleLine(args.description)}`,
        `type: ${args.type}`,
        `created: ${today}`,
        '---',
        '',
        args.content.trim(),
        '',
      ].join('\n');
      atomicWriteFile(file, frontmatter);
    }

    const index = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : INDEX_HEADER;
    const link = `](${args.name}.md)`;

    if (!index.includes(link)) {
      const line = `- [${singleLine(args.description)}](${args.name}.md)`;
      atomicWriteFile(indexFile, `${index.trimEnd()}\n${line}\n`);
    }

    return {
      output: `已写入${args.scope === 'project' ? '项目' : '全局'}记忆：${file}\n索引：${indexFile}\n原因：${args.reason}`,
      isError: false,
      metadata: { file, indexFile, scope: args.scope },
    };
  },
});

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim();
}
