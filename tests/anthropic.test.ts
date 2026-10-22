import { describe, expect, it } from 'vitest';

import { userText } from '../src/core/messages.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { DEFAULT_RETRY } from '../src/providers/retry.js';
import { collect, sseResponse } from './helpers/index.js';

const CONFIG = {
  type: 'anthropic' as const,
  baseUrl: 'https://anthropic.test',
  model: 'test-model',
  apiKeyEnv: 'TEST_KEY',
  maxContextTokens: 1000,
  maxOutputTokens: 100,
};

function providerWith(
  chunks: string[],
  capture?: (init: RequestInit | undefined) => void,
): AnthropicProvider {
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capture?.(init);
    return sseResponse(chunks);
  }) as typeof fetch;

  return new AnthropicProvider(
    'test',
    CONFIG,
    { apiKey: 'sk-test-secret', fetchImpl: fakeFetch },
    DEFAULT_RETRY,
  );
}

describe('AnthropicProvider', () => {
  it('解析文本流与 usage', async () => {
    const provider = providerWith([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);

    const events = await collect(provider.stream({ system: 'sys', messages: [userText('hi')] }));

    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'Hello' },
    ]);
    expect(events.find((event) => event.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 12, outputTokens: 0 },
    });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end' });
  });

  it('解析工具调用并拼接参数', async () => {
    const provider = providerWith([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);

    const events = await collect(provider.stream({ system: '', messages: [userText('read')] }));

    expect(events.find((event) => event.type === 'tool_call_start')).toEqual({
      type: 'tool_call_start',
      id: 'toolu_1',
      name: 'Read',
    });
    expect(events.find((event) => event.type === 'tool_call_end')).toEqual({
      type: 'tool_call_end',
      id: 'toolu_1',
      name: 'Read',
      input: { path: 'a.txt' },
    });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('发送正确的请求头、模型与消息结构', async () => {
    let captured: RequestInit | undefined;
    const provider = providerWith(['data: {"type":"message_stop"}\n\n'], (init) => {
      captured = init;
    });

    await collect(provider.stream({ system: 'system prompt', messages: [userText('hi')] }));

    const headers = captured?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-secret');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(String(captured?.body)) as Record<string, unknown>;
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(true);
    expect(body.system).toBe('system prompt');
    expect(body.max_tokens).toBe(100);
  });
});
