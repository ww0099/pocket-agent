export interface AgentErrorOptions {
  cause?: unknown;
  hint?: string;
}

export class AgentError extends Error {
  readonly hint?: string;

  constructor(message: string, options: AgentErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.hint = options.hint;
  }
}

export class ConfigError extends AgentError {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;

  constructor(
    message: string,
    options: AgentErrorOptions & { file?: string; line?: number; column?: number } = {},
  ) {
    super(message, options);
    this.file = options.file;
    this.line = options.line;
    this.column = options.column;
  }

  format(): string {
    const location = this.file
      ? `${this.file}${this.line ? `:${this.line}${this.column ? `:${this.column}` : ''}` : ''}`
      : undefined;
    const head = location ? `${location} — ${this.message}` : this.message;
    return this.hint ? `${head}\n提示：${this.hint}` : head;
  }
}

export class ProviderError extends AgentError {
  readonly status?: number;
  readonly retryable: boolean;
  readonly detail?: string;

  constructor(
    message: string,
    options: AgentErrorOptions & { status?: number; retryable?: boolean; detail?: string } = {},
  ) {
    super(message, options);
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
