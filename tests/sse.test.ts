import { describe, expect, it } from 'vitest';

import { parseSse } from '../src/providers/sse.js';
import { collect, sseResponse } from './helpers/index.js';

describe('parseSse', () => {
  it('解析跨 chunk 的事件与多行 data', async () => {
    const response = sseResponse([
      'event: message_start\n',
      'data: {"a":1}\n\n',
      'data: line1\ndata: line2\n\n',
      'data: last',
    ]);

    const messages = await collect(parseSse(response.body as ReadableStream<Uint8Array>));

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ event: 'message_start', data: '{"a":1}' });
    expect(messages[1]?.data).toBe('line1\nline2');
    expect(messages[2]?.data).toBe('last');
  });

  it('兼容 CRLF 与注释行', async () => {
    const response = sseResponse([
      ': keep-alive\r\n',
      'data: {"ok":true}\r\n',
      '\r\n',
      'data: done\r\n',
    ]);

    const messages = await collect(parseSse(response.body as ReadableStream<Uint8Array>));

    expect(messages.map((message) => message.data)).toEqual(['{"ok":true}', 'done']);
  });

  it('一个 chunk 中同时包含多个事件', async () => {
    const response = sseResponse(['data: one\n\ndata: two\n\n']);

    const messages = await collect(parseSse(response.body as ReadableStream<Uint8Array>));

    expect(messages.map((message) => message.data)).toEqual(['one', 'two']);
  });
});
