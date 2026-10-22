import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../src/core/events.js';
import { PermissionGate } from '../src/permissions/gate.js';
import type { Provider, ProviderCapabilities, StreamRequest } from '../src/providers/types.js';
import { createCoreTools } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { taskTool } from '../src/tools/task.js';
import { createTestContext, writeTestFile } from './helpers/index.js';

const CAPABILITIES: ProviderCapabilities = {
  toolUse: true,
  parallelToolCalls: true,
  streaming: true,
  promptCaching: false,
  maxContextTokens: 10_000,
  maxOutputTokens: 1_000,
};

function stubProvider(capture?: (request: StreamRequest) => void): Provider {
  return {
    id: 'stub',
    type: 'openai',
    model: 'stub-model',
    capabilities: CAPABILITIES,
    async *stream(request: StreamRequest): AsyncGenerator<AgentEvent> {
      capture?.(request);
      yield { type: 'text_delta', text: 'SUBAGENT_DONE' };
      yield { type: 'stop', reason: 'end' };
    },
  };
}

function setup(capture?: (request: StreamRequest) => void) {
  const ctx = createTestContext();
  ctx.provider = stubProvider(capture);
  ctx.registry = new ToolRegistry(createCoreTools());
  ctx.permissionGate = new PermissionGate({
    mode: 'acceptEdits',
    rules: [],
    cwd: ctx.cwd,
    ask: async () => true,
  });
  ctx.subagentDepth = 0;

  writeTestFile(
    ctx.cwd,
    '.agent/agents/reviewer.md',
    [
      '---',
      'name: reviewer',
      'description: 只读审查',
      'tools: [Read]',
      'maxTurns: 2',
      '---',
      '你是审查员，只读，不修改文件。',
    ].join('\n'),
  );

  return ctx;
}

describe('Task / subagents', () => {
  it('按定义限制工具并返回最终结论', async () => {
    let capturedSystem = '';
    let capturedTools: string[] = [];
    const ctx = setup((request) => {
      capturedSystem = request.system;
      capturedTools = (request.tools ?? []).map((tool) => tool.name);
    });

    const result = await taskTool.call(
      {
        description: '审查代码',
        prompt: '检查 src 目录',
        subagent_type: 'reviewer',
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(result.output).toBe('SUBAGENT_DONE');
    expect(capturedTools).toEqual(['Read']);
    expect(capturedSystem).toContain('只读审查');
    expect(capturedSystem).toContain('你是审查员');
  });

  it('拒绝递归子 Agent', async () => {
    const ctx = setup();
    ctx.subagentDepth = 1;

    await expect(
      taskTool.call({ description: 'again', prompt: 'again', subagent_type: 'reviewer' }, ctx),
    ).rejects.toThrow(/递归深度/);
  });

  it('未知子 Agent 给出可用列表', async () => {
    const ctx = setup();

    await expect(
      taskTool.call({ description: 'x', prompt: 'x', subagent_type: 'nope' }, ctx),
    ).rejects.toThrow(/reviewer/);
  });
});
