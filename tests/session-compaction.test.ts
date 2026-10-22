import { describe, expect, it } from 'vitest';

import { ensureRuntimeDirs, getPaths } from '../src/bootstrap/paths.js';
import { userText } from '../src/core/messages.js';
import { recordsToMessages } from '../src/session/records.js';
import { SessionStore } from '../src/session/store.js';
import { makeTempDir } from './helpers/index.js';

function setup() {
  const root = makeTempDir('session-compaction');
  const paths = getPaths(root);
  ensureRuntimeDirs(paths);
  return { root, paths, store: new SessionStore(paths) };
}

describe('session compaction records', () => {
  it('恢复时用摘要与保留消息替换更早历史', () => {
    const { root, paths, store } = setup();
    const session = store.create({ cwd: root, providerId: 'stub', model: 'stub' });

    session.appendMessage(userText('old message'));
    session.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'old answer' }],
    });

    const summaryMessage = userText('[摘要] earlier conversation');
    session.appendCompaction({
      summary: 'earlier conversation',
      summaryMessage,
      keptMessages: [userText('recent message')],
      beforeTokens: 10_000,
      afterTokens: 500,
      omittedMessages: 2,
    });

    session.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'after compaction' }],
    });
    session.close('exit');

    const restored = new SessionStore(paths).loadLatest(root);
    expect(restored).toBeDefined();

    const messages = recordsToMessages(restored?.records ?? []);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('earlier conversation'),
    });
    expect(messages[1]?.content[0]).toMatchObject({ type: 'text', text: 'recent message' });
    expect(messages[2]?.content[0]).toMatchObject({ type: 'text', text: 'after compaction' });
  });
});
