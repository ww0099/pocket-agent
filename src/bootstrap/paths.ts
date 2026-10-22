import fs from 'node:fs';
import path from 'node:path';

import { resolveAgentRoot } from './root.js';

export interface AgentPaths {
  readonly root: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly sessionsDir: string;
  readonly logsDir: string;
  readonly tmpDir: string;
  readonly toolOutputsDir: string;
  readonly cacheDir: string;
  readonly memoryDir: string;
  readonly skillsDir: string;
  readonly agentsDir: string;
  readonly commandsDir: string;
  readonly runtimeDir: string;
  readonly toolsDir: string;
}

/** 所有 Agent 路径的唯一来源；禁止在业务代码里拼接绝对路径。 */
export function getPaths(root: string = resolveAgentRoot()): AgentPaths {
  const dataDir = path.join(root, 'data');

  return {
    root,
    configDir: path.join(root, 'config'),
    dataDir,
    sessionsDir: path.join(dataDir, 'sessions'),
    logsDir: path.join(dataDir, 'logs'),
    tmpDir: path.join(dataDir, 'tmp'),
    toolOutputsDir: path.join(dataDir, 'tool-outputs'),
    cacheDir: path.join(dataDir, 'cache'),
    memoryDir: path.join(root, 'memory'),
    skillsDir: path.join(root, 'skills'),
    agentsDir: path.join(root, 'agents'),
    commandsDir: path.join(root, 'commands'),
    runtimeDir: path.join(root, 'runtime'),
    toolsDir: path.join(root, 'tools'),
  };
}

/** 创建运行期需要的目录。可重复调用。 */
export function ensureRuntimeDirs(paths: AgentPaths): void {
  for (const dir of [
    paths.dataDir,
    paths.sessionsDir,
    paths.logsDir,
    paths.tmpDir,
    paths.toolOutputsDir,
    paths.cacheDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
