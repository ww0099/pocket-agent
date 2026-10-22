import { describe, expect, it } from 'vitest';

import { expandCommand, loadCommands } from '../src/extensions/commands.js';
import { loadSkills } from '../src/extensions/skills.js';
import { skillTool } from '../src/tools/skill.js';
import { createTestContext, writeTestFile } from './helpers/index.js';

describe('skills', () => {
  it('加载全局技能并允许项目覆盖', async () => {
    const ctx = createTestContext();
    writeTestFile(
      ctx.agentRoot,
      'skills/review/SKILL.md',
      '---\nname: review\ndescription: 全局审查\n---\n全局正文',
    );
    writeTestFile(
      ctx.cwd,
      '.agent/skills/review/SKILL.md',
      '---\nname: review\ndescription: 项目审查\nwhen_to_use: 审查代码时\n---\n项目正文',
    );
    writeTestFile(
      ctx.agentRoot,
      'skills/explore/SKILL.md',
      '---\nname: explore\ndescription: 探索代码\n---\n探索正文',
    );

    const skills = loadSkills(ctx.agentRoot, ctx.cwd);
    const review = skills.find((skill) => skill.name === 'review');

    expect(skills).toHaveLength(2);
    expect(review?.description).toBe('项目审查');
    expect(review?.whenToUse).toBe('审查代码时');
    expect(review?.body).toBe('项目正文');

    const result = await skillTool.call({ name: 'review' }, ctx);
    expect(result.output).toContain('项目正文');
    expect(result.output).toContain(ctx.cwd);
  });

  it('未知技能给出可用列表', async () => {
    const ctx = createTestContext();
    writeTestFile(
      ctx.agentRoot,
      'skills/explore/SKILL.md',
      '---\nname: explore\ndescription: 探索\n---\n正文',
    );

    await expect(skillTool.call({ name: 'nope' }, ctx)).rejects.toThrow(/explore/);
  });
});

describe('custom commands', () => {
  it('加载命令并支持位置参数、全量参数与 $ARGUMENTS', () => {
    const ctx = createTestContext();
    writeTestFile(
      ctx.agentRoot,
      'commands/review.md',
      '---\ndescription: 审查分支\n---\n审查 ${1} 到 ${2}；全部参数：${@}；原文：$ARGUMENTS',
    );

    const commands = loadCommands(ctx.agentRoot, ctx.cwd);
    const command = commands.find((candidate) => candidate.name === 'review');

    expect(command?.description).toBe('审查分支');
    if (!command) throw new Error('review 命令未加载');
    expect(expandCommand(command, 'main dev extra')).toBe(
      '审查 main 到 dev；全部参数：main dev extra；原文：main dev extra',
    );
  });

  it('项目命令覆盖同名全局命令', () => {
    const ctx = createTestContext();
    writeTestFile(ctx.agentRoot, 'commands/deploy.md', '---\ndescription: 全局\n---\n全局部署');
    writeTestFile(ctx.cwd, '.agent/commands/deploy.md', '---\ndescription: 项目\n---\n项目部署');

    const commands = loadCommands(ctx.agentRoot, ctx.cwd);
    expect(commands.find((command) => command.name === 'deploy')?.body).toBe('项目部署');
  });
});
