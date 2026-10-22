import type { AgentEvent } from '../core/events.js';
import type { ContentBlock, Message, StopReason, Usage } from '../core/messages.js';
import { ProviderError } from '../util/errors.js';
import { openAiChatUrl } from './endpoints.js';
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

interface OpenAiConfig {
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  headers?: Record<string, string>;
  maxContextTokens: number;
  maxOutputTokens: number;
  temperature?: number;
  parallelToolCalls: boolean;
  includeUsage: boolean;
  extraBody?: Record<string, unknown>;
}

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAiToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; type?: string };
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface ToolAccumulator {
  id: string;
  name: string;
  args: string;
  ended: boolean;
}

export class OpenAiProvider implements Provider {
  readonly type = 'openai' as const;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  constructor(
    readonly id: string,
    private readonly config: OpenAiConfig,
    private readonly options: ProviderFactoryOptions & { apiKey: string },
    private readonly retry: RetryPolicy,
  ) {
    this.model = config.model;
    this.capabilities = {
      toolUse: true,
      parallelToolCalls: config.parallelToolCalls,
      streaming: true,
      promptCaching: false,
      maxContextTokens: config.maxContextTokens,
      maxOutputTokens: config.maxOutputTokens,
    };
  }

  async *stream(request: StreamRequest): AsyncGenerator<AgentEvent> {
    const url = openAiChatUrl(this.config.baseUrl);
    const body = this.buildBody(request);

    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
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
      throw new ProviderError('OpenAI 兼容接口响应缺少 body');
    }

    const accumulators = new Map<number, ToolAccumulator>();
    let stopReason: StopReason = 'end';
    let stopEmitted = false;

    for await (const sse of parseSse(response.body)) {
      if (sse.data === '[DONE]') break;

      let chunk: OpenAiChunk;
      try {
        chunk = JSON.parse(sse.data) as OpenAiChunk;
      } catch {
        continue;
      }

      if (chunk.error) {
        yield {
          type: 'error',
          message: chunk.error.message ?? 'OpenAI 兼容接口返回错误',
          retryable: false,
        };
        stopEmitted = true;
        break;
      }

      if (chunk.usage) {
        yield { type: 'usage', usage: mapUsage(chunk.usage) };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta?.content) {
        yield { type: 'text_delta', text: delta.content };
      }
      if (delta?.reasoning_content) {
        yield { type: 'thinking_delta', text: delta.reasoning_content };
      }

      if (delta?.tool_calls) {
        for (const toolCall of delta.tool_calls) {
          const index = toolCall.index ?? 0;
          let accumulator = accumulators.get(index);

          if (!accumulator) {
            accumulator = {
              id: toolCall.id ?? `tool_${index}`,
              name: toolCall.function?.name ?? 'unknown',
              args: '',
              ended: false,
            };
            accumulators.set(index, accumulator);
            yield { type: 'tool_call_start', id: accumulator.id, name: accumulator.name };
          } else {
            if (toolCall.id && accumulator.id.startsWith('tool_')) {
              accumulator.id = toolCall.id;
            }
            if (toolCall.function?.name && accumulator.name === 'unknown') {
              accumulator.name = toolCall.function.name;
            }
          }

          const argsDelta = toolCall.function?.arguments;
          if (argsDelta) {
            accumulator.args += argsDelta;
            yield {
              type: 'tool_call_delta',
              id: accumulator.id,
              argsText: argsDelta,
            };
          }
        }
      }

      if (choice.finish_reason) {
        stopReason = mapStopReason(choice.finish_reason);
        for (const accumulator of accumulators.values()) {
          if (!accumulator.ended) {
            yield* finalizeToolCall(accumulator);
            accumulator.ended = true;
          }
        }
      }
    }

    for (const accumulator of accumulators.values()) {
      if (!accumulator.ended) {
        yield* finalizeToolCall(accumulator);
        accumulator.ended = true;
      }
    }

    // 有些服务不返回 usage，这里不伪造数字，交给上层显示"未知"
    if (!stopEmitted) {
      yield { type: 'stop', reason: stopReason };
    }
  }

  private buildBody(request: StreamRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      ...(this.config.extraBody ?? {}),
      model: request.model ?? this.model,
      messages: toOpenAiMessages(request.system, request.messages),
      stream: true,
      max_tokens: request.maxTokens ?? this.config.maxOutputTokens,
    };

    if (this.config.includeUsage) {
      body.stream_options = { include_usage: true };
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    } else if (this.config.temperature !== undefined) {
      body.temperature = this.config.temperature;
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map(toOpenAiTool);
    }
    if (!this.config.parallelToolCalls) {
      body.parallel_tool_calls = false;
    }

    return body;
  }
}

function toOpenAiTool(tool: ToolSchema): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toOpenAiMessages(system: string, messages: Message[]): OpenAiMessage[] {
  const result: OpenAiMessage[] = [];

  if (system.trim()) {
    result.push({ role: 'system', content: system });
  }

  for (const message of messages) {
    if (message.role === 'user') {
      const toolResults = message.content.filter(isToolResult);
      for (const resultBlock of toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: resultBlock.toolUseId,
          content: resultBlock.content,
        });
      }

      const text = message.content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('');
      if (text) {
        result.push({ role: 'user', content: text });
      }
      continue;
    }

    const text = message.content
      .filter(isTextBlock)
      .map((block) => block.text)
      .join('');
    const toolUses = message.content.filter(isToolUseBlock);
    if (!text && toolUses.length === 0) continue;

    const assistant: OpenAiMessage = {
      role: 'assistant',
      content: text || null,
    };
    if (toolUses.length > 0) {
      assistant.tool_calls = toolUses.map((block) => ({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      }));
    }
    result.push(assistant);
  }

  return result;
}

type TextBlock = Extract<ContentBlock, { type: 'text' }>;
type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

function isToolResult(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result';
}

function finalizeToolCall(accumulator: ToolAccumulator): AgentEvent[] {
  const parsed = parseToolInput(accumulator.args);
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

function mapUsage(usage: NonNullable<OpenAiChunk['usage']>): Usage {
  const result: Usage = {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) {
    result.cacheReadTokens = cached;
  }
  return result;
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end';
  }
}
