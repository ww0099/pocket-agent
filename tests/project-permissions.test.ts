import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { PermissionRequest } from '../src/permissions/gate.js';
import {
  addProjectAllowRule,
  buildAllowRule,
  loadProjectPermissions,
  projectPermissionsFile,
} from '../src/permissions/project.js';
import { makeTempDir } from './helpers/index.js';

function request(tool: string, input: unknown): PermissionRequest {
  return { tool, input, isReadOnly: false, isDestructive: false };
}

describe('project permissions', () => {
  it('为 Bash 生成精确命令规则', () => {
    const cwd = makeTempDir('perm-bash');
    expect(buildAllowRule(request('Bash', { command: 'npm test' }), cwd)).toBe('Bash(npm test)');
  });

  it('为文件工具生成相对路径规则', () => {
    const cwd = makeTempDir('perm-file');
    expect(buildAllowRule(request('Edit', { file_path: 'src/a.ts' }), cwd)).toBe('Edit(src/a.ts)');
  });

  it('写入并合并项目级 allow 规则', () => {
    const cwd = makeTempDir('perm-write');

    const first = addProjectAllowRule(cwd, 'Bash(npm test)');
    expect(first.added).toBe(true);
    expect(fs.existsSync(projectPermissionsFile(cwd))).toBe(true);
    expect(loadProjectPermissions(cwd).allow).toContain('Bash(npm test)');

    const second = addProjectAllowRule(cwd, 'Edit(src/a.ts)');
    expect(second.added).toBe(true);

    const third = addProjectAllowRule(cwd, 'Bash(npm test)');
    expect(third.added).toBe(false);

    expect(loadProjectPermissions(cwd).allow).toEqual(['Bash(npm test)', 'Edit(src/a.ts)']);
  });

  it('没有项目配置时返回空规则', () => {
    const cwd = makeTempDir('perm-empty');
    expect(loadProjectPermissions(cwd)).toEqual({
      allow: [],
      deny: [],
      additionalDirectories: [],
    });
  });
});
