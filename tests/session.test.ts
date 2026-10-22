import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensureRuntimeDirs, getPaths } from '../src/bootstrap/paths.js';
import { userText } from '../src/core/messages.js';
import { recordsToMessages } from '../src/session/records.js';
import { SessionStore } from '../src/session/store.js';
import { makeTempDir } from './helpers/index.js';

function setup(): {
  root: string;
  paths: ReturnType<typeof getPaths>;
  store: SessionStore;
} {
  const root = makeTempDir('session');
  const paths = getPaths(root);
  ensureRuntimeDirs(paths);
  return { root, paths, store: new SessionStore(paths) };
}

describe('SessionStore', () => {
  it('创建、追加、关闭并恢复会话', () => {
    const { root, paths, store } = setup();
    const session = store.create({ cwd: root, providerId: 'mock', model: 'mock-model' });

    session.appendMessage(userText('hi'));
    session.appendToolResult('t1', 'Read', 'ok', false);
    session.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    });
    session.close('exit');

    const lines = fs.readFileSync(session.file, 'utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(5);
    expect(fs.existsSync(path.join(paths.sessionsDir, 'index.json'))).toBe(true);

    const restored = new SessionStore(paths).loadLatest(root);
    expect(restored?.id).toBe(session.id);

    const messages = recordsToMessages(restored?.records ?? []);
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }],
    });
  });

  it('损坏尾行被忽略并计数', () => {
    const { root, store } = setup();
    const session = store.create({ cwd: root, providerId: 'mock', model: 'm' });
    session.appendMessage(userText('hi'));
    session.close('exit');

    fs.appendFileSync(session.file, 'not-json\n', 'utf8');

    const restored = store.load(session.id);
    expect(restored?.corruptLines).toBe(1);
  });

  it('支持按 ID 前缀恢复', () => {
    const { root, store } = setup();
    const session = store.create({ cwd: root, providerId: 'mock', model: 'm' });
    session.close('exit');

    const prefix = session.id.slice(0, 17);
    expect(store.load(prefix)?.id).toBe(session.id);
  });

  it('找不到会话时返回 undefined', () => {
    const { store } = setup();
    expect(store.load('20990101-000000-nope')).toBeUndefined();
  });

  it('不同会话目录互不干扰', () => {
    const { root, store } = setup();
    const otherRoot = makeTempDir('session-other');

    const first = store.create({ cwd: root, providerId: 'mock', model: 'm' });
    first.close('exit');
    const second = store.create({ cwd: otherRoot, providerId: 'mock', model: 'm' });
    second.close('exit');

    expect(store.loadLatest(root)?.id).toBe(first.id);
    expect(store.loadLatest(otherRoot)?.id).toBe(second.id);
  });
});
