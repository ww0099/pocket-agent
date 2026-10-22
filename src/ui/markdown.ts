import { highlight } from 'cli-highlight';
import { Lexer } from 'marked';

const ESC = `${String.fromCharCode(27)}[`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const UNDERLINE = `${ESC}4m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;
const GRAY = `${ESC}90m`;

interface MdToken {
  type: string;
  text?: string;
  raw?: string;
  depth?: number;
  lang?: string;
  tokens?: MdToken[];
  items?: MdToken[];
  href?: string;
  header?: MdToken[];
  rows?: MdToken[][];
  ordered?: boolean;
  start?: number;
}

/** 防止模型输出注入终端控制序列（CSI / OSC 与裸控制字符）。 */
export function sanitizeForTerminal(text: string): string {
  let output = '';

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (code === 27) {
      const next = text.charCodeAt(index + 1);

      if (next === 0x5b) {
        // CSI: ESC [ ... 终止字节 0x40-0x7e
        index += 2;
        while (index < text.length) {
          const current = text.charCodeAt(index);
          if (current >= 0x40 && current <= 0x7e) break;
          index += 1;
        }
        continue;
      }

      if (next === 0x5d) {
        // OSC: ESC ] ... BEL
        index += 2;
        while (index < text.length && text.charCodeAt(index) !== 0x07) index += 1;
        continue;
      }

      index += 1;
      continue;
    }

    if (code === 9 || code === 10 || code === 13) {
      output += text[index];
      continue;
    }
    if (code < 32 || code === 127) continue;
    output += text[index];
  }

  return output;
}

export function renderMarkdown(markdown: string): string {
  const source = sanitizeForTerminal(markdown);
  if (!source.trim()) return '';

  const tokens = Lexer.lex(source) as unknown as MdToken[];
  return renderBlocks(tokens)
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function renderBlocks(tokens: MdToken[] | undefined): string {
  if (!tokens) return '';
  return tokens.map(renderBlock).join('');
}

function renderBlock(token: MdToken): string {
  switch (token.type) {
    case 'space':
      return '';
    case 'heading': {
      const depth = token.depth ?? 1;
      const prefix = '#'.repeat(depth);
      return `${BOLD}${CYAN}${prefix} ${renderInline(token.tokens)}${RESET}\n\n`;
    }
    case 'paragraph':
      return `${renderInline(token.tokens)}\n\n`;
    case 'text':
      return `${renderInline(token.tokens ?? [token])}\n\n`;
    case 'code':
      return `${renderCodeBlock(token.text ?? '', token.lang)}\n\n`;
    case 'blockquote': {
      const inner = renderBlocks(token.tokens).trimEnd();
      return `${inner
        .split('\n')
        .map((line) => `${GRAY}│ ${RESET}${line}`)
        .join('\n')}\n\n`;
    }
    case 'list':
      return `${renderList(token)}\n`;
    case 'hr':
      return `${GRAY}${'─'.repeat(40)}${RESET}\n\n`;
    case 'table':
      return `${renderTable(token)}\n\n`;
    case 'html':
      return `${GRAY}[HTML 已省略]${RESET}\n\n`;
    default:
      return `${renderInline(token.tokens ?? [])}\n`;
  }
}

function renderInline(tokens: MdToken[] | undefined): string {
  if (!tokens) return '';

  return tokens
    .map((token) => {
      switch (token.type) {
        case 'text':
          return token.tokens ? renderInline(token.tokens) : sanitizeForTerminal(token.text ?? '');
        case 'strong':
          return `${BOLD}${renderInline(token.tokens)}${RESET}`;
        case 'em':
          return `${ITALIC}${renderInline(token.tokens)}${RESET}`;
        case 'del':
          return `${DIM}${renderInline(token.tokens)}${RESET}`;
        case 'codespan':
          return `${CYAN}${sanitizeForTerminal(token.text ?? '')}${RESET}`;
        case 'link':
          return `${UNDERLINE}${renderInline(token.tokens)}${RESET}${GRAY} (${sanitizeForTerminal(
            token.href ?? '',
          )})${RESET}`;
        case 'br':
          return '\n';
        case 'escape':
          return sanitizeForTerminal(token.text ?? '');
        default:
          return typeof token.text === 'string'
            ? sanitizeForTerminal(token.text)
            : renderInline(token.tokens);
      }
    })
    .join('');
}

function renderCodeBlock(code: string, language?: string): string {
  let body = sanitizeForTerminal(code);

  if (language) {
    try {
      body = highlight(body, { language, ignoreIllegals: true });
    } catch {
      // 未知语言或高亮失败时保留纯文本
    }
  }

  const header = language ? `${GRAY}\`\`\`${language}${RESET}` : `${GRAY}\`\`\`${RESET}`;
  return `${header}\n${body}\n${GRAY}\`\`\`${RESET}`;
}

function renderList(token: MdToken): string {
  const items = token.items ?? [];
  const start = token.start ?? 1;

  return items
    .map((item, index) => {
      const bullet = token.ordered ? `${start + index}.` : '•';
      const body = renderBlocks(item.tokens).trimEnd();
      const [firstLine = '', ...rest] = body.split('\n');
      const indented = rest.map((line) => `   ${line}`).join('\n');
      return `${CYAN}${bullet}${RESET} ${firstLine}${indented ? `\n${indented}` : ''}`;
    })
    .join('\n');
}

function renderTable(token: MdToken): string {
  const header = (token.header ?? []).map((cell) => renderInline(cell.tokens));
  const rows = (token.rows ?? []).map((row) => row.map((cell) => renderInline(cell.tokens)));

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];

  return `${GRAY}${lines.join('\n')}${RESET}`;
}

export function colorizeError(text: string): string {
  return `${RED}${sanitizeForTerminal(text)}${RESET}`;
}

export function colorizeWarning(text: string): string {
  return `${YELLOW}${sanitizeForTerminal(text)}${RESET}`;
}
