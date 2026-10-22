export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'image'; mediaType: string; data: string };

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  meta?: {
    timestamp: number;
    model?: string;
    usage?: Usage;
  };
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'error';

export function userText(text: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    meta: { timestamp: Date.now() },
  };
}

export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function toolUsesOf(blocks: ContentBlock[]): Extract<ContentBlock, { type: 'tool_use' }>[] {
  return blocks.filter(
    (block): block is Extract<ContentBlock, { type: 'tool_use' }> => block.type === 'tool_use',
  );
}
