import path from 'node:path';

import type { LoadedConfig } from '../bootstrap/config.js';
import type { SecretStore } from '../bootstrap/secrets.js';
import { type CompactionInfo, ContextManager } from '../core/context-manager.js';
import type { AgentEvent } from '../core/events.js';
import { runAgent } from '../core/loop.js';
import type { ToolExecutor } from '../core/loop.js';
import { type Message, type Usage, userText } from '../core/messages.js';
import { buildSystemPrompt } from '../core/system-prompt.js';
import { formatAgentIndex, loadAgents } from '../extensions/agents.js';
import { expandCommand, formatCommandIndex, loadCommands } from '../extensions/commands.js';
import { loadHooks } from '../extensions/hooks.js';
import { type McpConnection, connectMcpServers } from '../extensions/mcp/client.js';
import { loadMcpConfig } from '../extensions/mcp/config.js';
import { formatSkillIndex, loadSkills } from '../extensions/skills.js';
import { loadMemory, loadProjectInstructions } from '../memory/loader.js';
import { loadPermissions } from '../permissions/config.js';
import { type AskHandler, PermissionGate } from '../permissions/gate.js';
import { loadProjectPermissions } from '../permissions/project.js';
import {
  type PermissionMode,
  type PermissionRule,
  parseRule,
  parseRules,
} from '../permissions/rules.js';
import { type ModelInfo, listModels } from '../providers/models.js';
import { createProvider } from '../providers/registry.js';
import type { Provider } from '../providers/types.js';
import { recordsToMessages } from '../session/records.js';
import { type SessionHandle, SessionStore } from '../session/store.js';
import type { TodoItem, ToolContext } from '../tools/base.js';
import { createToolExecutor } from '../tools/executor.js';
import { createCoreTools } from '../tools/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { ConfigError, ProviderError, errorMessage } from '../util/errors.js';
import { canonicalPath } from '../util/fsx.js';
import type { Logger } from '../util/log.js';
import { defaultShellKind, isShellKind } from '../util/shell.js';

export interface SessionRuntimeOptions {
  config: LoadedConfig;
  secrets: SecretStore;
  provider: Provider;
  providerId: string;
  logger: Logger;
  debug?: boolean;
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  allowRules?: string[];
  maxTurns?: number;
  resumeId?: string;
  continueSession?: boolean;
  yes?: boolean;
  ask?: AskHandler;
}

/**
 * 把一个会话所需的全部状态收拢在一起：
 * Provider、权限门、工具注册表、会话文件与执行器。
 * headless、plain 与 TUI 共用同一条运行路径。
 */
export class SessionRuntime {
  readonly config: LoadedConfig;
  readonly secrets: SecretStore;
  readonly cwd: string;
  readonly logger: Logger;
  readonly store: SessionStore;
  readonly registry: ToolRegistry;
  readonly gate: PermissionGate;
  readonly context: ToolContext;
  readonly executor: ToolExecutor;
  readonly maxTurns: number;
  readonly debug: boolean;

  private providerInstance: Provider;
  private providerIdValue: string;
  private modelOverride: string | undefined;
  private sessionHandle: SessionHandle;
  private readonly rules: PermissionRule[];
  private readonly usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private costTotal = 0;
  private extensionsReady = false;
  private mcpConnections: McpConnection[] = [];

