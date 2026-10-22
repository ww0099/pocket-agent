import { describe, expect, it } from 'vitest';

import { UsageError, parseArgs } from '../src/cli/main.js';

describe('parseArgs', () => {
  it('解析 -p 提示词', () => {
    expect(parseArgs(['-p', 'hello'])).toMatchObject({
      command: 'run',
      prompt: 'hello',
      debug: false,
    });
  });

  it('解析 Provider、模型与调试开关', () => {
    expect(
      parseArgs(['--provider', 'deepseek', '--model', 'deepseek-chat', '-p', 'hi', '--debug']),
    ).toMatchObject({
      command: 'run',
      prompt: 'hi',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      debug: true,
    });
  });

  it('支持位置参数作为提示词', () => {
    expect(parseArgs(['解释这个仓库'])).toMatchObject({ prompt: '解释这个仓库' });
  });

  it('版本与帮助优先', () => {
    expect(parseArgs(['--version']).command).toBe('version');
    expect(parseArgs(['-h']).command).toBe('help');
  });

  it('解析会话、权限与循环参数', () => {
    expect(
      parseArgs([
        '--continue',
        '--permission-mode',
        'acceptEdits',
        '--allow',
        'Bash(npm test:*)',
        '--yes',
        '--max-turns',
        '12',
        '-p',
        'go',
      ]),
    ).toMatchObject({
      continueSession: true,
      permissionMode: 'acceptEdits',
      allowRules: ['Bash(npm test:*)'],
      yes: true,
      maxTurns: 12,
      prompt: 'go',
    });

    expect(parseArgs(['--resume', '20261022-120000-abcd', '-p', 'go'])).toMatchObject({
      resumeId: '20261022-120000-abcd',
    });

    expect(parseArgs(['--plain'])).toMatchObject({ plain: true });
    expect(parseArgs(['--list-models']).command).toBe('list-models');
  });

  it('缺少参数或未知参数时报错', () => {
    expect(() => parseArgs(['--print'])).toThrowError(UsageError);
    expect(() => parseArgs(['--nope'])).toThrowError(UsageError);
    expect(() => parseArgs(['a', 'b'])).toThrowError(UsageError);
    expect(() => parseArgs(['--permission-mode', 'nope'])).toThrowError(UsageError);
    expect(() => parseArgs(['--max-turns', '0'])).toThrowError(UsageError);
    expect(() => parseArgs(['--resume'])).toThrowError(UsageError);
  });
});
