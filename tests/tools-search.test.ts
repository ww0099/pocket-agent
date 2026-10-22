import { describe, expect, it } from 'vitest';

import { globTool } from '../src/tools/glob.js';
import { grepTool } from '../src/tools/grep.js';
import { createTestContext, writeTestFile } from './helpers/index.js';

function seed(ctx: ReturnType<typeof createTestContext>): void {
  writeTestFile(ctx.cwd, 'src/a.ts', 'export const hello = 1;\n');
  writeTestFile(ctx.cwd, 'src/b.ts', 'export const other = 2;\n');
  writeTestFile(ctx.cwd, 'docs/c.md', 'hello world\n');
  writeTestFile(ctx.cwd, 'node_modules/pkg/index.js', 'hello from dependency\n');
}

describe('Glob', () => {
  it('按模式匹配并忽略 node_modules', async () => {
    const ctx = createTestContext();
    seed(ctx);

    const result = await globTool.call({ pattern: '**/*.ts' }, ctx);

    expect(result.output).toContain('src/a.ts');
    expect(result.output).toContain('src/b.ts');
    expect(result.output).not.toContain('node_modules');
  });

  it('无匹配时给出明确结果', async () => {
    const ctx = createTestContext();

    const result = await globTool.call({ pattern: '**/*.nope' }, ctx);
    expect(result.output).toContain('未找到');
  });
});

describe('Grep', () => {
  it('content 模式返回文件、行号与内容', async () => {
    const ctx = createTestContext();
    seed(ctx);

    const result = await grepTool.call({ pattern: 'hello' }, ctx);

    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('hello world');
    expect(result.output).not.toContain('node_modules');
  });

  it('files_with_matches 与 count 模式', async () => {
    const ctx = createTestContext();
    seed(ctx);

    const files = await grepTool.call({ pattern: 'hello', output_mode: 'files_with_matches' }, ctx);
    expect(files.output).toContain('a.ts');
    expect(files.output).toContain('c.md');

    const count = await grepTool.call({ pattern: 'hello', output_mode: 'count' }, ctx);
    expect(count.output).toContain('a.ts:1');
    expect(count.output).toContain('c.md:1');
  });

  it('支持大小写不敏感与 glob 过滤', async () => {
    const ctx = createTestContext();
    seed(ctx);

    const result = await grepTool.call(
      { pattern: 'HELLO', case_insensitive: true, glob: '**/*.ts' },
      ctx,
    );

    expect(result.output).toContain('a.ts');
    expect(result.output).not.toContain('c.md');
  });

  it('无效正则给出可行动错误', async () => {
    const ctx = createTestContext();
    seed(ctx);

    await expect(grepTool.call({ pattern: '[' }, ctx)).rejects.toThrow(/表达式无效/);
  });

  it('拒绝搜索工作区之外的目录', async () => {
    const ctx = createTestContext();

    await expect(grepTool.call({ pattern: 'x', path: '..' }, ctx)).rejects.toThrow(
      /不在允许的工作区/,
    );
  });
});
