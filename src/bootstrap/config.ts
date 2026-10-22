import fs from 'node:fs';
import path from 'node:path';

import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser';
import { z } from 'zod';

import { ConfigError } from '../util/errors.js';
import { type AgentPaths, getPaths } from './paths.js';
import { resolveAgentRoot } from './root.js';

const RetrySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10).default(3),
    baseDelayMs: z.number().int().min(0).max(60_000).default(500),
    maxDelayMs: z.number().int().min(0).max(120_000).default(8_000),
  })
  .strict();

const LimitsSchema = z
  .object({
    readMaxLines: z.number().int().positive().max(5000).default(2000),
    globMaxResults: z.number().int().positive().max(5000).default(500),
    grepMaxResults: z.number().int().positive().max(5000).default(200),
    bashTimeoutMs: z.number().int().positive().max(600_000).default(120_000),
    bashMaxOutputBytes: z.number().int().positive().default(524_288),
    toolOutputBytes: z.number().int().positive().default(30_000),
  })
  .strict();

export const SettingsSchema = z
  .object({
    defaultProvider: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    debug: z.boolean().default(false),
    permissionMode: z.enum(['default', 'acceptEdits', 'plan', 'bypass']).optional(),
    shell: z.enum(['powershell', 'cmd', 'bash']).optional(),
    retry: RetrySchema.default({ maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 }),
    limits: LimitsSchema.default({
      readMaxLines: 2000,
      globMaxResults: 500,
      grepMaxResults: 200,
      bashTimeoutMs: 120_000,
      bashMaxOutputBytes: 524_288,
      toolOutputBytes: 30_000,
    }),
  })
  .strict();

const PricingSchema = z
  .object({
    currency: z.string().min(1).default('USD'),
    inputPerMillion: z.number().min(0).default(0),
    outputPerMillion: z.number().min(0).default(0),
    cacheReadPerMillion: z.number().min(0).optional(),
    cacheWritePerMillion: z.number().min(0).optional(),
  })
  .strict();

const BaseProviderSchema = z
  .object({
    baseUrl: z.string().url(),
    model: z.string().min(1),
    apiKeyEnv: z.string().min(1),
    headers: z.record(z.string()).optional(),
    maxContextTokens: z.number().int().positive().default(128_000),
    maxOutputTokens: z.number().int().positive().default(8_192),
    temperature: z.number().min(0).max(2).optional(),
    pricing: PricingSchema.optional(),
  })
  .strict();

const AnthropicProviderSchema = BaseProviderSchema.extend({
  type: z.literal('anthropic'),
  apiKeyEnv: z.string().min(1).default('ANTHROPIC_API_KEY'),
  maxContextTokens: z.number().int().positive().default(200_000),
});

const OpenAiProviderSchema = BaseProviderSchema.extend({
  type: z.literal('openai'),
  apiKeyEnv: z.string().min(1).default('OPENAI_API_KEY'),
  parallelToolCalls: z.boolean().default(true),
  includeUsage: z.boolean().default(true),
  extraBody: z.record(z.unknown()).optional(),
}).strict();

export const ProviderConfigSchema = z.discriminatedUnion('type', [
  AnthropicProviderSchema,
  OpenAiProviderSchema,
]);

export const ProvidersFileSchema = z
  .object({
    default: z.string().min(1),
    providers: z.record(z.string().min(1), ProviderConfigSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value.providers).length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '至少配置一个 Provider' });
      return;
    }
    if (!value.providers[value.default]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `default 指向不存在的 Provider：${value.default}`,
        path: ['default'],
      });
    }
  });

export type Settings = z.infer<typeof SettingsSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;

export interface LoadedConfig {
  root: string;
  paths: AgentPaths;
  settings: Settings;
  providers: ProvidersFile;
}

export const DEFAULT_SETTINGS = `{
  // 默认 Provider（对应 providers.json 中的键名）
  "defaultProvider": "anthropic",
  "debug": false,
  "permissionMode": "default",
  "limits": {
    "readMaxLines": 2000,
    "globMaxResults": 500,
    "grepMaxResults": 200,
    "bashTimeoutMs": 120000,
    "bashMaxOutputBytes": 524288,
    "toolOutputBytes": 30000
  },
  "retry": {
    "maxAttempts": 3,
    "baseDelayMs": 500,
    "maxDelayMs": 8000
  }
}
`;

