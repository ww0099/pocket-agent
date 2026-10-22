import type { ContentBlock, Message } from '../core/messages.js';
import type { SessionRecord } from './types.js';

/**
 * 把 JSONL 记录重建为模型消息：
 * 连续的 tool_result 记录合并为一条 user 消息。
 */
export function recordsToMessages(records: readonly SessionRecord[]): Message[] {
  let messages: Message[] = [];
  let pendingToolResults: ContentBlock[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    messages.push({
      role: 'user',
      content: pendingToolResults,
      meta: { timestamp: Date.now() },
    });
    pendingToolResults = [];
  };

  for (const record of records) {
    if (record.type === 'tool_result') {
      pendingToolResults.push({
        type: 'tool_result',
        toolUseId: record.toolUseId,
        content: record.content,
        isError: record.isError,
      });
      continue;
    }

    if (record.type === 'compaction') {
      flushToolResults();
      // 压缩记录之后，模型可见的历史被重置为“摘要 + 最近消息”；
      // 更早的原始记录仍保留在 JSONL 中用于审计。
      messages = [record.summaryMessage, ...record.keptMessages];
      continue;
    }

    if (record.type === 'message') {
      flushToolResults();
      messages.push(record.message);
    }
  }

  flushToolResults();
  return messages;
}
