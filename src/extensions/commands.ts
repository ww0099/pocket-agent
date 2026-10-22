import fs from 'node:fs';
import path from 'node:path';

import { parseFrontmatter, stringValue } from './frontmatter.js';

export interface CommandDefinition {
  name: string;
  description?: string;
  argumentHint?: string;
  body: string;
  file: string;
}

export function loadCommands(agentRoot: string, cwd: string): CommandDefinition[] {
  const byName = new Map<string, CommandDefinition>();

  for (const command of scanCommands(path.join(agentRoot, 'commands'))) {
    byName.set(command.name, command);
  }
  for (const command of scanCommands(path.join(cwd, '.agent', 'commands'))) {
    byName.set(command.name, command);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCommand(command: CommandDefinition, args: string): string {
  const positional = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
  let body = command.body;

  for (let index = 1; index <= 9; index += 1) {
    body = body.replaceAll(`\${${index}}`, positional[index - 1] ?? '');
  }

  body = body.replaceAll('${@}', args.trim());
  body = body.replaceAll('$ARGUMENTS', args.trim());
  body = body.replace(/\$\{ARGUMENTS\}/g, args.trim());

  return body.trim();
}

export function formatCommandIndex(commands: CommandDefinition[]): string {
  return commands
    .slice(0, 50)
    .map((command) => {
      const description = command.description ? ` — ${command.description}` : '';
      return `- /${command.name}${description}`;
    })
    .join('\n');
}

function scanCommands(root: string): CommandDefinition[] {
  if (!fs.existsSync(root)) return [];

  const commands: CommandDefinition[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const file = path.join(root, entry.name);
    const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const name = stringValue(parsed.data, 'name') ?? entry.name.slice(0, -3);

    const command: CommandDefinition = {
      name,
      body: parsed.body.trim(),
      file,
    };

    const description = stringValue(parsed.data, 'description');
    if (description) command.description = description;

    const argumentHint = stringValue(parsed.data, 'argument_hint', 'argumentHint');
    if (argumentHint) command.argumentHint = argumentHint;

    if (command.body) commands.push(command);
  }

  return commands;
}