export const DEFAULT_PROVIDERS = `{
  // 默认 Provider。可用 /provider 或 --provider 切换。
  "default": "anthropic",
  "providers": {
    "anthropic": {
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "model": "claude-sonnet-5",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "maxContextTokens": 200000,
      "maxOutputTokens": 8192,
      "pricing": {
        "currency": "USD",
        "inputPerMillion": 0,
        "outputPerMillion": 0
      }
    },
    "deepseek": {
      "type": "openai",
      "baseUrl": "https://api.deepseek.com",
      "model": "deepseek-chat",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "maxContextTokens": 128000,
      "maxOutputTokens": 8192,
      "pricing": {
        "currency": "USD",
        "inputPerMillion": 0,
        "outputPerMillion": 0
      }
    },
    "zhipu": {
      "type": "openai",
      "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "model": "glm-4.1-flash",
      "apiKeyEnv": "ZHIPU_API_KEY",
      "maxContextTokens": 128000,
      "maxOutputTokens": 8192,
      "pricing": {
        "currency": "CNY",
        "inputPerMillion": 0,
        "outputPerMillion": 0
      }
    }
  }
}
`;

export const DEFAULT_HOOKS_JSON = `{
  // PreToolUse / PostToolUse 钩子；退出码 2 表示阻止工具执行
  "PreToolUse": [],
  "PostToolUse": []
}
`;

export const DEFAULT_MCP_JSON = `{
  // MCP Server 配置。示例：
  // "filesystem": {
  //   "command": "npx",
  //   "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\\\work"]
  // }
  "mcpServers": {}
}
`;

export const DEFAULT_PERMISSIONS_JSON = `{
  // 只读工具默认允许；写操作与命令在未命中 allow 规则时请求授权
  "allow": ["Read", "Glob", "Grep"],
  "deny": ["Read(**/.env)", "Read(**/*.pem)", "Read(**/.ssh/**)"],
  "additionalDirectories": []
}
`;

/** 首次运行时生成默认配置；已存在的文件绝不覆盖。 */
export function ensureDefaultConfig(root: string = resolveAgentRoot()): AgentPaths {
  const paths = getPaths(root);
  fs.mkdirSync(paths.configDir, { recursive: true });
  writeIfMissing(path.join(paths.configDir, 'settings.json'), DEFAULT_SETTINGS);
  writeIfMissing(path.join(paths.configDir, 'providers.json'), DEFAULT_PROVIDERS);
  writeIfMissing(path.join(paths.configDir, 'permissions.json'), DEFAULT_PERMISSIONS_JSON);
  writeIfMissing(path.join(paths.configDir, 'mcp.json'), DEFAULT_MCP_JSON);
  writeIfMissing(path.join(paths.configDir, 'hooks.json'), DEFAULT_HOOKS_JSON);
  return paths;
}

export function loadConfig(options: { root?: string } = {}): LoadedConfig {
  const root = options.root ?? resolveAgentRoot();
  const paths = getPaths(root);

  const settings = readJsoncFile(path.join(paths.configDir, 'settings.json'), SettingsSchema);
  const providers = readJsoncFile(
    path.join(paths.configDir, 'providers.json'),
    ProvidersFileSchema,
  );

  return { root, paths, settings, providers };
}

export function readJsoncFile<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError('无法读取配置文件', { file, cause: error });
  }

  text = stripBom(text);
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const first = errors[0];
    if (!first) {
      throw new ConfigError('JSON 语法错误', { file });
    }
    const position = offsetToLineColumn(text, first.offset);
    throw new ConfigError(`JSON 语法错误：${printParseErrorCode(first.error)}`, {
      file,
      line: position.line,
      column: position.column,
    });
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? `（字段 ${issue.path.join('.')}）` : '';
    throw new ConfigError(`配置校验失败${where}：${issue?.message ?? '未知错误'}`, { file });
  }

  return result.data;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function writeIfMissing(file: string, content: string): void {
  try {
    fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split('\n');
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
  };
}
