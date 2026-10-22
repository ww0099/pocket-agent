import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getPaths } from '../src/bootstrap/paths.js';
import { resolveAgentRoot } from '../src/bootstrap/root.js';
import { makeTempDir } from './helpers/index.js';

describe('paths', () => {
  it('AGENT_ROOT 环境变量优先', () => {
    const root = resolveAgentRoot({ AGENT_ROOT: 'D:\\portable\\agent' } as NodeJS.ProcessEnv);
    expect(root).toBe(path.resolve('D:\\portable\\agent'));
  });

  it('未设置 AGENT_ROOT 时推导为项目根（开发态）', () => {
    expect(resolveAgentRoot({} as NodeJS.ProcessEnv)).toBe(path.resolve(process.cwd()));
  });

  it('打包布局 <root>\\app\\dist\\cli.js 推导为 <root>', () => {
    const root = makeTempDir('root-packaged');
    const dist = path.join(root, 'app', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'cli.js'), '', 'utf8');

    expect(resolveAgentRoot({} as NodeJS.ProcessEnv, dist)).toBe(path.resolve(root));
  });

  it('开发布局 dist/cli.js 推导为仓库根', () => {
    const root = makeTempDir('root-dev');
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}', 'utf8');

    expect(resolveAgentRoot({} as NodeJS.ProcessEnv, dist)).toBe(path.resolve(root));
  });

  it('所有数据路径都位于 Agent 根之内', () => {
    const root = path.resolve('D:\\portable\\agent');
    const paths = getPaths(root);

    for (const value of Object.values(paths)) {
      expect(value.startsWith(root)).toBe(true);
    }
    expect(paths.sessionsDir).toBe(path.join(root, 'data', 'sessions'));
    expect(paths.runtimeDir).toBe(path.join(root, 'runtime'));
  });
});
