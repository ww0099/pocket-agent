import type { ContentBlock, Message } from './messages.js';

/**
 * 保守 token 估算：CJK 字符按 1 token/字，其余按 3.5 字符/token。
 * 仅用于触发上下文压缩，不用于计费展示。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const cjkCount = countCjk(text);
  const rest = text.length - cjkCount;

  return Math.ceil(cjkCount + rest / 3.5);
}

export function estimateContentTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTokens(block.text);
    case 'tool_use':
      return 8 + estimateTokens(block.name) + estimateTokens(safeJson(block.input));
    case 'tool_result':
      return 8 + estimateTokens(block.content);
    case 'image':
      return 1_500;
  }
}

export function estimateMessageTokens(message: Message): number {
  const content = message.content.reduce((sum, block) => sum + estimateContentTokens(block), 0);
  return content + 4;
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function countCjk(text: string): number {
  const matches = text.match(/[　-鿿＀-￯]/g);
  return matches?.length ?? 0;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
