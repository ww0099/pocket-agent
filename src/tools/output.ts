import fs from 'node:fs';
import path from 'node:path';

export interface TruncationResult {
  text: string;
  truncated: boolean;
  totalBytes: number;
}

/** 按字节上限保留头部 60% 与尾部 40%，避免单次工具输出撑爆上下文。 */
export function truncateForContext(text: string, maxBytes: number): TruncationResult {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) {
    return { text, truncated: false, totalBytes };
  }

  const lines = text.split('\n');
  const headBudget = Math.floor(maxBytes * 0.6);
  const tailBudget = maxBytes - headBudget;

  const head: string[] = [];
  let headUsed = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (headUsed + size > headBudget) break;
    head.push(line);
    headUsed += size;
  }

  const tail: string[] = [];
  let tailUsed = 0;
  for (let index = lines.length - 1; index >= head.length; index -= 1) {
    const line = lines[index];
    if (line === undefined) break;
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (tailUsed + size > tailBudget) break;
    tail.unshift(line);
    tailUsed += size;
  }

  if (head.length === 0 && tail.length === 0) {
    const headText = sliceByBytes(text, headBudget, false);
    const tailText = sliceByBytes(text, tailBudget, true);
    return {
      text: `${headText}\n\n... [输出已截断] ...\n\n${tailText}`,
      truncated: true,
      totalBytes,
    };
  }

  return {
    text: `${head.join('\n')}\n\n... [输出已截断] ...\n\n${tail.join('\n')}`,
    truncated: true,
    totalBytes,
  };
}

/** 把完整输出写到 data/tool-outputs/<sessionId>/<toolUseId>.txt。 */
export function persistToolOutput(
  outputDir: string,
  sessionId: string,
  toolUseId: string,
  text: string,
): string {
  const dir = path.join(outputDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });

  const safeId = toolUseId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'output';
  const file = path.join(dir, `${safeId}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function sliceByBytes(text: string, budget: number, fromEnd: boolean): string {
  let candidate = fromEnd ? text.slice(-budget) : text.slice(0, budget);

  while (Buffer.byteLength(candidate, 'utf8') > budget && candidate.length > 0) {
    const ratio = budget / Buffer.byteLength(candidate, 'utf8');
    const nextLength = Math.max(1, Math.floor(candidate.length * ratio) - 1);
    candidate = fromEnd ? candidate.slice(-nextLength) : candidate.slice(0, nextLength);
  }

  return candidate;
}
