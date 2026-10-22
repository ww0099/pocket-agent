import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { editTool } from '../src/tools/edit.js';
import { readTool } from '../src/tools/read.js';
import { todoTool } from '../src/tools/todo.js';
import { writeTool } from '../src/tools/write.js';
import { createTestContext } from './helpers/index.js';

describe('Read / Write / Edit', () => {
  it('新建文件无需先读，读取返回行号，编辑后内容正确', async () => {
    const ctx = createTestContext();

    const write = await writeTool.call({ file_path: 'a.txt', content: 'hello\nworld' }, ctx);
    expect(write.isError).toBe(false);

    const read = await readTool.call({ file_path: 'a.txt' }, ctx);
    expect(read.output).toContain('1\thello');
    expect(read.output).toContain('2\tworld');

    const edit = await editTool.call(
      { file_path: 'a.txt', old_string: 'world', new_string: 'PocketAgent' },
      ctx,
    );
    expect(edit.isError).toBe(false);
    expect(fs.readFileSync(path.join(ctx.cwd, 'a.txt'), 'utf8')).toBe('hello\nPocketAgent');
  });

  it('覆盖已存在文件前必须先 Read', async () => {
    const ctx = createTestContext();
    fs.writeFileSync(path.join(ctx.cwd, 'a.txt'), 'old', 'utf8');

    await expect(writeTool.call({ file_path: 'a.txt', content: 'new' }, ctx)).rejects.toThrow(
      /必须先 Read/,
    );
  });

  it('文件被外部修改后拒绝编辑', async () => {
    const ctx = createTestContext();
    fs.writeFileSync(path.join(ctx.cwd, 'a.txt'), 'hello', 'utf8');

    await readTool.call({ file_path: 'a.txt' }, ctx);
    fs.writeFileSync(path.join(ctx.cwd, 'a.txt'), 'changed externally', 'utf8');

    await expect(
      editTool.call({ file_path: 'a.txt', old_string: 'hello', new_string: 'hi' }, ctx),
    ).rejects.toThrow(/被修改/);
  });

  it('old_string 多处匹配时要求 replace_all', async () => {
    const ctx = createTestContext();
    fs.writeFileSync(path.join(ctx.cwd, 'a.txt'), 'a a a', 'utf8');
    await readTool.call({ file_path: 'a.txt' }, ctx);

    await expect(
      editTool.call({ file_path: 'a.txt', old_string: 'a', new_string: 'b' }, ctx),
    ).rejects.toThrow(/出现 3 次/);

    const result = await editTool.call(
      { file_path: 'a.txt', old_string: 'a', new_string: 'b', replace_all: true },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(fs.readFileSync(path.join(ctx.cwd, 'a.txt'), 'utf8')).toBe('b b b');
  });

  it('支持 offset/limit 分段读取', async () => {
    const ctx = createTestContext();
    fs.writeFileSync(path.join(ctx.cwd, 'a.txt'), '1\n2\n3\n4\n5', 'utf8');

    const result = await readTool.call({ file_path: 'a.txt', offset: 2, limit: 2 }, ctx);
    expect(result.output).toContain('2\t2');
    expect(result.output).toContain('3\t3');
    expect(result.output).not.toContain('4\t4');
    expect(result.output).toContain('还有 2 行');
  });

  it('拒绝读取二进制文件', async () => {
    const ctx = createTestContext();
    fs.writeFileSync(path.join(ctx.cwd, 'bin.dat'), Buffer.from([0, 1, 2, 3]));

    await expect(readTool.call({ file_path: 'bin.dat' }, ctx)).rejects.toThrow(/二进制/);
  });

  it('拒绝读取工作区外文件', async () => {
    const ctx = createTestContext();

    await expect(readTool.call({ file_path: path.join('..', 'outside.txt') }, ctx)).rejects.toThrow(
      /不在允许的工作区/,
    );
  });
});

describe('TodoWrite', () => {
  it('更新上下文中的待办清单', async () => {
    const ctx = createTestContext();

    const result = await todoTool.call(
      {
        todos: [
          { content: '读代码', status: 'completed' },
          { content: '改代码', status: 'in_progress' },
          { content: '跑测试', status: 'pending' },
        ],
      },
      ctx,
    );

    expect(result.output).toContain('[x] 读代码');
    expect(result.output).toContain('[~] 改代码');
    expect(ctx.todos).toHaveLength(3);
  });
});
