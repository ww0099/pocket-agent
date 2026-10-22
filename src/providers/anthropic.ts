import type { AgentEvent } from '../core/events.js';
import type { ContentBlock, Message, StopReason, Usage } from '../core/messages.js';
import { ProviderError } from '../util/errors.js';
import { anthropicMessagesUrl } from './endpoints.js';
import { parseToolInput } from './json.js';
import { type RetryPolicy, fetchWithRetry } from './retry.js';
import { parseSse } from './sse.js';
import type {
  Provider,
  ProviderCapabilities,
  ProviderFactoryOptions,
  StreamRequest,
  ToolSchema,
} from './types.js';

interface AnthropicConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  headers?: Record<string, string>;
  maxContextTokens: number;
  maxOutputTokens: number;
  temperature?: number;
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: { usage?: AnthropicUsage };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: AnthropicUsage;
  error?: { type?: string; message?: string };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ToolAccumulator {
  id: string;
  name: string;
  json: string;
}

export class AnthropicProvider implements Provider {
  readonly type = 'anthropic' as const;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  constructor(
    readonly id: string,
    private readonly config: AnthropicConfig,
    private readonly options: ProviderFactoryOptions & { apiKey: string },
    private readonly retry: RetryPolicy,
  ) {
    this.model = config.model;
    this.capabilities = {
      toolUse: true,
      parallelToolCalls: true,
      streaming: true,
      promptCaching: true,
      maxContextTokens: config.maxContextTokens,
      maxOutputTokens: config.maxOutputTokens,
    };
  }

  async *stream(request: StreamRequest): AsyncGenerator<AgentEvent> {
    const url = anthropicMessagesUrl(this.config.baseUrl);
    const body = this.buildBody(request);

    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
          ...this.config.headers,
        },
        body: JSON.stringify(body),
      },
      {
        fetchImpl: this.options.fetchImpl ?? fetch,
        retry: this.retry,
        signal: request.signal,
      },
    );

    if (!response.body) {
      throw new ProviderError('Anthropic 响应缺少 body');
    }

    const toolAccumulators = new Map<number, ToolAccumulator>();
    let stopReason: StopReason = 'end';
    let sawStop = false;

    for await (const sse of parseSse(response.body)) {
      if (sse.data === '[DONE]') break;

      let event: AnthropicStreamEvent;
      try {
        event = JSON.parse(sse.data) as AnthropicStreamEvent;
      } catch {
        // 心跳或非 JSON 数据，跳过
        continue;
      }

      switch (event.type) {
        case 'message_start': {
          if (event.message?.usage) {
            yield { type: 'usage', usage: mapUsage(event.message.usage) };
          }
          break;
        }

        case 'content_block_start': {
          const index = event.index ?? 0;
          const block = event.content_block;
          if (block?.type === 'tool_use') {
            const id = block.id ?? `tool_${index}`;
            const name = block.name ?? 'unknown';
            toolAccumulators.set(index, { id, name, json: '' });
            yield { type: 'tool_call_start', id, name };
          }
          break;
        }

        case 'content_block_delta': {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            yield { type: 'text_delta', text: delta.text };
          } else if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
            const accumulator = toolAccumulators.get(event.index ?? 0);
            if (accumulator) {
              accumulator.json += delta.partial_json;
              yield {
                type: 'tool_call_delta',
                id: accumulator.id,
                argsText: delta.partial_json,
              };
            }
          } else if (delta?.type === 'thinking_delta' && delta.text) {
            yield { type: 'thinking_delta', text: delta.text };
          }
          break;
        }

        case 'content_block_stop': {
          const index = event.index ?? 0;
          const accumulator = toolAccumulators.get(index);
          if (accumulator) {
            yield* finalizeToolCall(accumulator);
            toolAccumulators.delete(index);
          }
          break;
        }

        case 'message_delta': {
          if (event.delta?.stop_reason) {
            stopReason = mapStopReason(event.delta.stop_reason);
          }
          if (event.usage) {
            yield { type: 'usage', usage: mapUsage(event.usage) };
          }
          break;
        }

        case 'message_stop': {
          sawStop = true;
          yield { type: 'stop', reason: stopReason };
          break;
        }

        case 'error': {
          yield {
            type: 'error',
            message: event.error?.message ?? 'Anthropic 流式错误',
            retryable: false,
          };
          sawStop = true;
          break;
        }

        default:
          break;
      }

      if (sawStop) break;
    }

    // 某些兼容实现不发送 content_block_stop / message_stop，兜底收尾
    for (const accumulator of toolAccumulators.values()) {
      yield* finalizeToolCall(accumulator);
    }
    if (!sawStop) {
      yield { type: 'stop', reason: stopReason };
    }
  }

  private buildBody(request: StreamRequest): Record<string, unknown> {
    const messages = toAnthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      max_tokens: request.maxTokens ?? this.config.maxOutputTokens,
      messages,
      stream: true,
    };

    if (request.system) body.system = request.system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    else if (this.config.temperature !== undefined) body.temperature = this.config.temperature;

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(toAnthropicTool);
    }

    return body;
  }
}

function toAnthropicTool(tool: ToolSchema): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function toAnthropicMessages(messages: Message[]): Array<{ role: string; content: unknown[] }> {
  const result: Array<{ role: string; content: unknown[] }> = [];

  for (const message of messages) {
    const content = message.content.map(toAnthropicBlock);
    if (content.length === 0) continue;
    result.push({ role: message.role, content });
  }

  return result;
}

function toAnthropicBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
    case 'image':
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mediaType,
          data: block.data,
        },
      };
  }
}

function finalizeToolCall(accumulator: ToolAccumulator): AgentEvent[] {
  const parsed = parseToolInput(accumulator.json);
  if (parsed.ok) {
    return [
      {
        type: 'tool_call_end',
        id: accumulator.id,
        name: accumulator.name,
        input: parsed.value,
      },
    ];
  }

  // 即使参数不合法也要发出 end，保证调用方状态机一致
  return [
    {
      type: 'error',
      message: `工具 ${accumulator.name} 的参数不是合法 JSON：${parsed.error}`,
      retryable: false,
    },
    {
      type: 'tool_call_end',
      id: accumulator.id,
      name: accumulator.name,
      input: {},
    },
  ];
}

function mapUsage(usage: AnthropicUsage): Usage {
  const result: Usage = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
  if (usage.cache_read_input_tokens !== undefined) {
    result.cacheReadTokens = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens !== undefined) {
    result.cacheWriteTokens = usage.cache_creation_input_tokens;
  }
  return result;
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case 'end_turn':
      return 'end';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end';
  }
}
