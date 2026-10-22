import { describe, expect, it } from 'vitest';

import { userText } from '../src/core/messages.js';
import { estimateMessagesTokens, estimateTokens } from '../src/core/tokens.js';

describe('estimateTokens', () => {
  it('空字符串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('英文按约 3.5 字符/token 估算', () => {
    expect(estimateTokens('hello world')).toBe(4);
  });

  it('中文按 1 字/token 估算', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('混合文本分别计算', () => {
    expect(estimateTokens('你好helloworld')).toBe(5);
  });

  it('消息级估算包含工具调用与结果', () => {
    const tokens = estimateMessagesTokens([
      userText('hello world'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok', isError: false }],
      },
    ]);

    expect(tokens).toBeGreaterThan(10);
  });
});
