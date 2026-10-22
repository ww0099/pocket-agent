import { describe, expect, it } from 'vitest';

import { ApprovalBroker } from '../src/ui/approval.js';

describe('ApprovalBroker', () => {
  it('把审批请求暴露给 UI，并在响应后恢复执行', async () => {
    const broker = new ApprovalBroker();
    let notified = 0;
    const unsubscribe = broker.subscribe(() => {
      notified += 1;
    });

    const pending = broker.ask(
      {
        tool: 'Bash',
        input: { command: 'npm test' },
        isReadOnly: false,
        isDestructive: false,
      },
      '需要确认',
    );

    expect(broker.getSnapshot()).toMatchObject({
      request: { tool: 'Bash' },
      reason: '需要确认',
    });

    broker.respond(true);
    await expect(pending).resolves.toBe(true);
    expect(broker.getSnapshot()).toBeNull();
    expect(notified).toBeGreaterThanOrEqual(2);

    unsubscribe();
  });

  it('cancelAll 默认拒绝', async () => {
    const broker = new ApprovalBroker();
    const pending = broker.ask(
      { tool: 'Edit', input: {}, isReadOnly: false, isDestructive: true },
      '需要确认',
    );

    broker.cancelAll();
    await expect(pending).resolves.toBe(false);
  });
});