  constructor(options: SessionRuntimeOptions) {
    this.config = options.config;
    this.secrets = options.secrets;
    this.cwd = options.cwd ?? process.cwd();
    this.logger = options.logger;
    this.debug = options.debug ?? false;
    this.providerInstance = options.provider;
    this.providerIdValue = options.providerId;
    this.modelOverride = options.model;
    this.maxTurns = options.maxTurns ?? 8;

    const mode = options.permissionMode ?? this.config.settings.permissionMode ?? 'default';
    const merged = mergePermissions(
      loadPermissions(this.config.paths.configDir),
      loadProjectPermissions(this.cwd),
    );

    this.rules = [
      ...parseRules(merged.allow, 'allow', 'project'),
      ...parseRules(merged.deny, 'deny', 'project'),
      ...(options.allowRules ?? []).map((rule) => parseRule(rule, 'allow', 'cli')),
    ];

    this.gate = new PermissionGate({
      mode,
      rules: this.rules,
      cwd: this.cwd,
      ask: options.ask ?? createHeadlessAsk(options.yes ?? false, this.logger),
    });

    const roots = buildRoots(this.cwd, merged.additionalDirectories);
    const shell =
      this.config.settings.shell && isShellKind(this.config.settings.shell)
        ? this.config.settings.shell
        : defaultShellKind();

    const todos: TodoItem[] = [];
    this.context = {
      agentRoot: this.config.root,
      cwd: this.cwd,
      roots,
      sessionId: '',
      signal: new AbortController().signal,
      logger: this.logger,
      readFiles: new Map(),
      modifiedFiles: new Set(),
      todos,
      limits: this.config.settings.limits,
      shell,
      paths: this.config.paths,
    };

    this.registry = new ToolRegistry(createCoreTools());
    this.context.provider = this.providerInstance;
    this.context.registry = this.registry;
    this.context.permissionGate = this.gate;
    this.context.subagentDepth = 0;
    this.context.hooks = loadHooks(this.config.root, this.cwd);

    this.executor = createToolExecutor({
      registry: this.registry,
      context: this.context,
      gate: this.gate,
      onPermissionDecision: (decision) => {
        this.sessionHandle.appendPermission(decision.tool, decision.behavior, decision.reason);
      },
    });
    this.store = new SessionStore(this.config.paths);
    this.sessionHandle = this.resolveSession(options);
    this.context.sessionId = this.sessionHandle.id;
  }

  get session(): SessionHandle {
    return this.sessionHandle;
  }

  get provider(): Provider {
    return this.providerInstance;
  }

  get providerId(): string {
    return this.providerIdValue;
  }

  get model(): string {
    return this.modelOverride ?? this.providerInstance.model;
  }

  get modelOverrideValue(): string | undefined {
    return this.modelOverride;
  }

  get permissionMode(): PermissionMode {
    return this.gate.getMode();
  }

  get permissionRules(): readonly PermissionRule[] {
    return this.rules;
  }

  history(): Message[] {
    return recordsToMessages(this.sessionHandle.records);
  }

  getUsage(): { input: number; output: number; cacheRead: number; cacheWrite: number } {
    return { ...this.usageTotals };
  }

  formatUsage(): string {
    const pricing = this.currentPricing();
    const cost =
      pricing && (pricing.inputPerMillion > 0 || pricing.outputPerMillion > 0)
        ? `${pricing.currency} ${this.costTotal.toFixed(4)}`
        : '未配置单价（仅统计 token；可在 providers.json 的 pricing 中填写）';

    return [
      `输入 tokens：${this.usageTotals.input}`,
      `输出 tokens：${this.usageTotals.output}`,
      `缓存读取：${this.usageTotals.cacheRead}`,
      `缓存写入：${this.usageTotals.cacheWrite}`,
      `估算费用：${cost}`,
    ].join('\n');
  }

  async listModels(): Promise<ModelInfo[]> {
    const providerConfig = this.config.providers.providers[this.providerIdValue];
    if (!providerConfig) {
      throw new ConfigError(`未知 Provider：${this.providerIdValue}`);
    }

    const apiKey = this.secrets.get(this.providerIdValue);
    if (!apiKey) {
      throw new ProviderError(`Provider "${this.providerIdValue}" 未配置 API Key`, {
        hint: `设置环境变量 ${providerConfig.apiKeyEnv}，或在 config\\secrets.json 中配置`,
      });
    }

    return listModels(providerConfig, apiKey, { retry: this.config.settings.retry });
  }

  async compactNow(signal?: AbortSignal): Promise<CompactionInfo | undefined> {
    const history = this.history();
    if (history.length <= 2) return undefined;

    const manager = new ContextManager({
      provider: this.providerInstance,
      system: this.buildPrompt(),
      logger: this.logger,
      getReinjection: () => this.reinjectionText(),
    });

    const result = await manager.force(history, signal ?? new AbortController().signal);
    if (!result.compaction) return undefined;

    this.sessionHandle.appendCompaction(result.compaction);
    return result.compaction;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.gate.setMode(mode);
  }

  setModel(model?: string): void {
    this.modelOverride = model?.trim() || undefined;
  }

