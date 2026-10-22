import { ProviderError, errorMessage } from '../util/errors.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };

    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface FetchRetryOptions {
  fetchImpl: typeof fetch;
  retry: RetryPolicy;
  signal?: AbortSignal;
  onRetry?: (attempt: number, error: unknown, waitMs: number) => void;
}

/**
 * 只对"建立连接阶段"做重试：拿到 2xx 响应后，流中断不再重试，
 * 避免产生重复的 assistant 消息。
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchRetryOptions,
): Promise<Response> {
  const { fetchImpl, retry, signal, onRetry } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { ...init, signal });

      if (response.ok) return response;

      const detail = await readErrorBody(response);
      const error = new ProviderError(`HTTP ${response.status} ${response.statusText}`.trim(), {
        status: response.status,
        retryable: isRetryableStatus(response.status),
        detail,
        hint: buildHint(response.status),
      });

      if (!error.retryable || attempt >= retry.maxAttempts) throw error;
      lastError = error;
    } catch (error) {
      if (signal?.aborted) throw error;

      if (error instanceof ProviderError) {
        if (!error.retryable || attempt >= retry.maxAttempts) throw error;
        lastError = error;
      } else {
        lastError = error;
        if (attempt >= retry.maxAttempts) {
          throw new ProviderError(`网络请求失败：${errorMessage(error)}`, {
            cause: error,
            retryable: true,
            hint: '检查网络、代理或 baseUrl 配置',
          });
        }
      }
    }

    const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
    const waitMs = backoff + Math.floor(backoff * 0.2 * Math.random());
    onRetry?.(attempt, lastError, waitMs);
    await delay(waitMs, signal);
  }

  throw lastError instanceof Error ? lastError : new ProviderError('请求失败', { retryable: true });
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 800);
  } catch {
    return '';
  }
}

function buildHint(status: number): string | undefined {
  if (status === 401 || status === 403) return '检查 API Key 是否正确、是否有该模型的权限';
  if (status === 404) return '检查 baseUrl 与模型名是否正确';
  if (status === 429) return '触发限流，稍后重试或降低请求频率';
  if (status >= 500) return '服务端错误，通常可重试';
  return undefined;
}
