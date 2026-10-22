import type { Message, StopReason, Usage } from './messages.js';

export interface ToolResultView {
  id: string;
  name: string;
  output: string;
  isError: boolean;
}

/**
 * 内核对外暴露的唯一事件流。UI 只依赖这个联合类型，不依赖任何 Provider 协议。
 */
export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argsText: string }
  | { type: 'tool_call_end'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; result: ToolResultView }
  | { type: 'usage'; usage: Usage }
  | {
      type: 'compaction';
      summary: string;
      omittedMessages: number;
      keptMessageCount: number;
      beforeTokens: number;
      afterTokens: number;
    }
  | { type: 'stop'; reason: StopReason }
  | { type: 'turn_end'; message: Message }
  | { type: 'notice'; level: 'info' | 'warn'; text: string }
  | { type: 'error'; message: string; retryable: boolean };
