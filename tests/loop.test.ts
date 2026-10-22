import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../src/core/events.js';
import { runAgent } from '../src/core/loop.js';
import { userText } from '../src/core/messages.js';
import type { Provider, ProviderCapabilities, StreamRequest } from '../src/providers/types.js';
import { collect } from './helpers/index.js';

const CAPABILITIES: ProviderCapabilities = {
  toolUse: true,
  parallelToolCalls: true,
  streaming: true,
  promptCaching: false,
  maxContextTokens: 1000,
  maxOutputTokens: 100,
};

function stubProvider(events: AgentEvent[]): Provider {
  return {
    id: 'stub',
    type: 'openai',
    model: 'stub-model',
    capabilities: CAPABILITIES,
    async *stream(_request: StreamRequest): AsyncGenerator<AgentEvent> {
      for (const event of events) yield event;
    },
  };
}

describe('runAgent', () => {
  it('纯文本响应生成 assistant 消息', async () => {
    const provider = stubProvider([
      { type: 'text_delta', text: 'Hello' },
      { type: 'stop', reason: 'end' },
    ]);

    const events = await collect(
      runAgent({ provider, system: '', messages: [userText('hi')], maxTurns: 1 }),
    );

    const turnEnd = events.find((event) => event.type === 'turn_end');
    expect(turnEnd).toMatchObject({
      type: 'turn_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    });
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('提供工具执行器时执行工具并继续下一轮', async () => {
    let callCount = 0;
    const provider: Provider = {
      id: 'stub',
      type: 'openai',
      model: 'stub-model',
      capabilities: CAPABILITIES,
      async *stream(): AsyncGenerator<AgentEvent> {
        callCount += 1;
        if (callCount === 1) {
          yield { type: 'tool_call_start', id: 'call_1', name: 'Read' };
          yield { type: 'tool_call_end', id: 'call_1', name: 'Read', input: { path: 'a' } };
          yield { type: 'stop', reason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'stop', reason: 'end' };
      },
    };

    const events = await collect(
      runAgent({
        provider,
        system: '',
        messages: [userText('go')],
        maxTurns: 3,
        executeTools: async (calls) =>
          calls.map((call) => ({ call, output: 'file content', isError: false })),
      }),
    );

    expect(events.some((event) => event.type === 'tool_result')).toBe(true);
    const turnEnds = events.filter((event) => event.type === 'turn_end');
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[1]).toMatchObject({
      message: { content: [{ type: 'text', text: 'done' }] },
    });
  });

  it('M1 收到工具调用时明确报错而不是静默丢弃', async () => {
    const provider = stubProvider([
      { type: 'tool_call_start', id: 'call_1', name: 'Read' },
      { type: 'tool_call_end', id: 'call_1', name: 'Read', input: { path: 'a' } },
      { type: 'stop', reason: 'tool_use' },
    ]);

    const events = await collect(
      runAgent({ provider, system: '', messages: [userText('read')], maxTurns: 1 }),
    );

    expect(events.some((event) => event.type === 'error')).toBe(true);
    const assistant = events.find((event) => event.type === 'turn_end');
    expect(assistant).toMatchObject({
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } }],
      },
    });
  });
});
