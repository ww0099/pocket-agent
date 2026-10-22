import { z } from 'zod';

import { runAgent } from '../core/loop.js';
import { userText } from '../core/messages.js';
import { type AgentDefinition, loadAgents } from '../extensions/agents.js';
import { type Tool, ToolInputError, defineTool } from './base.js';
import { createToolExecutor } from './executor.js';
import { ToolRegistry } from './registry.js';

const TaskInputSchema = z.object({
  description: z.string().min(1).max(200),
  prompt: z.string().min(1),
  subagent_type: z.string().optional(),
});

export const taskTool: Tool = defineTool({
  name: 'Task',
  description:
    '启动一个上下文隔离的子 Agent 执行独立任务，只返回最终结论。适合代码探索、独立审查、并行子任务。子 Agent 不能再启动子 Agent。',
  inputSchema: TaskInputSchema,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async call(input, ctx) {
    const args = TaskInputSchema.parse(input);

    if (!ctx.provider || !ctx.registry || !ctx.permissionGate) {
      throw new ToolInputError('当前运行上下文不支持子 Agent');
    }
    if ((ctx.subagentDepth ?? 0) >= 1) {
      throw new ToolInputError('子 Agent 递归深度已达上限');
    }

    const agents = loadAgents(ctx.agentRoot, ctx.cwd);
    let definition: AgentDefinition | undefined;

    if (args.subagent_type) {
      definition = agents.find((agent) => agent.name === args.subagent_type);
      if (!definition) {
        const available = agents.map((agent) => agent.name).join(', ') || '（无）';
        throw new ToolInputError(`未知子 Agent：${args.subagent_type}\n可用子 Agent：${available}`);
      }
    }

    const allowlist = definition?.tools;
    const tools = ctx.registry
      .list()
      .filter((tool) => tool.name !== 'Task' && (!allowlist || allowlist.includes(tool.name)));

    if (tools.length === 0) {
      throw new ToolInputError('子 Agent 没有可用工具');
    }

    const subRegistry = new ToolRegistry(tools);
    const subContext = {
      ...ctx,
      registry: subRegistry,
      subagentDepth: (ctx.subagentDepth ?? 0) + 1,
    };
    const executor = createToolExecutor({
      registry: subRegistry,
      context: subContext,
      gate: ctx.permissionGate,
    });

    const system = [
      definition
        ? `You are the subagent "${definition.name}" working inside a larger agent: ${definition.description}`
        : 'You are a focused subagent working inside a larger agent.',
      `Working directory: ${ctx.cwd}`,
      `Available tools: ${tools.map((tool) => tool.name).join(', ')}.`,
      'Do not ask the user questions. Return a concise final report with concrete findings.',
      definition?.body ?? '',
    ]
      .filter(Boolean)
      .join('\n\n');

    let finalText = '';
    const errors: string[] = [];

    for await (const event of runAgent({
      provider: ctx.provider,
      system,
      messages: [userText(args.prompt)],
      tools: subRegistry.schemas(),
      model: definition?.model && definition.model !== 'inherit' ? definition.model : undefined,
      maxTurns: definition?.maxTurns ?? 8,
      signal: ctx.signal,
      executeTools: executor,
    })) {
      if (event.type === 'text_delta') {
        finalText += event.text;
      } else if (event.type === 'error') {
        errors.push(event.message);
      }
    }

    if (!finalText.trim()) {
      return {
        output: errors.length > 0 ? `子 Agent 失败：${errors.join('; ')}` : '子 Agent 未返回文本',
        isError: true,
      };
    }

    return {
      output: finalText.trim(),
      isError: false,
      metadata: { subagent: definition?.name ?? 'general' },
    };
  },
});
