import fs from 'node:fs';
import path from 'node:path';

import { parseFrontmatter, stringValue } from './frontmatter.js';

export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  dir: string;
  file: string;
  body: string;
}

export function loadSkills(agentRoot: string, cwd: string): SkillDefinition[] {
  const byName = new Map<string, SkillDefinition>();

  for (const skill of scanSkills(path.join(agentRoot, 'skills'))) {
    byName.set(skill.name, skill);
  }
  for (const skill of scanSkills(path.join(cwd, '.agent', 'skills'))) {
    byName.set(skill.name, skill);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function formatSkillIndex(skills: SkillDefinition[]): string {
  if (skills.length === 0) return '';

  return skills
    .slice(0, 50)
    .map((skill) => {
      const when = skill.whenToUse ? `（适用：${skill.whenToUse}）` : '';
      return `- ${skill.name} — ${skill.description}${when}`;
    })
    .join('\n');
}

function scanSkills(root: string): SkillDefinition[] {
  if (!fs.existsSync(root)) return [];

  const skills: SkillDefinition[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const dir = path.join(root, entry.name);
    const file = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(file)) continue;

    const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const description = stringValue(parsed.data, 'description');
    if (!description) continue;

    const name = stringValue(parsed.data, 'name') ?? entry.name;
    const whenToUse = stringValue(parsed.data, 'when_to_use', 'whenToUse');

    const skill: SkillDefinition = {
      name,
      description,
      dir,
      file,
      body: parsed.body.trim(),
    };
    if (whenToUse) skill.whenToUse = whenToUse;
    skills.push(skill);
  }

  return skills;
}
