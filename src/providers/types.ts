import type { AgentEvent } from '../core/events.js';
import type { Message } from '../core/messages.js';

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ProviderCapabilities {
  toolUse: boolean;
  parallelToolCalls: boolean;
  streaming: boolean;
  promptCaching: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
}

export interface StreamRequest {
  system: string;
  messages: Message[];
  tools?: ToolSchema[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  readonly type: 'anthropic' | 'openai';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  stream(request: StreamRequest): AsyncGenerator<AgentEvent>;
}

export interface ProviderFactoryOptions {
  /** 便于离线测试注入假 fetch。 */
  fetchImpl?: typeof fetch;
  /** 由 SecretStore 解析出的密钥。 */
  apiKey?: string;
}