  switchProvider(id: string): void {
    const providerConfig = this.config.providers.providers[id];
    if (!providerConfig) {
      throw new ConfigError(`未知 Provider：${id}`, {
        hint: `可用：${Object.keys(this.config.providers.providers).join(', ')}`,
      });
    }

    this.providerInstance = createProvider(
      id,
      providerConfig,
      { apiKey: this.secrets.get(id) },
      this.config.settings.retry,
    );
    this.providerIdValue = id;
    this.modelOverride = undefined;
    this.context.provider = this.providerInstance;
  }

  expandCustomCommand(input: string): string | undefined {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return undefined;

    const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (!match) return undefined;

    const name = match[1];
    if (!name) return undefined;

    const commands = loadCommands(this.config.root, this.cwd);
    const command = commands.find((candidate) => candidate.name === name);
    if (!command) return undefined;

    return expandCommand(command, match[2] ?? '');
  }

  addAllowRule(raw: string): PermissionRule {
    const rule = parseRule(raw, 'allow', 'project');
    if (
      !this.rules.some((existing) => existing.raw === rule.raw && existing.behavior === 'allow')
    ) {
      this.rules.push(rule);
    }
    return rule;
  }

  newSession(): SessionHandle {
    try {
      this.sessionHandle.close('clear');
    } catch {
      // 旧会话已关闭或文件不可写时不阻塞新会话
    }

    this.sessionHandle = this.store.create({
      cwd: this.cwd,
      providerId: this.providerIdValue,
      model: this.model,
    });
    this.context.sessionId = this.sessionHandle.id;
    this.context.readFiles.clear();
    this.context.modifiedFiles.clear();
    this.context.todos.splice(0, this.context.todos.length);
    return this.sessionHandle;
  }

  async *runTurn(prompt: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const effectivePrompt = this.expandCustomCommand(prompt) ?? prompt;
    const history = recordsToMessages(this.sessionHandle.records);
    const user = userText(effectivePrompt);
    this.sessionHandle.appendMessage(user);
    const messages = [...history, user];

    await this.ensureExtensions();
    const system = this.buildPrompt();

    const contextManager = new ContextManager({
      provider: this.providerInstance,
      system,
      logger: this.logger,
      getReinjection: () => this.reinjectionText(),
    });

    for await (const event of runAgent({
      provider: this.providerInstance,
      system,
      messages,
      tools: this.registry.schemas(),
      model: this.modelOverride,
      maxTurns: this.maxTurns,
      signal,
      executeTools: this.executor,
      prepareMessages: async (currentMessages) => {
        const prepared = await contextManager.prepare(currentMessages, signal);
        if (!prepared.compaction) {
          return { messages: prepared.messages };
        }

        this.sessionHandle.appendCompaction(prepared.compaction);
        return {
          messages: prepared.messages,
          compaction: {
            summary: prepared.compaction.summary,
            omittedMessages: prepared.compaction.omittedMessages,
            keptMessageCount: prepared.compaction.keptMessages.length,
            beforeTokens: prepared.compaction.beforeTokens,
            afterTokens: prepared.compaction.afterTokens,
          },
        };
      },
    })) {
      if (event.type === 'turn_end') {
        this.sessionHandle.appendMessage(event.message);
      } else if (event.type === 'tool_result') {
        this.sessionHandle.appendToolResult(
          event.result.id,
          event.result.name,
          event.result.output,
          event.result.isError,
        );
      } else if (event.type === 'usage') {
        this.recordUsage(event.usage);
      }
      yield event;
    }
  }

  close(reason: string): void {
    try {
      this.sessionHandle.close(reason);
    } catch {
      // 关闭失败不应遮蔽原始错误
    }

    for (const connection of this.mcpConnections) {
      void connection.client.close().catch((error: unknown) => {
        this.logger.warn(`关闭 MCP "${connection.name}" 失败：${errorMessage(error)}`);
      });
    }
    this.mcpConnections = [];
  }

  private async ensureExtensions(): Promise<void> {
    if (this.extensionsReady) return;
    this.extensionsReady = true;

    const configs = loadMcpConfig(this.config.root, this.cwd);
    if (configs.length === 0) return;

    const { tools, connections } = await connectMcpServers(configs, this.logger);
    this.mcpConnections = connections;

    for (const tool of tools) {
      if (!this.registry.get(tool.name)) {
        this.registry.register(tool);
      }
    }

    if (tools.length > 0) {
      this.logger.debug(`已加载 ${tools.length} 个 MCP 工具`);
    }
  }

