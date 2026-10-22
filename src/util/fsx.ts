import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256Short(input: string, length = 12): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, length);
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** child 是否位于 parent 之内（含相等）。 */
export function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function pathsEqual(a: string, b: string): boolean {
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * 取得规范化绝对路径：尽量解析符号链接；文件不存在时解析最近的已存在祖先。
 */
export function canonicalPath(target: string): string {
  const resolved = path.resolve(target);

  try {
    return fs.realpathSync(resolved);
  } catch {
    const suffix: string[] = [];
    let current = resolved;

    for (let depth = 0; depth < 64; depth += 1) {
      const parent = path.dirname(current);
      if (parent === current) break;
      suffix.unshift(path.basename(current));
      current = parent;

      try {
        const real = fs.realpathSync(current);
        return path.join(real, ...suffix);
      } catch {
        // 继续向上
      }
    }

    return resolved;
  }
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 同目录临时文件 + rename，尽量避免写入中断留下半个文件。 */
export function atomicWriteFile(file: string, content: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, content, 'utf8');

  try {
    fs.renameSync(temp, file);
  } catch {
    // Windows 上目标被占用时 rename 可能失败，退化为复制后删除
    fs.copyFileSync(temp, file);
    fs.unlinkSync(temp);
  }
}

export function detectBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  return sample.includes(0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
