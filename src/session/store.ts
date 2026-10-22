import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AgentPaths } from '../bootstrap/paths.js';
import type { Message } from '../core/messages.js';
import { ConfigError } from '../util/errors.js';
import { canonicalPath, sha256Short } from '../util/fsx.js';
import type {
  CompactionInput,
  SessionRecord,
  SessionStartRecord,
  SessionSummary,
} from './types.js';

export interface CreateSessionOptions {
  cwd: string;
  providerId: string;
  model: string;
}

export interface SessionHandle {
  readonly id: string;
  readonly file: string;
  readonly records: readonly SessionRecord[];
  readonly corruptLines: number;
  appendMessage(message: Message): void;
  appendToolResult(toolUseId: string, name: string, content: string, isError: boolean): void;
  appendCompaction(input: CompactionInput): void;
  appendPermission(tool: string, behavior: 'allow' | 'deny', reason: string): void;
  close(reason: string): void;
}

class SessionHandleImpl implements SessionHandle {
  private readonly recordList: SessionRecord[];
  private closed = false;
  readonly corruptLines: number;

  constructor(
    readonly id: string,
    readonly file: string,
    records: SessionRecord[],
    corruptLines: number,
    private readonly paths: AgentPaths,
  ) {
    this.recordList = records;
    this.corruptLines = corruptLines;
  }

  get records(): readonly SessionRecord[] {
    return this.recordList;
  }

  appendMessage(message: Message): void {
    this.appendRecord({ type: 'message', message, ts: Date.now() });
  }

  appendToolResult(toolUseId: string, name: string, content: string, isError: boolean): void {
    this.appendRecord({
      type: 'tool_result',
      toolUseId,
      name,
      content,
      isError,
      ts: Date.now(),
    });
  }

  appendCompaction(input: CompactionInput): void {
    this.appendRecord({ type: 'compaction', ...input, ts: Date.now() });
  }

  appendPermission(tool: string, behavior: 'allow' | 'deny', reason: string): void {
    this.appendRecord({ type: 'permission', tool, behavior, reason, ts: Date.now() });
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.appendRecord({ type: 'session_end', reason, ts: Date.now() });
    this.writeSummary();
  }

  private appendRecord(record: SessionRecord): void {
    this.recordList.push(record);
    appendJsonLine(this.file, record);
  }

  private writeSummary(): void {
    const start = this.recordList.find(
      (record): record is SessionStartRecord => record.type === 'session_start',
    );
    if (!start) return;

    const summary: SessionSummary = {
      id: this.id,
      cwd: start.cwd,
      providerId: start.providerId,
      model: start.model,
      startedAt: start.startedAt,
      updatedAt: Date.now(),
      file: this.file,
      messageCount: this.recordList.filter((record) => record.type === 'message').length,
    };
    updateIndex(this.paths, summary);
  }
}

export class SessionStore {
  constructor(private readonly paths: AgentPaths) {
    fs.mkdirSync(paths.sessionsDir, { recursive: true });
  }

  create(options: CreateSessionOptions): SessionHandle {
    const dir = this.projectDir(options.cwd);
    fs.mkdirSync(dir, { recursive: true });

    const id = makeSessionId();
    const file = path.join(dir, `${id}.jsonl`);
    const start: SessionStartRecord = {
      type: 'session_start',
      id,
      cwd: options.cwd,
      providerId: options.providerId,
      model: options.model,
      startedAt: Date.now(),
    };

    appendJsonLine(file, start);
    return new SessionHandleImpl(id, file, [start], 0, this.paths);
  }

  loadLatest(cwd: string): SessionHandle | undefined {
    const dir = this.projectDir(cwd);
    if (!fs.existsSync(dir)) return undefined;

    const candidates = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => {
        const file = path.join(dir, entry.name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    const newest = candidates[0];
    if (!newest) return undefined;
    return this.loadFileAsHandle(newest.file);
  }

  load(idOrPrefix: string): SessionHandle | undefined {
    const sanitized = idOrPrefix.trim();
    if (!/^[A-Za-z0-9-]{1,80}$/.test(sanitized)) {
      throw new ConfigError(`会话 ID 格式无效：${idOrPrefix}`);
    }

    const matches: string[] = [];

    for (const entry of fs.readdirSync(this.paths.sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.paths.sessionsDir, entry.name);

      for (const fileEntry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;
        const id = fileEntry.name.slice(0, -'.jsonl'.length);
        if (id === sanitized || id.startsWith(sanitized)) {
          matches.push(path.join(dir, fileEntry.name));
        }
      }
    }

    if (matches.length === 0) return undefined;
    if (matches.length > 1) {
      const exact = matches.filter((file) => path.basename(file, '.jsonl') === sanitized);
      if (exact.length === 1) {
        const file = exact[0];
        return file ? this.loadFileAsHandle(file) : undefined;
      }
      throw new ConfigError(`会话 ID ${sanitized} 匹配到多个会话，请提供更完整的 ID`);
    }

    const only = matches[0];
    return only ? this.loadFileAsHandle(only) : undefined;
  }

  private loadFileAsHandle(file: string): SessionHandle {
    const loaded = this.loadFile(file);
    return new SessionHandleImpl(loaded.id, file, loaded.records, loaded.corruptLines, this.paths);
  }

  private loadFile(file: string): {
    id: string;
    records: SessionRecord[];
    corruptLines: number;
  } {
    const text = fs.readFileSync(file, 'utf8');
    const records: SessionRecord[] = [];
    let corruptLines = 0;

    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isSessionRecord(parsed)) {
          records.push(parsed);
        } else {
          corruptLines += 1;
        }
      } catch {
        // 崩溃/拔盘可能留下半行，忽略并计数
        corruptLines += 1;
      }
    }

    return {
      id: path.basename(file, '.jsonl'),
      records,
      corruptLines,
    };
  }

  private projectDir(cwd: string): string {
    const canonical = canonicalPath(cwd);
    const base =
      path
        .basename(canonical)
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 40) || 'root';

    return path.join(this.paths.sessionsDir, `${base}-${sha256Short(canonical, 12)}`);
  }
}

function appendJsonLine(file: string, record: SessionRecord): void {
  const line = `${JSON.stringify(record)}\n`;
  const fd = fs.openSync(file, 'a');

  try {
    fs.writeSync(fd, line);
    // 便携场景最怕热拔/断电，逐条 fsync 换取可恢复性
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function updateIndex(paths: AgentPaths, summary: SessionSummary): void {
  const file = path.join(paths.sessionsDir, 'index.json');
  let entries: SessionSummary[] = [];

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (Array.isArray(parsed)) {
      entries = parsed.filter(isSessionSummary);
    }
  } catch {
    entries = [];
  }

  const existingIndex = entries.findIndex((entry) => entry.id === summary.id);
  if (existingIndex >= 0) {
    entries[existingIndex] = summary;
  } else {
    entries.unshift(summary);
  }

  fs.writeFileSync(file, JSON.stringify(entries.slice(0, 500), null, 2), 'utf8');
}

function makeSessionId(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const random = crypto.randomBytes(3).toString('hex');
  return `${stamp}-${random}`;
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'session_start' ||
    type === 'message' ||
    type === 'tool_result' ||
    type === 'permission' ||
    type === 'compaction' ||
    type === 'session_end'
  );
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.file === 'string';
}
