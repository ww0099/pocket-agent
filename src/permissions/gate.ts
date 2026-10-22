import type { PermissionMode, PermissionRule } from './rules.js';
import { ruleMatches } from './rules.js';

export interface PermissionRequest {
  tool: string;
  input: unknown;
  isReadOnly: boolean;
  isDestructive: boolean;
}

export interface PermissionOutcome {
  behavior: 'allow' | 'deny';
  reason: string;
}

export type AskHandler = (request: PermissionRequest, reason: string) => Promise<boolean>;

export interface PermissionGateOptions {
  mode: PermissionMode;
  rules: PermissionRule[];
  cwd: string;
  ask: AskHandler;
}

/**
 * 决策顺序（先命中先返回）：
 * 1. bypass → allow（硬黑名单在工具内部仍然执行）
 * 2. plan → 只读放行，其余拒绝
 * 3. deny 规则
 * 4. allow 规则
 * 5. 只读工具默认放行
 * 6. acceptEdits 下 Edit/Write 放行
 * 7. 其余询问；无交互时由 ask 处理器拒绝
 */
export class PermissionGate {
  constructor(private readonly options: PermissionGateOptions) {}

  setMode(mode: PermissionMode): void {
    this.options.mode = mode;
  }

  getMode(): PermissionMode {
    return this.options.mode;
  }

  async decide(request: PermissionRequest): Promise<PermissionOutcome> {
    if (this.options.mode === 'bypass') {
      return { behavior: 'allow', reason: 'bypass 模式' };
    }

    if (this.options.mode === 'plan') {
      return request.isReadOnly
        ? { behavior: 'allow', reason: 'plan 模式允许只读操作' }
        : { behavior: 'deny', reason: 'plan 模式禁止修改或执行命令' };
    }

    const context = { tool: request.tool, input: request.input, cwd: this.options.cwd };

    const denyRule = this.options.rules.find(
      (rule) => rule.behavior === 'deny' && ruleMatches(rule, context),
    );
    if (denyRule) {
      return { behavior: 'deny', reason: `命中拒绝规则 ${denyRule.raw}` };
    }

    const allowRule = this.options.rules.find(
      (rule) => rule.behavior === 'allow' && ruleMatches(rule, context),
    );
    if (allowRule) {
      return { behavior: 'allow', reason: `命中允许规则 ${allowRule.raw}` };
    }

    if (request.isReadOnly) {
      return { behavior: 'allow', reason: '只读工具默认允许' };
    }

    if (
      this.options.mode === 'acceptEdits' &&
      (request.tool === 'Write' || request.tool === 'Edit')
    ) {
      return { behavior: 'allow', reason: 'acceptEdits 模式允许文件修改' };
    }

    const reason = request.isDestructive ? '该操作具有破坏性，需要确认' : '该操作需要授权';

    const approved = await this.options.ask(request, reason);
    return approved ? { behavior: 'allow', reason: '用户已授权' } : { behavior: 'deny', reason };
  }
}
