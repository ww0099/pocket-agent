import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PathAccessError, resolveToolPath } from '../src/tools/path-guard.js';
import { createTestContext, makeTempDir, writeTestFile } from './helpers/index.js';

describe('path guard', () => {
  it('允许工作区内的路径', () => {
    const ctx = createTestContext();
    const file = writeTestFile(ctx.cwd, 'a.txt', 'hello');

    expect(resolveToolPath('a.txt', ctx)).toBe(path.resolve(file));
  });

  it('拒绝工作区之外的路径', () => {
    const ctx = createTestContext();

    expect(() => resolveToolPath(path.join('..', 'outside.txt'), ctx)).toThrowError(
      PathAccessError,
    );
  });

  it('拒绝敏感目录与敏感文件', () => {
    const ctx = createTestContext();

    expect(() => resolveToolPath('.ssh/id_rsa', ctx)).toThrowError(/敏感目录/);
    expect(() => resolveToolPath('secrets.json', ctx)).toThrowError(/敏感文件/);
  });

  it('拒绝对 Agent 自身目录的写操作', () => {
    const ctx = createTestContext();

    expect(() =>
      resolveToolPath(path.join(ctx.agentRoot, 'config', 'settings.json'), ctx, {
        write: true,
      }),
    ).toThrowError(/Agent 自身目录/);
  });

  it('支持 additionalDirectories 扩展根目录', () => {
    const extraRoot = makeTempDir('extra');
    const ctx = createTestContext();
    const policy = { ...ctx, roots: [...ctx.roots, extraRoot] };

    expect(() => resolveToolPath(path.join(extraRoot, 'allowed.txt'), policy)).not.toThrow();
  });

  it('拒绝磁盘根目录写入', () => {
    const ctx = createTestContext();
    const driveRoot = path.parse(ctx.cwd).root;
    const policy = { ...ctx, roots: [...ctx.roots, driveRoot] };

    expect(() => resolveToolPath(driveRoot, policy, { write: true })).toThrowError(/磁盘根目录/);
  });
});
