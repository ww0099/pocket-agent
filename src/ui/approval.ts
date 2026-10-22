import type { AskHandler, PermissionRequest } from '../permissions/gate.js';

export interface ApprovalEntry {
  id: number;
  request: PermissionRequest;
  reason: string;
}

type Listener = () => void;

/**
 * 把工具执行器中的异步审批请求桥接给 UI。
 * agentLoop 会在等待审批时暂停，UI 通过 respond() 恢复执行。
 */
export class ApprovalBroker {
  private nextId = 1;
  private pending: ApprovalEntry | null = null;
  private resolver: ((approved: boolean) => void) | null = null;
  private readonly listeners = new Set<Listener>();

  readonly ask: AskHandler = async (request, reason) => {
    return new Promise<boolean>((resolve) => {
      this.pending = { id: this.nextId, request, reason };
      this.nextId += 1;
      this.resolver = resolve;
      this.emit();
    });
  };

  readonly getSnapshot = (): ApprovalEntry | null => this.pending;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  respond(approved: boolean): void {
    const resolver = this.resolver;
    this.pending = null;
    this.resolver = null;
    this.emit();
    resolver?.(approved);
  }

  cancelAll(): void {
    this.respond(false);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
