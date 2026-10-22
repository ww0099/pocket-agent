import { describe, expect, it } from 'vitest';

import { ContextManager } from '../src/core/context-manager.js';
import type { AgentEvent } from '../src/core/events.js';
import { type Message, userText } from '../src/core/messages.js';
import type { Provider, ProviderCapabilities, StreamRequest } from '../src/providers/types.js';
import { silentLogger } from '../src/util/log.js';

const CAPABILITIES: ProviderCapabilities = {
  toolUse: true,
  parallelToolCalls: true,
  streaming: true,
  promptCaching: false,
  maxContextTokens: 1_200,
  maxOutputTokens: 100,
};

function summaryProvider(summary = 'SUMMARY_TEXT'): Provider {
  return {
    id: 'stub',
    type: 'openai',
    model: 'stub',
    capabilities: CAPABILITIES,
    async *stream(_request: StreamRequest): AsyncGenerator<AgentEvent> {
      yield { type: 'text_delta', text: summary };
      yield { type: 'stop', reason: 'end' };
    },
  };
}

function failingProvider(): Provider {
  return {
    id: 'stub',
    type: 'openai',
    model: 'stub',
    capabilities: CAPABILITIES,
    async *stream(): AsyncGenerator<AgentEvent> {
      yield { type: 'error', message: 'summary failed', retryable: false };
      throw new Error('summary failed');
    },
  };
}

function buildMessages(count: number): Message[] {
  const messages: Message[] = [];

  for (let index = 0; index < count; index += 1) {
    if (index % 2 === 0) {
      messages.push(userText(`user message ${index} `.repeat(20)));
    } else {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: `assistant message ${index} `.repeat(20) }],
      });
    }
  }

  return messages;
}

function manager(provider: Provider, keepRecentMessages = 8): ContextManager {
  return new ContextManager({
    provider,
    system: 'system prompt',
    logger: silentLogger,
    getReinjection: () => '- 工作目录：D:\\work\n- 权限模式：default',
    keepRecentMessages,
  });
}

describe('ContextManager', () => {
  it('100+ 轮长会话触发压缩并保留最近消息', async () => {
    const messages = buildMessages(120);
    const result = await manager(summaryProvider()).prepare(messages);

    expect(result.compaction).toBeDefined();
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('SUMMARY_TEXT'),
    });
    expect(result.messages[0]?.content[0]).toMatchObject({
      text: expect.stringContaining('压缩时环境'),
    });

    const compaction = result.compaction;
    expect(compaction?.omittedMessages).toBeGreaterThan(100);
    expect(compaction?.afterTokens).toBeLessThan(compaction?.beforeTokens ?? 0);
    expect(compaction?.keptMessages.length).toBeLessThanOrEqual(8);
  });

  it('未超过阈值时不压缩', async () => {
    const messages = buildMessages(2);
    const result = await manager(summaryProvider()).prepare(messages);

    expect(result.compaction).toBeUndefined();
    expect(result.messages).toBe(messages);
  });

  it('不会从 tool_result 中间切断', async () => {
    const messages = buildMessages(111);
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' } }],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false }],
    });
    messages.push(userText('继续处理'));

    const result = await manager(summaryProvider()).prepare(messages);
    const firstKept = result.compaction?.keptMessages[0];

    expect(firstKept?.role).toBe('user');
    expect(firstKept?.content.some((block) => block.type === 'tool_result')).toBe(false);
  });

  it('摘要失败时降级为截断而不是抛错', async () => {
    const messages = buildMessages(120);
    const result = await manager(failingProvider()).prepare(messages);

    expect(result.compaction).toBeDefined();
    expect(result.messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('已省略'),
    });
  });

  it('force 在短会话上不产生压缩', async () => {
    const messages = buildMessages(2);
    const result = await manager(summaryProvider()).force(messages);

    expect(result.compaction).toBeUndefined();
  });
});
