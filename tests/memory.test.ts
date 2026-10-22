import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMemory, loadProjectInstructions } from '../src/memory/loader.js';
import { memoryTool } from '../src/tools/memory.js';
import { createTestContext, writeTestFile } from './helpers/index.js';

describe('memory loader', () => {
  it('加载全局与项目 MEMORY.md', () => {
    const ctx = createTestContext();
    writeTestFile(ctx.agentRoot, 'memory/MEMORY.md', '- [global](global.md)\n');
    writeTestFile(ctx.cwd, '.agent/memory/MEMORY.md', '- [project](project.md)\n');

    const memory = loadMemory(ctx.agentRoot, ctx.cwd);

    expect(memory.text).toContain('全局记忆');
    expect(memory.text).toContain('global');
    expect(memory.text).toContain('项目记忆');
    expect(memory.text).toContain('project');
  });

  it('超长索引会截断并提示', () => {
    const ctx = createTestContext();
    const lines = Array.from({ length: 260 }, (_, index) => `- [m${index}](m${index}.md)`);
    writeTestFile(ctx.agentRoot, 'memory/MEMORY.md', lines.join('\n'));

    const memory = loadMemory(ctx.agentRoot, ctx.cwd);
    expect(memory.text).toContain('记忆索引已截断');
  });

  it('向上查找最近的 AGENTS.md', () => {
    const ctx = createTestContext();
    writeTestFile(ctx.cwd, 'AGENTS.md', '# 项目规范\n使用 TypeScript。');
    const sub = path.join(ctx.cwd, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });

    const instructions = loadProjectInstructions(sub, ctx.cwd);

    expect(instructions.file).toBe(path.join(ctx.cwd, 'AGENTS.md'));
    expect(instructions.text).toContain('使用 TypeScript');
  });

  it('没有说明文件时返回空文本', () => {
    const ctx = createTestContext();
    expect(loadProjectInstructions(ctx.cwd, ctx.cwd).text).toBe('');
  });
});

describe('MemoryWrite', () => {
  it('写入项目记忆并更新索引', async () => {
    const ctx = createTestContext();

    const result = await memoryTool.call(
      {
        scope: 'project',
        name: 'test-memory',
        description: '测试记忆',
        content: '这是一个测试记忆。',
        type: 'project',
        reason: '验证写入链路',
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    const file = path.join(ctx.cwd, '.agent', 'memory', 'test-memory.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('这是一个测试记忆');

    const index = fs.readFileSync(path.join(ctx.cwd, '.agent', 'memory', 'MEMORY.md'), 'utf8');
    expect(index).toContain('](test-memory.md)');
  });

  it('写入全局记忆到 Agent 根目录', async () => {
    const ctx = createTestContext();

    await memoryTool.call(
      {
        scope: 'global',
        name: 'global-pref',
        description: '全局偏好',
        content: '用户偏好中文回复。',
        type: 'user',
        reason: '跨项目偏好',
      },
      ctx,
    );

    const file = path.join(ctx.agentRoot, 'memory', 'global-pref.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(loadMemory(ctx.agentRoot, ctx.cwd).text).toContain('global-pref');
  });

  it('拒绝非法名称', async () => {
    const ctx = createTestContext();

    await expect(
      memoryTool.call(
        {
          scope: 'project',
          name: '../escape',
          description: 'bad',
          content: 'bad',
          reason: 'bad',
        },
        ctx,
      ),
    ).rejects.toThrow();
  });
});
