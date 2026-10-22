import { render } from 'ink';
import React from 'react';

import type { SessionRuntime } from '../../runtime/session-runtime.js';
import type { ApprovalBroker } from '../approval.js';
import { App } from './App.js';

export async function startTui(runtime: SessionRuntime, broker: ApprovalBroker): Promise<number> {
  const instance = render(<App runtime={runtime} broker={broker} />, {
    exitOnCtrlC: false,
  });

  await instance.waitUntilExit();
  broker.cancelAll();
  return 0;
}