  private buildPrompt(): string {
    const memory = loadMemory(this.config.root, this.cwd);
    const instructions = loadProjectInstructions(this.cwd);
    const skills = loadSkills(this.config.root, this.cwd);
    const agents = loadAgents(this.config.root, this.cwd);
    const commands = loadCommands(this.config.root, this.cwd);

    return buildSystemPrompt(
      this.cwd,
      this.registry.list().map((tool) => tool.name),
      this.gate.getMode(),
      {
        instructions: instructions.text || undefined,
        memory: memory.text || undefined,
        skills: formatSkillIndex(skills) || undefined,
        agents: formatAgentIndex(agents) || undefined,
        commands: formatCommandIndex(commands) || undefined,
      },
    );
  }

  private reinjectionText(): string {
    const modified = [...this.context.modifiedFiles]
      .map((file) => {
        const relative = path.relative(this.cwd, file);
        return relative && !relative.startsWith('..') ? relative : file;
      })
      .slice(0, 20);

    const todos = this.context.todos.slice(0, 20).map((todo) => `[${todo.status}] ${todo.content}`);

    return [
      `- 工作目录：${this.cwd}`,
      `- 权限模式：${this.permissionMode}`,
      `- Provider / 模型：${this.providerId} / ${this.model}`,
      `- 已修改文件：${modified.length > 0 ? modified.join(', ') : '（无）'}`,
      `- 待办：${todos.length > 0 ? todos.join('；') : '（无）'}`,
    ].join('\n');
  }

  private recordUsage(usage: Usage): void {
    this.usageTotals.input += usage.inputTokens;
    this.usageTotals.output += usage.outputTokens;
    this.usageTotals.cacheRead += usage.cacheReadTokens ?? 0;
    this.usageTotals.cacheWrite += usage.cacheWriteTokens ?? 0;

    const pricing = this.currentPricing();
    if (!pricing) return;

    const cacheReadPrice = pricing.cacheReadPerMillion ?? pricing.inputPerMillion;
    const cacheWritePrice = pricing.cacheWritePerMillion ?? pricing.inputPerMillion;

    this.costTotal +=
      (usage.inputTokens * pricing.inputPerMillion +
        usage.outputTokens * pricing.outputPerMillion +
        (usage.cacheReadTokens ?? 0) * cacheReadPrice +
        (usage.cacheWriteTokens ?? 0) * cacheWritePrice) /
      1_000_000;
  }

  private currentPricing() {
    return this.config.providers.providers[this.providerIdValue]?.pricing;
  }

  private resolveSession(options: SessionRuntimeOptions): SessionHandle {
    if (options.resumeId) {
      const session = this.store.load(options.resumeId);
      if (!session) {
        throw new ConfigError(`找不到会话：${options.resumeId}`, {
          hint: '可用 --continue 恢复当前目录最近的会话',
        });
      }
      return session;
    }

    if (options.continueSession) {
      const session = this.store.loadLatest(this.cwd);
      if (!session) {
        throw new ConfigError('当前目录没有可恢复的会话');
      }
      return session;
    }

    return this.store.create({
      cwd: this.cwd,
      providerId: this.providerIdValue,
      model: this.model,
    });
  }
}

function mergePermissions(
  base: { allow: string[]; deny: string[]; additionalDirectories: string[] },
  project: { allow: string[]; deny: string[]; additionalDirectories: string[] },
) {
  return {
    allow: [...new Set([...base.allow, ...project.allow])],
    deny: [...new Set([...base.deny, ...project.deny])],
    additionalDirectories: [
      ...new Set([...base.additionalDirectories, ...project.additionalDirectories]),
    ],
  };
}

function buildRoots(cwd: string, additionalDirectories: string[]): string[] {
  const roots = new Set<string>([canonicalPath(cwd)]);
  for (const dir of additionalDirectories) {
    roots.add(canonicalPath(path.resolve(cwd, dir)));
  }
  return [...roots];
}

function createHeadlessAsk(yes: boolean, logger: Logger): AskHandler {
  return async (request, reason) => {
    if (yes) {
      logger.warn(`已自动授权（--yes）：${request.tool} — ${reason}`);
      return true;
    }

    logger.warn(
      `已拒绝需要授权的操作：${request.tool} — ${reason}\n可在 config\\permissions.json 或项目 .agent\\permissions.json 添加 allow 规则，或使用 --yes。`,
    );
    return false;
  };
}
