import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 推导 Agent 根目录。
 *
 * 优先级：
 * 1. AGENT_ROOT 环境变量（由启动器 agent.cmd 设置，最可靠）
 * 2. 从当前模块位置向上查找标记：
 *    - 打包布局：<root>\app\dist\cli.js 存在 → <root>
 *    - 开发布局：包含 package.json 的最近祖先目录 → 仓库根
 *
 * 这里绝不使用 os.homedir() 或 %APPDATA%，所有状态都必须留在 Agent 根内。
 */
export function resolveAgentRoot(env: NodeJS.ProcessEnv = process.env, startDir?: string): string {
  const explicit = env.AGENT_ROOT?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  const start = startDir ? path.resolve(startDir) : path.dirname(fileURLToPath(import.meta.url));
  let current = start;

  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(current, 'app', 'dist', 'cli.js'))) {
      return current;
    }
    if (fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // 理论兜底：与旧布局保持一致
  return path.resolve(start, '..', '..');
}
