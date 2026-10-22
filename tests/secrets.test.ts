import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ProvidersFile } from '../src/bootstrap/config.js';
import { loadSecrets } from '../src/bootstrap/secrets.js';
import { ConfigError } from '../src/util/errors.js';
import { makeTempDir } from './helpers/index.js';

const PROVIDERS: ProvidersFile = {
  default: 'alpha',
  providers: {
    alpha: {
      type: 'anthropic',
      baseUrl: 'https://alpha.test',
      model: 'alpha-model',
      apiKeyEnv: 'ALPHA_KEY',
      maxContextTokens: 1000,
      maxOutputTokens: 100,
    },
    beta: {
      type: 'openai',
      baseUrl: 'https://beta.test',
      model: 'beta-model',
      apiKeyEnv: 'BETA_KEY',
      maxContextTokens: 1000,
      maxOutputTokens: 100,
      parallelToolCalls: true,
      includeUsage: true,
    },
  },
};

function writeSecrets(dir: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'secrets.json'), content, 'utf8');
}

describe('secrets', () => {
  it('环境变量优先于 secrets.json', () => {
    const dir = makeTempDir('secrets-env');
    writeSecrets(dir, JSON.stringify({ alpha: 'file-alpha-secret', beta: 'file-beta-secret' }));

    const store = loadSecrets(dir, PROVIDERS, {
      ALPHA_KEY: 'env-alpha-secret',
    } as NodeJS.ProcessEnv);

    expect(store.get('alpha')).toBe('env-alpha-secret');
    expect(store.get('beta')).toBe('file-beta-secret');
    expect(store.configuredProviders().sort()).toEqual(['alpha', 'beta']);
  });

  it('脱敏会替换所有已加载的密钥', () => {
    const dir = makeTempDir('secrets-redact');
    writeSecrets(dir, JSON.stringify({ alpha: 'file-alpha-secret' }));

    const store = loadSecrets(dir, PROVIDERS, {} as NodeJS.ProcessEnv);
    const output = store.redact('key=file-alpha-secret&other=ok');

    expect(output).toBe('key=***&other=ok');
    expect(output).not.toContain('file-alpha-secret');
  });

  it('secrets.json 非 JSON 时给出配置错误', () => {
    const dir = makeTempDir('secrets-bad');
    writeSecrets(dir, 'not-json');

    expect(() => loadSecrets(dir, PROVIDERS, {} as NodeJS.ProcessEnv)).toThrowError(ConfigError);
  });

  it('缺少密钥时 has() 返回 false', () => {
    const dir = makeTempDir('secrets-empty');
    const store = loadSecrets(dir, PROVIDERS, {} as NodeJS.ProcessEnv);

    expect(store.has('alpha')).toBe(false);
    expect(store.get('alpha')).toBeUndefined();
  });
});
