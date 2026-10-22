import type { Message } from '../core/messages.js';

export interface SessionStartRecord {
  type: 'session_start';
  id: string;
  cwd: string;
  providerId: string;
  model: string;
  startedAt: number;
}

export interface MessageRecord {
  type: 'message';
  message: Message;
  ts: number;
}

export interface ToolResultRecord {
  type: 'tool_result';
  toolUseId: string;
  name: string;
  content: string;
  isError: boolean;
  ts: number;
}

export interface PermissionRecord {
  type: 'permission';
  tool: string;
  behavior: 'allow' | 'deny';
  reason: string;
  ts: number;
}

export interface CompactionInput {
  summary: string;
  summaryMessage: Message;
  keptMessages: Message[];
  beforeTokens: number;
  afterTokens: number;
  omittedMessages: number;
}

export interface CompactionRecord extends CompactionInput {
  type: 'compaction';
  ts: number;
}

export interface SessionEndRecord {
  type: 'session_end';
  reason: string;
  ts: number;
}

export type SessionRecord =
  | SessionStartRecord
  | MessageRecord
  | ToolResultRecord
  | PermissionRecord
  | CompactionRecord
  | SessionEndRecord;

export interface SessionSummary {
  id: string;
  cwd: string;
  providerId: string;
  model: string;
  startedAt: number;
  updatedAt: number;
  file: string;
  messageCount: number;
}
