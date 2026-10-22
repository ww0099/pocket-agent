import path from 'node:path';

import { canonicalPath, isPathInside } from '../util/fsx.js';
import { ToolInputError } from './base.js';

export interface PathPolicy {
  cwd: string;
  roots: string[];
  agentRoot: string;
}

const SENSITIVE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube']);
const SENSITIVE_FILES = new Set([
  'id_rsa',
  'id_ed25519',
  '.git-credentials',
  '.netrc',
  'secrets.json',
  'secrets.enc.json',
]);

const WINDOWS_SYSTEM_DIRS = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\System Volume Information',
];

export class PathAccessError extends ToolInputError {}

/**
 * 把工具参数中的路径解析为规范绝对路径，并执行边界检查。
 * 注意：policy.roots 与 policy.agentRoot 必须是已规范化的路径。
 */
export function resolveToolPath(
  rawPath: string,
  policy: PathPolicy,
  options: { write?: boolean } = {},
): string {
  if (!rawPath || rawPath.includes('\0')) {
    throw new PathAccessError('路径为空或包含非法字符');
  }

  const absolute = path.resolve(policy.cwd, rawPath);
  const canonical = canonicalPath(absolute);

  const insideRoot = policy.roots.some((root) => isPathInside(canonical, root));
  if (!insideRoot) {
    throw new PathAccessError(
      `路径不在允许的工作区内：${rawPath}\n允许的根目录：${policy.roots.join(', ')}`,
    );
  }

  checkSensitive(canonical, policy, options.write === true);
  return canonical;
}

function checkSensitive(canonical: string, policy: PathPolicy, write: boolean): void {
  const lowerSegments = canonical.split(path.sep).map((segment) => segment.toLowerCase());

  for (const segment of lowerSegments) {
    if (SENSITIVE_DIRS.has(segment)) {
      throw new PathAccessError(`拒绝访问敏感目录：${canonical}`);
    }
  }

  const baseName = path.basename(canonical).toLowerCase();
  if (SENSITIVE_FILES.has(baseName)) {
    throw new PathAccessError(`拒绝访问敏感文件：${canonical}`);
  }

  if (process.platform === 'win32') {
    for (const dir of WINDOWS_SYSTEM_DIRS) {
      if (isPathInside(canonical, dir)) {
        throw new PathAccessError(`拒绝访问系统目录：${canonical}`);
      }
    }
  }

  if (write) {
    if (canonical === path.parse(canonical).root) {
      throw new PathAccessError('拒绝对磁盘根目录执行写操作');
    }

    const protectedDirs = ['config', 'runtime', 'app', 'tools'].map((name) =>
      path.join(policy.agentRoot, name),
    );
    for (const dir of protectedDirs) {
      if (isPathInside(canonical, dir)) {
        throw new PathAccessError(`拒绝修改 Agent 自身目录：${canonical}`);
      }
    }
  }
}
