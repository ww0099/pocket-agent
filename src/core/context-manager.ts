import type { Provider } from '../providers/types.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/log.js';
import type { Message } from './messages.js';
import { userText } from './messages.js';
import { estimateMessagesTokens, estimateTokens } from './tokens.js';

export interface CompactionInfo {
  summary: string;
  summaryMessage: Message;
  keptMessages: Message[];
  beforeTokens: number;
  afterTokens: number;
  omittedMessages: number;
}

export interface PrepareResult {
  messages: Message[];
  compaction?: CompactionInfo;
}

export interface ContextManagerOptions {
  provider: Provider;
  system: string;
  logger: Logger;
  getReinjection: () => string;
  threshold?: number;
  keepRecentMessages?: number;
}

const DEFAULT_THRESHOLD = 0.75;
const DEFAULT_KEEP_RECENT = 8;
const SUMMARY_MAX_TOKENS = 1_500;

/**
 * 上下文治理：超过窗口阈值时摘要较早对话，并保留最近消息。
 * 摘要请求本身不参与压缩，避免递归。
 */
export class ContextManager {
  constructor(private readonly options: ContextManagerOptions) {}

  async prepare(messages: Message[], signal?: AbortSignal): Promise<PrepareResult> {
    const beforeTokens = this.estimate(messages);
    const threshold = this.options.threshold ?? DEFAULT_THRESHOLD;

    if (beforeTokens <= this.windowTokens() * threshold) {
      return { messages };
    }

    return this.compact(messages, beforeTokens, signal);
  }

  async force(messages: Message[], signal?: AbortSignal): Promise<PrepareResult> {
    return this.compact(messages, this.estimate(messages), signal);
  }

  private async compact(
    messages: Message[],
    beforeTokens: number,
    signal?: AbortSignal,
  ): Promise<PrepareResult> {
    const keepRecent = this.options.keepRecentMessages ?? DEFAULT_KEEP_RECENT;
    const cut = findCut(messages, keepRecent);

    if (cut <= 0) {
      return { messages };
    }

    const older = messages.slice(0, cut);
    const keptMessages = messages.slice(cut);

    let summary: string;
    try {
      summary = await this.summarize(older, signal);
    } catch (error) {
      this.options.logger.warn(`上下文摘要失败，降级为截断：${errorMessage(error)}`);
      summary = `（自动压缩：较早的 ${older.length} 条消息已省略，保留最近 ${keptMessages.length} 条。）`;
    }

    const summaryMessage: Message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: buildSummaryText(summary, this.options.getReinjection()),
        },
      ],
      meta: { timestamp: Date.now() },
    };

    const nextMessages = [summaryMessage, ...keptMessages];

    return {
      messages: nextMessages,
      compaction: {
        summary,
        summaryMessage,
        keptMessages,
        beforeTokens,
        afterTokens: this.estimate(nextMessages),
        omittedMessages: older.length,
      },
    };
  }

  private async summarize(messages: Message[], signal?: AbortSignal): Promise<string> {
    const prompt = [
      '请把下面较早的对话压缩成一份供另一个 AI 继续工作的摘要。',
      '必须保留：用户目标、已做决策、已修改文件、未完成待办、关键错误与结论、重要路径或命令。',
      '不要编造；不要输出客套话；不超过 800 字。',
      '',
      '<conversation>',
      renderTranscript(messages),
      '</conversation>',
    ].join('\n');

    let summary = '';

    for await (const event of this.options.provider.stream({
      system:
        'You compress conversation history for another AI agent. Preserve facts, decisions, file paths, errors, and pending work. Output only the summary.',
      messages: [userText(prompt)],
      tools: [],
      maxTokens: SUMMARY_MAX_TOKENS,
      signal,
    })) {
      if (event.type === 'text_delta') {
        summary += event.text;
      } else if (event.type === 'error') {
        throw new Error(event.message);
      }
    }

    const trimmed = summary.trim();
    if (!trimmed) {
      throw new Error('摘要为空');
    }
    return trimmed.slice(0, 6_000);
  }

  private estimate(messages: Message[]): number {
    return estimateTokens(this.options.system) + estimateMessagesTokens(messages);
  }

  private windowTokens(): number {
    const capabilities = this.options.provider.capabilities;
    return Math.max(
      1_000,
      capabilities.maxContextTokens - Math.min(capabilities.maxOutputTokens, 8_192),
    );
  }
}

/** 从“保留窗口”的起点向后找一条真实用户文本消息，避免从 tool_result 中间切断。 */
function findCut(messages: Message[], keepRecent: number): number {
  const minimum = Math.max(0, messages.length - keepRecent);

  for (let index = minimum; index < messages.length; index += 1) {
    const message = messages[index];
    if (message && isUserTextMessage(message)) return index;
  }

  let cut = Math.max(0, messages.length - 2);
  while (cut < messages.length) {
    const message = messages[cut];
    if (!message || !isToolResultOnly(message)) break;
    cut += 1;
  }
  return cut;
}

function isUserTextMessage(message: Message): boolean {
  return (
    message.role === 'user' &&
    message.content.some((block) => block.type === 'text' && block.text.trim().length > 0)
  );
}

function isToolResultOnly(message: Message): boolean {
  return (
    message.role === 'user' &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === 'tool_result')
  );
}

function renderTranscript(messages: Message[]): string {
  return messages
    .map((message, index) => {
      const parts = message.content.map((block) => {
        switch (block.type) {
          case 'text':
            return block.text;
          case 'tool_use':
            return `[工具调用 ${block.name}] ${truncate(JSON.stringify(block.input ?? {}), 300)}`;
          case 'tool_result':
            return `[工具结果${block.isError ? '（错误）' : ''}] ${truncate(block.content, 600)}`;
          case 'image':
            return '[图片已省略]';
        }
      });

      return `### ${index + 1}. ${message.role}\n${parts.join('\n')}`;
    })
    .join('\n\n');
}

function buildSummaryText(summary: string, reinjection: string): string {
  return [
    '[系统自动压缩摘要] 以下是较早对话的摘要，原始内容已从上下文中省略。',
    '',
    summary,
    '',
    '## 压缩时环境',
    reinjection,
  ].join('\n');
}

function truncate(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ');
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`;
}
