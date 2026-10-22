import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { type LoadedConfig, ensureDefaultConfig, loadConfig } from '../bootstrap/config.js';
import { ensureRuntimeDirs } from '../bootstrap/paths.js';
import { resolveAgentRoot } from '../bootstrap/root.js';
import { type SecretStore, loadSecrets } from '../bootstrap/secrets.js';
import type { AskHandler } from '../permissions/gate.js';
import { PERMISSION_MODES, type PermissionMode } from '../permissions/rules.js';
import { listModels } from '../providers/models.js';
import { createProvider } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';
import { SessionRuntime } from '../runtime/session-runtime.js';
import { ConfigError, ProviderError, errorMessage } from '../util/errors.js';
import { type Logger, createLogger } from '../util/log.js';
import { defaultShellKind } from '../util/shell.js';
import { PRODUCT_NAME, VERSION } from '../version.js';

export interface CliOptions {
  command: 'run' | 'version' | 'help' | 'list-providers' | 'list-models' | 'check';
  prompt?: string;
  providerId?: string;
  model?: string;
  debug: boolean;
  plain: boolean;
  continueSession: boolean;
  resumeId?: string;
  permissionMode?: PermissionMode;
  allowRules: string[];
  yes: boolean;
  maxTurns: number;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): CliOptions {
  const result: CliOptions = {
    command: 'run',
    debug: false,
    plain: false,
    continueSession: false,
    allowRules: [],
    yes: false,
    maxTurns: 8,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    switch (arg) {
      case '--version':
      case '-v':
        return { ...result, command: 'version' };
      case '--help':
      case '-h':
        return { ...result, command: 'help' };
      case '--list-providers':
        result.command = 'list-providers';
        break;
      case '--list-models':
        result.command = 'list-models';
        break;
      case '--check':
        result.command = 'check';
        break;
      case '--debug':
        result.debug = true;
        break;
      case '--plain':
        result.plain = true;
        break;
      case '--continue':
      case '-c':
        result.continueSession = true;
        break;
      case '--yes':
      case '-y':
        result.yes = true;
        break;
      case '--resume': {
        const next = argv[index + 1];
        if (!next) throw new UsageError('--resume 需要一个会话 ID');
        result.resumeId = next;
        index += 1;
        break;
      }
      case '--permission-mode': {
        const next = argv[index + 1];
        if (!next) throw new UsageError('--permission-mode 需要一个模式');
        result.permissionMode = parsePermissionMode(next);
        index += 1;
        break;
      }
      case '--allow': {
        const next = argv[index + 1];
        if (!next) throw new UsageError('--allow 需要一条权限规则');
        result.allowRules.push(next);
        index += 1;
        break;
      }
      case '--max-turns': {
        const next = argv[index + 1];
        const value = next ? Number.parseInt(next, 10) : Number.NaN;
        if (!Number.isFinite(value) || value < 1 || value > 50) {
          throw new UsageError('--max-turns 需要 1-50 之间的整数');
        }
        result.maxTurns = value;
        index += 1;
        break;
      }
      case '-p':
      case '--print': {
        const next = argv[index + 1];
        if (next === undefined) {
          throw new UsageError('--print 需要一个提示词参数（使用 - 表示从 stdin 读取）');
        }
        result.prompt = next;
        index += 1;
        break;
      }
      case '--provider': {
        const next = argv[index + 1];
        if (!next) throw new UsageError('--provider 需要一个 Provider 名称');
        result.providerId = next;
        index += 1;
        break;
      }
      case '--model': {
        const next = argv[index + 1];
        if (!next) throw new UsageError('--model 需要一个模型名称');
        result.model = next;
        index += 1;
        break;
      }
      default: {
        if (arg.startsWith('-')) {
          throw new UsageError(`未知参数：${arg}`);
        }
        if (result.prompt !== undefined) {
          throw new UsageError('只支持一个提示词参数');
        }
        result.prompt = arg;
      }
    }
  }

  return result;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: CliOptions;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`参数错误：${errorMessage(error)}`);
    printHelp();
    return 2;
  }

  if (parsed.command === 'version') {
    console.log(`${PRODUCT_NAME} ${VERSION}`);
    return 0;
  }
  if (parsed.command === 'help') {
    printHelp();
    return 0;
  }

  const root = resolveAgentRoot();
  ensureDefaultConfig(root);
  const config = loadConfig({ root });
  ensureRuntimeDirs(config.paths);

  const secrets = loadSecrets(config.paths.configDir, config.providers, process.env);
  const debug = parsed.debug || config.settings.debug;
  const logger = createLogger({
    level: debug ? 'debug' : 'warn',
    redact: secrets.redact,
  });

  try {
    if (parsed.command === 'list-providers') {
      listProviders(config, secrets);
      return 0;
    }
    if (parsed.command === 'list-models') {
      return await listProviderModels(config, secrets, parsed);
    }
    if (parsed.command === 'check') {
      return runCheck(config, secrets);
    }

    const providerId =
      parsed.providerId ?? config.settings.defaultProvider ?? config.providers.default;
    const providerConfig = config.providers.providers[providerId];
    if (!providerConfig) {
      throw new ConfigError(`未知 Provider：${providerId}`, {
        hint: `可用：${Object.keys(config.providers.providers).join(', ')}`,
      });
    }

    const provider = createProvider(
      providerId,
      providerConfig,
      { apiKey: secrets.get(providerId) },
      config.settings.retry,
    );

    const createRuntime = (ask?: AskHandler): SessionRuntime =>
      new SessionRuntime({
        config,
        secrets,
        provider,
        providerId,
        logger,
        debug,
        cwd: process.cwd(),
        model: parsed.model,
        permissionMode: parsed.permissionMode,
        allowRules: parsed.allowRules,
        maxTurns: parsed.maxTurns,
        resumeId: parsed.resumeId,
        continueSession: parsed.continueSession,
        yes: parsed.yes,
        ask,
      });

    let prompt = parsed.prompt;
    if (prompt === '-') {
      prompt = await readStdin();
    }

    if (prompt?.trim()) {
      const runtime = createRuntime();
      return await runHeadless(runtime, prompt, logger, debug);
    }

    if (parsed.plain || !isInteractiveTerminal()) {
      return await startPlainMode(createRuntime, logger);
    }

    try {
      return await startTuiMode(createRuntime);
    } catch (error) {
      logger.warn(`TUI 启动失败，回退到 plain 模式：${errorMessage(error)}`);
      return await startPlainMode(createRuntime, logger);
    }
  } catch (error) {
    return reportError(error, secrets.redact);
  }
}

