import type { ProviderConfig } from '../bootstrap/config.js';
import { ProviderError } from '../util/errors.js';
import { anthropicModelsUrl, openAiModelsUrl } from './endpoints.js';
import { DEFAULT_RETRY, type RetryPolicy, fetchWithRetry } from './retry.js';

export interface ModelInfo {
  id: string;
  displayName?: string;
  createdAt?: string;
  ownedBy?: string;
}

export interface ListModelsOptions {
  fetchImpl?: typeof fetch;
  retry?: RetryPolicy;
}

/**
 * 向服务商拉取模型列表。
 * OpenAI 兼容接口通常是 GET /v1/models；Anthropic 是 GET /v1/models。
 */
export async function listModels(
  config: ProviderConfig,
  apiKey: string,
  options: ListModelsOptions = {},
): Promise<ModelInfo[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url =
    config.type === 'anthropic'
      ? anthropicModelsUrl(config.baseUrl)
      : openAiModelsUrl(config.baseUrl);

  const headers: Record<string, string> =
    config.type === 'anthropic'
      ? {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        }
      : {
          authorization: `Bearer ${apiKey}`,
        };

  Object.assign(headers, config.headers);

  const response = await fetchWithRetry(
    url,
    { method: 'GET', headers },
    {
      fetchImpl,
      retry: options.retry ?? DEFAULT_RETRY,
    },
  );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ProviderError('模型列表响应不是合法 JSON', {
      cause: error,
      hint: '该服务商可能不支持 /models 端点',
    });
  }

  return parseModels(payload);
}

function parseModels(payload: unknown): ModelInfo[] {
  if (!payload || typeof payload !== 'object') return [];

  const record = payload as Record<string, unknown>;
  const candidates = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];

  const models: ModelInfo[] = [];

  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;

    const id =
      typeof entry.id === 'string'
        ? entry.id
        : typeof entry.name === 'string'
          ? entry.name
          : typeof entry.model === 'string'
            ? entry.model
            : undefined;

    if (!id) continue;

    const model: ModelInfo = { id };
    if (typeof entry.display_name === 'string') model.displayName = entry.display_name;
    if (typeof entry.displayName === 'string') model.displayName = entry.displayName;
    if (typeof entry.created_at === 'string') model.createdAt = entry.created_at;
    if (typeof entry.owned_by === 'string') model.ownedBy = entry.owned_by;
    models.push(model);
  }

  return models.sort((a, b) => a.id.localeCompare(b.id));
}
