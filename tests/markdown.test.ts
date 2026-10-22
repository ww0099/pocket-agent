import { describe, expect, it } from 'vitest';

import { renderMarkdown, sanitizeForTerminal } from '../src/ui/markdown.js';

const ESC = String.fromCharCode(27);

describe('markdown renderer', () => {
  it('渲染标题、粗体与行内代码', () => {
    const output = renderMarkdown('# Title\n\n**bold** and `code`');

    expect(output).toContain('Title');
    expect(output).toContain('bold');
    expect(output).toContain('code');
  });

  it('渲染代码块并保留内容', () => {
    const output = renderMarkdown('```js\nconst answer = 42;\n```');

    expect(output).toContain('const');
    expect(output).toContain('42');
  });

  it('渲染列表与链接', () => {
    const output = renderMarkdown('- one\n- two\n\n[site](https://example.com)');

    expect(output).toContain('one');
    expect(output).toContain('two');
    expect(output).toContain('https://example.com');
  });

  it('剥离模型输出中的终端控制序列', () => {
    const malicious = `${ESC}[31mred${ESC}[0m`;
    expect(sanitizeForTerminal(malicious)).toBe('red');

    const output = renderMarkdown(malicious);
    expect(output.includes(ESC)).toBe(false);
  });

  it('空内容返回空字符串', () => {
    expect(renderMarkdown('')).toBe('');
  });
});
