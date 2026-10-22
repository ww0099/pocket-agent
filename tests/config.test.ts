import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensureDefaultConfig, loadConfig } from '../src/bootstrap/config.js';
import { ConfigError } from '../src/util/errors.js';
import { makeTempDir } from './helpers/index.js';

const VALID_PROVIDERS = `{
  // 测试用 Provider
  "default": "alpha",
  "providers": {
    "alpha": {
      "type": "anthropic",
      "baseUrl": "https://alpha.test",
      "model": "alpha-model",
      "apiKeyEnv": "ALPHA_KEY"
    }
  }
}`;

function writeConfig(root: string, settings: string, providers = VALID_PROVIDERS): void {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), settings, 'utf8');
  fs.writeFileSync(path.join(dir, 'providers.json'), providers, 'utf8');
}

describe('config', () => {
  it('首次运行生成默认配置且不覆盖已有文件', () => {
    const root = makeTempDir('config-default');
    const paths = ensureDefaultConfig(root);

    const settingsFile = path.join(paths.configDir, 'settings.json');
    expect(fs.existsSync(settingsFile)).toBe(true);
    expect(fs.existsSync(path.join(paths.configDir, 'providers.json'))).toBe(true);

    const loaded = loadConfig({ root });
    expect(loaded.providers.default).toBe('anthropic');
    expect(loaded.settings.retry.maxAttempts).toBe(3);

    fs.writeFileSync(settingsFile, '{ "debug": true }', 'utf8');
    ensureDefaultConfig(root);
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe('{ "debug": true }');
  });

  it('支持 JSONC 注释并应用默认值', () => {
    const root = makeTempDir('config-jsonc');
    writeConfig(
      root,
      `{
        // 调试开关
        "debug": true,
        "retry": { "maxAttempts": 5 }
      }`,
    );

    const loaded = loadConfig({ root });
    expect(loaded.settings.debug).toBe(true);
    expect(loaded.settings.retry.maxAttempts).toBe(5);
    expect(loaded.settings.retry.baseDelayMs).toBe(500);
    expect(loaded.providers.providers.alpha?.model).toBe('alpha-model');
  });

  it('JSON 语法错误带文件与行号', () => {
    const root = makeTempDir('config-bad-json');
    writeConfig(root, '{ "debug": }');

    expect(() => loadConfig({ root })).toThrowError(ConfigError);
    try {
      loadConfig({ root });
    } catch (error) {
      expect((error as ConfigError).format()).toContain('settings.json');
      expect((error as ConfigError).line).toBeGreaterThan(0);
    }
  });

  it('拒绝未知字段（防止拼写错误被静默忽略）', () => {
    const root = makeTempDir('config-unknown');
    writeConfig(root, '{ "debug": true, "debgu": false }');

    expect(() => loadConfig({ root })).toThrowError(/配置校验失败/);
  });

  it('default 指向不存在的 Provider 时报错', () => {
    const root = makeTempDir('config-missing-default');
    writeConfig(
      root,
      '{}',
      `{
        "default": "missing",
        "providers": {
          "alpha": {
            "type": "anthropic",
            "baseUrl": "https://alpha.test",
            "model": "m",
            "apiKeyEnv": "ALPHA_KEY"
          }
        }
      }`,
    );

    expect(() => loadConfig({ root })).toThrowError(/default/);
  });
});
