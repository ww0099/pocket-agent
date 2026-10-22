import fs from 'node:fs';
import path from 'node:path';

import { ConfigError } from '../util/errors.js';
import type { ProvidersFile } from './config.js';
import { stripBom } from './config.js';

export interface SecretStore {
  get(providerId: string): string | undefined;
  has(providerId: string): boolean;
  redact(text: string): string;
  /** 已配置密钥的 Provider 名（不暴露密钥值）。 */
  configuredProviders(): string[];
}

/**
 * 密钥优先级：环境变量（由 provider.apiKeyEnv 指定） > config/secrets.json。
 *
 * secrets.json 形如：{ "anthropic": "sk-...", "deepseek": "sk-..." }
 */
export function loadSecrets(
  configDir: string,
  providers: ProvidersFile,
  env: NodeJS.ProcessEnv = process.env,
): SecretStore {
  const fileSecrets = readSecretsFile(path.join(configDir, 'secrets.json'));
  const byProvider = new Map<string, string>();
  const redactionValues = new Set<string>();

  for (const [id, provider] of Object.entries(providers.providers)) {
    const fromEnv = env[provider.apiKeyEnv]?.trim();
    const fromFile = fileSecrets[id]?.trim();
    const value = fromEnv || fromFile;
    if (value) {
      byProvider.set(id, value);
      if (value.length >= 8) redactionValues.add(value);
    }
  }

  const orderedValues = [...redactionValues].sort((a, b) => b.length - a.length);

  return {
    get: (providerId) => byProvider.get(providerId),
    has: (providerId) => byProvider.has(providerId),
    redact: (text) => orderedValues.reduce((acc, secret) => acc.split(secret).join('***'), text),
    configuredProviders: () => [...byProvider.keys()],
  };
}

function readSecretsFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    throw new ConfigError('secrets.json 不是合法的 JSON', { file, cause: error });
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('secrets.json 必须是一个 JSON 对象，键为 Provider 名', { file });
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new ConfigError(`secrets.json 中 ${key} 的值必须是字符串`, { file });
    }
    result[key] = value;
  }
  return result;
}
