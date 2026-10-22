import type { ProviderConfig } from '../bootstrap/config.js';
import { ProviderError } from '../util/errors.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiProvider } from './openai.js';
import { DEFAULT_RETRY, type RetryPolicy } from './retry.js';
import type { Provider, ProviderFactoryOptions } from './types.js';

export function createProvider(
  id: string,
  config: ProviderConfig,
  options: ProviderFactoryOptions = {},
  retry: RetryPolicy = DEFAULT_RETRY,
): Provider {
  const apiKey = options.apiKey;
  if (!apiKey) {
    throw new ProviderError(`Provider "${id}" 未配置 API Key`, {
      hint: `设置环境变量 ${config.apiKeyEnv}，或在 config\\secrets.json 中写入 {"${id}": "..."}`,
    });
  }

  if (config.type === 'anthropic') {
    return new AnthropicProvider(id, config, { ...options, apiKey }, retry);
  }

  return new OpenAiProvider(id, config, { ...options, apiKey }, retry);
}
