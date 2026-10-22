import type { Provider, ToolSchema } from '../providers/types.js';
import type { AgentEvent } from './events.js';
import type { ContentBlock, Message } from './messages.js';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolExecution {
  call: ToolCall;
  output: string;
  isError: boolean;
}

export type ToolExecutor = (calls: ToolCall[], signal?: AbortSignal) => Promise<ToolExecution[]>;

export interface PreparedCompaction {
  summary: string;
  omittedMessages: number;
  keptMessageCount: number;
  beforeTokens: number;
  afterTokens: number;
}

export interface PreparedMessages {
  messages: Message[];
  compaction?: PreparedCompaction;
}

export interface AgentLoopOptions {
  provider: Provider;
  system: string;
  messages: Message[];
  tools?: ToolSchema[];
  model?: string;
  maxTurns?: number;
  signal?: AbortSignal;
  /** M2 接入真实工具执行；未提供时遇到 tool_use 会明确报错。 */
  executeTools?: ToolExecutor;
  /** M4 上下文压缩：每次模型调用前调用。 */
  prepareMessages?: (messages: Message[]) => Promise<PreparedMessages>;
}

/**
 * 唯一执行内核：流式调用 → 收集 tool_use → 执行工具 → 追加 tool_result → 下一轮。
 * TUI、headless 与子 Agent 都复用这一条路径。
 */
export async function* runAgent(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  const maxTurns = options.maxTurns ?? 8;
  let messages = [...options.messages];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const assistantBlocks: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let textBuffer = '';

    if (options.prepareMessages) {
      const prepared = await options.prepareMessages(messages);
      messages = prepared.messages;

      if (prepared.compaction) {
        yield {
          type: 'compaction',
          summary: prepared.compaction.summary,
          omittedMessages: prepared.compaction.omittedMessages,
          keptMessageCount: prepared.compaction.keptMessageCount,
          beforeTokens: prepared.compaction.beforeTokens,
          afterTokens: prepared.compaction.afterTokens,
        };
      }
    }

    for await (const event of options.provider.stream({
      system: options.system,
      messages,
      tools: options.tools,
      model: options.model,
      signal: options.signal,
    })) {
      if (event.type === 'text_delta') {
        textBuffer += event.text;
      } else if (event.type === 'tool_call_end') {
        toolCalls.push({ id: event.id, name: event.name, input: event.input });
      }
      yield event;
    }

    if (textBuffer) {
      assistantBlocks.push({ type: 'text', text: textBuffer });
    }
    for (const call of toolCalls) {
      assistantBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }

    if (assistantBlocks.length > 0) {
      const assistantMessage: Message = {
        role: 'assistant',
        content: assistantBlocks,
        meta: { timestamp: Date.now() },
      };
      messages.push(assistantMessage);
      yield { type: 'turn_end', message: assistantMessage };
    }

    if (toolCalls.length === 0) {
      return;
    }

    if (!options.executeTools) {
      yield {
        type: 'error',
        message: '当前版本尚未启用工具执行（M2 将支持）',
        retryable: false,
      };
      return;
    }

    const executions = await options.executeTools(toolCalls, options.signal);
    const toolResultBlocks: ContentBlock[] = [];

    for (const execution of executions) {
      yield {
        type: 'tool_result',
        result: {
          id: execution.call.id,
          name: execution.call.name,
          output: execution.output,
          isError: execution.isError,
        },
      };
      toolResultBlocks.push({
        type: 'tool_result',
        toolUseId: execution.call.id,
        content: execution.output,
        isError: execution.isError,
      });
    }

    if (toolResultBlocks.length > 0) {
      messages.push({
        role: 'user',
        content: toolResultBlocks,
        meta: { timestamp: Date.now() },
      });
    }
  }

  yield { type: 'error', message: `达到最大轮数 ${maxTurns}`, retryable: false };
}
