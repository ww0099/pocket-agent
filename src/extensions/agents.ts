import fs from 'node:fs';
import path from 'node:path';

import { arrayValue, numberValue, parseFrontmatter, stringValue } from './frontmatter.js';

export interface AgentDefinition {
  name: string;
  description: string;
  body: string;
  tools?: string[];
  model?: string;
  maxTurns?: number;
  file: string;
}

export function loadAgents(agentRoot: string, cwd: string): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();

  for (const agent of scanAgents(path.join(agentRoot, 'agents'))) {
    byName.set(agent.name, agent);
  }
  for (const agent of scanAgents(path.join(cwd, '.agent', 'agents'))) {
    byName.set(agent.name, agent);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function formatAgentIndex(agents: AgentDefinition[]): string {
  return agents
    .slice(0, 50)
    .map((agent) => `- ${agent.name} — ${agent.description}`)
    .join('\n');
}

function scanAgents(root: string): AgentDefinition[] {
  if (!fs.existsSync(root)) return [];

  const agents: AgentDefinition[] = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const file = path.join(root, entry.name);
    const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const description = stringValue(parsed.data, 'description');
    if (!description) continue;

    const name = stringValue(parsed.data, 'name') ?? entry.name.slice(0, -3);
    const agent: AgentDefinition = {
      name,
      description,
      body: parsed.body.trim(),
      file,
    };

    const tools = arrayValue(parsed.data, 'tools');
    if (tools) agent.tools = tools;

    const model = stringValue(parsed.data, 'model');
    if (model) agent.model = model;

    const maxTurns = numberValue(parsed.data, 'maxTurns', 'max_turns');
    if (maxTurns) agent.maxTurns = maxTurns;

    agents.push(agent);
  }

  return agents;
}
