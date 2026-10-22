export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** 对输出做脱敏（例如把 API Key 替换为 ***）。 */
  redact?: (text: string) => string;
  /** 输出目标，默认 stderr。 */
  write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_WEIGHT[options.level ?? 'warn'];
  const redact = options.redact ?? ((text: string) => text);
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));

  const emit = (level: LogLevel, message: string): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;
    write(`[${level}] ${redact(message)}`);
  };

  return {
    debug: (message) => emit('debug', message),
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
