import { describe, expect, it } from 'vitest';

import { PermissionGate } from '../src/permissions/gate.js';
import {
  matchCommand,
  matchPath,
  parseRule,
  parseRules,
  ruleMatches,
} from '../src/permissions/rules.js';

describe('permission rules', () => {
  it('解析 Tool 与 Tool(matcher) 两种形式', () => {
    const plain = parseRule('Read', 'allow');
    expect(plain.tool).toBe('Read');
    expect(plain.matcher).toBeUndefined();

    expect(parseRule('Bash(git status:*)', 'allow')).toMatchObject({
      tool: 'Bash',
      matcher: 'git status:*',
    });
  });

  it('Bash 规则支持前缀与精确匹配', () => {
    expect(matchCommand('git status:*', 'git status --short')).toBe(true);
    expect(matchCommand('npm run *', 'npm run build')).toBe(true);
    expect(matchCommand('ls', 'ls -la')).toBe(false);
    expect(matchCommand('ls', 'ls')).toBe(true);
  });

  it('路径规则匹配根目录与子目录下的文件', () => {
    const cwd = process.cwd();

    expect(matchPath('**/.env', '.env', cwd)).toBe(true);
    expect(matchPath('**/.env', 'sub/.env', cwd)).toBe(true);
    expect(matchPath('src/**/*.ts', 'src/a.ts', cwd)).toBe(true);
    expect(matchPath('src/**/*.ts', 'test/a.ts', cwd)).toBe(false);
  });

  it('规则按工具与输入共同匹配', () => {
    const rule = parseRule('Bash(git status:*)', 'allow');

    expect(
      ruleMatches(rule, {
        tool: 'Bash',
        input: { command: 'git status --short' },
        cwd: process.cwd(),
      }),
    ).toBe(true);
    expect(
      ruleMatches(rule, {
        tool: 'Bash',
        input: { command: 'rm -rf build' },
        cwd: process.cwd(),
      }),
    ).toBe(false);
  });
});

describe('PermissionGate', () => {
  const request = (tool: string, isReadOnly: boolean, input: unknown = {}) => ({
    tool,
    input,
    isReadOnly,
    isDestructive: false,
  });

  it('default 模式：只读放行，写操作询问', async () => {
    let asked = 0;
    const gate = new PermissionGate({
      mode: 'default',
      rules: [],
      cwd: process.cwd(),
      ask: async () => {
        asked += 1;
        return false;
      },
    });

    expect((await gate.decide(request('Read', true))).behavior).toBe('allow');
    const write = await gate.decide(request('Write', false));
    expect(write.behavior).toBe('deny');
    expect(asked).toBe(1);
  });

  it('acceptEdits 模式允许 Write/Edit', async () => {
    const gate = new PermissionGate({
      mode: 'acceptEdits',
      rules: [],
      cwd: process.cwd(),
      ask: async () => false,
    });

    expect((await gate.decide(request('Write', false))).behavior).toBe('allow');
    expect((await gate.decide(request('Edit', false))).behavior).toBe('allow');
    expect((await gate.decide(request('Bash', false))).behavior).toBe('deny');
  });

  it('plan 模式拒绝写与命令', async () => {
    const gate = new PermissionGate({
      mode: 'plan',
      rules: [],
      cwd: process.cwd(),
      ask: async () => true,
    });

    expect((await gate.decide(request('Read', true))).behavior).toBe('allow');
    expect((await gate.decide(request('Write', false))).behavior).toBe('deny');
    expect((await gate.decide(request('Bash', false))).behavior).toBe('deny');
  });

  it('deny 规则优先于 allow 规则', async () => {
    const gate = new PermissionGate({
      mode: 'default',
      rules: [...parseRules(['Read'], 'allow'), ...parseRules(['Read(**/.env)'], 'deny')],
      cwd: process.cwd(),
      ask: async () => false,
    });

    expect((await gate.decide(request('Read', true, { file_path: '.env' }))).behavior).toBe('deny');
    expect((await gate.decide(request('Read', true, { file_path: 'a.txt' }))).behavior).toBe(
      'allow',
    );
  });

  it('allow 规则可以放行 Bash 前缀命令', async () => {
    const gate = new PermissionGate({
      mode: 'default',
      rules: parseRules(['Bash(npm test:*)'], 'allow'),
      cwd: process.cwd(),
      ask: async () => false,
    });

    expect(
      (await gate.decide(request('Bash', false, { command: 'npm test -- --run' }))).behavior,
    ).toBe('allow');
    expect((await gate.decide(request('Bash', false, { command: 'npm install' }))).behavior).toBe(
      'deny',
    );
  });

  it('bypass 模式直接放行（工具内部硬拦截仍然生效）', async () => {
    const gate = new PermissionGate({
      mode: 'bypass',
      rules: [],
      cwd: process.cwd(),
      ask: async () => false,
    });

    expect((await gate.decide(request('Bash', false))).behavior).toBe('allow');
  });
});