async function runHeadless(
  runtime: SessionRuntime,
  prompt: string,
  logger: Logger,
  debug: boolean,
): Promise<number> {
  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort(new DOMException('用户中断', 'AbortError'));
  };
  process.once('SIGINT', onSigint);

  let hadError = false;
  let closeReason = 'exit';

  try {
    for await (const event of runtime.runTurn(prompt, controller.signal)) {
      switch (event.type) {
        case 'text_delta':
          process.stdout.write(event.text);
          break;
        case 'thinking_delta':
          if (debug) logger.debug(`thinking: ${event.text}`);
          break;
        case 'tool_call_start':
          logger.debug(`→ ${event.name}`);
          break;
        case 'tool_result':
          logger.debug(`← ${event.result.name} ${event.result.isError ? 'error' : 'ok'}`);
          break;
        case 'usage':
          logger.debug(`usage input=${event.usage.inputTokens} output=${event.usage.outputTokens}`);
          break;
        case 'error':
          hadError = true;
          closeReason = 'error';
          logger.error(event.message);
          break;
        case 'notice':
          logger.info(event.text);
          break;
        case 'compaction':
          logger.info(
            `上下文已压缩：省略 ${event.omittedMessages} 条，约 ${event.beforeTokens} → ${event.afterTokens} tokens`,
          );
          break;
        case 'stop':
          logger.debug(`stop=${event.reason}`);
          break;
        default:
          break;
      }
    }

    process.stdout.write('\n');
  } catch (error) {
    if (controller.signal.aborted) {
      closeReason = 'aborted';
      process.stdout.write('\n');
      logger.warn('已取消');
    } else {
      closeReason = 'error';
      throw error;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    runtime.close(closeReason);
  }

  if (controller.signal.aborted) return 130;
  return hadError ? 1 : 0;
}

