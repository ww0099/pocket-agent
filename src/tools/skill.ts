import { z } from 'zod';

import { loadSkills } from '../extensions/skills.js';
import { type Tool, ToolInputError, defineTool } from './base.js';

const SkillInputSchema = z.object({
  name: z.string().min(1),
});

export const skillTool: Tool = defineTool({
  name: 'Skill',
  description: '按名称加载技能正文。系统提示中只包含技能摘要；需要具体步骤时调用本工具。',
  inputSchema: SkillInputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  async call(input, ctx) {
    const args = SkillInputSchema.parse(input);
    const skills = loadSkills(ctx.agentRoot, ctx.cwd);
    const skill = skills.find((candidate) => candidate.name === args.name);

    if (!skill) {
      const available = skills.map((candidate) => candidate.name).join(', ') || '（无）';
      throw new ToolInputError(`未知技能：${args.name}\n可用技能：${available}`);
    }

    return {
      output: [
        `技能：${skill.name}`,
        `文件：${skill.file}`,
        `目录：${skill.dir}`,
        '',
        skill.body,
      ].join('\n'),
      isError: false,
      metadata: { skill: skill.name, dir: skill.dir },
    };
  },
});
