import { describe, expect, it } from 'vitest';

import type { ProviderConfig } from '../src/bootstrap/config.js';
import {
  anthropicMessagesUrl,
  anthropicModelsUrl,
  openAiChatUrl,
  openAiModelsUrl,
} from '../src/providers/endpoints.js';
import { listModels } from '../src/providers/models.js';

describe('provider endpoints', () => {
  it('OpenAI 兼容端点支持 /v1 与自定义版本段', () => {
    expect(openAiChatUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(openAiChatUrl('https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
    expect(openAiChatUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    );
    expect(openAiModelsUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(
      'https://open.bigmodel.cn/api/paas/v4/models',
    );
  });

  it('Anthropic 端点', () => {
    expect(anthropicMessagesUrl('https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(anthropicModelsUrl('https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1/models',
    );
  });
});

const OPENAI: ProviderConfig = {
  type: 'openai',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  maxContextTokens: 1000,
  maxOutputTokens: 100,
  parallelToolCalls: true,
  includeUsage: true,
};

const ANTHROPIC: ProviderConfig = {
  type: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-test',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  maxContextTokens: 1000,
  maxOutputTokens: 100,
};

describe('listModels', () => {
  it('解析 OpenAI 兼容模型列表并发送 Bearer 头', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const models = await listModels(OPENAI, 'sk-test', { fetchImpl: fakeFetch });

    expect(capturedUrl).toBe('https://api.deepseek.com/v1/models');
    expect(capturedHeaders.authorization).toBe('Bearer sk-test');
    expect(models.map((model) => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  });

  it('解析 Anthropic 模型列表并发送 x-api-key', async () => {
    let capturedHeaders: Record<string, string> = {};

    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          data: [{ id: 'claude-test', display_name: 'Claude Test' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const models = await listModels(ANTHROPIC, 'sk-ant', { fetchImpl: fakeFetch });

    expect(capturedHeaders['x-api-key']).toBe('sk-ant');
    expect(models[0]).toMatchObject({ id: 'claude-test', displayName: 'Claude Test' });
  });
});