async function startPlainMode(
  createRuntime: (ask?: AskHandler) => SessionRuntime,
  logger: Logger,
): Promise<number> {
  const { startPlain } = await import('../ui/plain.js');
  return startPlain({ createRuntime, logger });
}

async function startTuiMode(createRuntime: (ask?: AskHandler) => SessionRuntime): Promise<number> {
  const { ApprovalBroker } = await import('../ui/approval.js');
  const broker = new ApprovalBroker();
  const runtime = createRuntime(broker.ask);

  try {
    const { startTui } = await import('../ui/ink/start.js');
    return await startTui(runtime, broker);
  } finally {
    runtime.close('exit');
  }
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function listProviderModels(
  config: LoadedConfig,
  secrets: SecretStore,
  options: CliOptions,
): Promise<number> {
  const providerId =
    options.providerId ?? config.settings.defaultProvider ?? config.providers.default;
  const providerConfig = config.providers.providers[providerId];

  if (!providerConfig) {
    throw new ConfigError(`未知 Provider：${providerId}`, {
      hint: `可用：${Object.keys(config.providers.providers).join(', ')}`,
    });
  }

  const apiKey = secrets.get(providerId);
  if (!apiKey) {
    throw new ProviderError(`Provider "${providerId}" 未配置 API Key`, {
      hint: `设置环境变量 ${providerConfig.apiKeyEnv}，或在 config\\secrets.json 中配置`,
    });
  }

  const models = await listModels(providerConfig, apiKey, {
    retry: config.settings.retry,
  });

  console.log(`Provider：${providerId}（${providerConfig.type}）`);
  if (models.length === 0) {
    console.log('服务商未返回模型列表。');
    return 0;
  }

  console.log(`可用模型（${models.length}）：`);
  for (const model of models) {
    const display = model.displayName ? ` — ${model.displayName}` : '';
    const owner = model.ownedBy ? ` [${model.ownedBy}]` : '';
    console.log(`  ${model.id}${display}${owner}`);
  }

  return 0;
}

function listProviders(config: LoadedConfig, secrets: SecretStore): void {
  const defaultId = config.settings.defaultProvider ?? config.providers.default;

  console.log('Provider 列表：');
  for (const [id, provider] of Object.entries(config.providers.providers)) {
    const isDefault = id === defaultId ? '*' : ' ';
    const keyStatus = secrets.has(id) ? '已配置' : '缺失';
    console.log(
      `  ${isDefault} ${id.padEnd(14)} ${provider.type.padEnd(10)} ${provider.model.padEnd(28)} Key: ${keyStatus}`,
    );
  }
  console.log(`\n默认：${defaultId}`);
}

function runCheck(config: LoadedConfig, secrets: SecretStore): number {
  let ok = true;
  const defaultId = config.settings.defaultProvider ?? config.providers.default;

  console.log(`${PRODUCT_NAME} ${VERSION} 自检`);
  console.log(`  Agent 根目录：${config.root}`);
  console.log(`  配置目录：${config.paths.configDir}`);
  console.log(`  数据目录：${config.paths.dataDir}`);
  console.log(`  Node：${process.version}`);
  console.log(`  权限模式：${config.settings.permissionMode ?? 'default'}`);
  console.log(`  Shell：${config.settings.shell ?? defaultShellKind()}`);

  const tempDir = process.env.TEMP ?? '(未设置)';
  const tmpDir = process.env.TMP ?? '(未设置)';
  console.log(`  TEMP：${tempDir}`);
  console.log(`  TMP：${tmpDir}`);
  if (isOnCDrive(tempDir) || isOnCDrive(tmpDir)) {
    console.log('  ⚠ 临时目录位于 C 盘；请通过 agent.cmd 启动，启动器会重定向到 U 盘 data\\tmp');
  }

  const bundledNode = path.join(config.paths.runtimeDir, 'win-x64', 'node.exe');
  console.log(`  内置运行时：${fs.existsSync(bundledNode) ? '存在' : '未装配（开发环境可忽略）'}`);

  const ripgrep = path.join(config.paths.toolsDir, 'ripgrep', 'rg.exe');
  console.log(`  ripgrep：${fs.existsSync(ripgrep) ? '存在' : '未装配（Grep 将使用 JS 回退）'}`);

  for (const [id, provider] of Object.entries(config.providers.providers)) {
    const hasKey = secrets.has(id);
    const isDefault = id === defaultId;
    if (!hasKey && isDefault) ok = false;

    const status = hasKey
      ? 'Key 已配置'
      : isDefault
        ? 'Key 缺失（默认 Provider，必须配置）'
        : 'Key 缺失（非默认，可忽略）';
    console.log(`  Provider ${id}：${status}（环境变量 ${provider.apiKeyEnv}）`);
  }

  console.log(ok ? '\n结论：基础配置可用' : '\n结论：默认 Provider 缺少 Key，请先配置');
  return ok ? 0 : 1;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function reportError(error: unknown, redact: (text: string) => string): number {
  if (error instanceof ConfigError) {
    console.error(redact(`配置错误：${error.format()}`));
    return 2;
  }

  if (error instanceof ProviderError) {
    console.error(redact(`请求失败：${error.message}`));
    if (error.detail) console.error(redact(`详情：${error.detail.slice(0, 600)}`));
    if (error.hint) console.error(redact(`提示：${error.hint}`));
    return 1;
  }

  console.error(redact(`错误：${errorMessage(error)}`));
  return 1;
}

function isOnCDrive(value: string): boolean {
  if (!value) return false;
  return path.parse(value).root.toLowerCase() === 'c:\\';
}

function parsePermissionMode(value: string): PermissionMode {
  const found = PERMISSION_MODES.find((mode) => mode === value);
  if (!found) {
    throw new UsageError(`无效的权限模式：${value}（可选：${PERMISSION_MODES.join(', ')}）`);
  }
  return found;
}

function printHelp(): void {
  console.log(`${PRODUCT_NAME} ${VERSION} — 便携式 AI Agent

用法：
  agent.cmd                              启动交互式 TUI
  agent.cmd --plain                      行式交互（终端不支持 TUI 时自动回退）
  agent.cmd -p "你的问题"                 单次对话（headless）
  agent.cmd -p -                          从 stdin 读取提示词
  agent.cmd -c                            继续当前目录最近的会话（进入 TUI）
  agent.cmd -c -p "继续"                  继续会话并执行一次
  agent.cmd --resume <id> -p "继续"       恢复指定会话
  agent.cmd --provider deepseek           指定 Provider
  agent.cmd --model <name>                覆盖模型

权限：
  --permission-mode <mode>   default | acceptEdits | plan | bypass（默认 default）
  --allow "<规则>"           追加允许规则，可重复，例如 --allow "Bash(npm test:*)"
  --yes                     自动批准需要授权的操作（硬黑名单仍然拦截）

其他：
  --max-turns <n>           最多工具循环轮数（默认 8）
  --list-providers          查看已配置的 Provider
  --list-models             向当前 Provider 拉取模型列表
  --check                   检查配置、密钥与工具链
  --debug                   输出调试日志
  --version                 显示版本

TUI 快捷键：Ctrl+C 取消生成/退出，Ctrl+D 退出；审批时 a=本次允许，A=本项目始终允许，d=拒绝。`);
}

const isDirectRun =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`未处理错误：${errorMessage(error)}`);
      process.exitCode = 1;
    },
  );
}
