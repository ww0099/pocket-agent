import { describe, expect, it } from 'vitest';

import { userText } from '../src/core/messages.js';
import { OpenAiProvider } from '../src/providers/openai.js';
import { DEFAULT_RETRY } from '../src/providers/retry.js';
import { collect, sseResponse } from './helpers/index.js';

const CONFIG = {
  type: 'openai' as const,
  baseUrl: 'https://openai.test/v1',
  model: 'test-model',
  apiKeyEnv: 'TEST_KEY',
  maxContextTokens: 1000,
  maxOutputTokens: 100,
  parallelToolCalls: true,
  includeUsage: true,
};

function providerWith(
  chunks: string[],
  capture?: (init: RequestInit | undefined) => void,
): OpenAiProvider {
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capture?.(init);
    return sseResponse(chunks);
  }) as typeof fetch;

  return new OpenAiProvider(
    'test',
    CONFIG,
    { apiKey: 'sk-test-secret', fetchImpl: fakeFetch },
    DEFAULT_RETRY,
  );
}

describe('OpenAiProvider', () => {
  it('解析文本流、usage 与结束原因', async () => {
    const provider = providerWith([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ]);

    const events = await collect(provider.stream({ system: 'sys', messages: [userText('hi')] }));

    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
    ]);
    expect(events.find((event) => event.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 7, outputTokens: 2 },
    });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end' });
  });

  it('解析工具调用分片', async () => {
    const provider = providerWith([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"b.txt\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const events = await collect(provider.stream({ system: '', messages: [userText('read')] }));

    expect(events.find((event) => event.type === 'tool_call_start')).toEqual({
      type: 'tool_call_start',
      id: 'call_1',
      name: 'Read',
    });
    expect(events.find((event) => event.type === 'tool_call_end')).toEqual({
      type: 'tool_call_end',
      id: 'call_1',
      name: 'Read',
      input: { path: 'b.txt' },
    });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('发送 Bearer 头与 OpenAI 兼容请求体', async () => {
    let captured: RequestInit | undefined;
    const provider = providerWith(['data: [DONE]\n\n'], (init) => {
      captured = init;
    });

    await collect(provider.stream({ system: 'system prompt', messages: [userText('hi')] }));

    const headers = captured?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test-secret');

    const body = JSON.parse(String(captured?.body)) as Record<string, unknown>;
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(100);
    expect(body.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('将工具结果映射为 role=tool 消息', async () => {
    let captured: RequestInit | undefined;
    const provider = providerWith(['data: [DONE]\n\n'], (init) => {
      captured = init;
    });

    await collect(
      provider.stream({
        system: '',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'ok', isError: false }],
          },
        ],
      }),
    );

    const body = JSON.parse(String(captured?.body)) as { messages: unknown[] };
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ]);
  });
});
