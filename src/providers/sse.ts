export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

/**
 * 通用 Server-Sent Events 解析器。
 *
 * 处理要点：
 * - 跨 chunk 的不完整行；
 * - CRLF / LF 混用；
 * - 多行 data 以 \n 拼接；
 * - 注释行（以 : 开头）忽略；
 * - 流结束时补齐最后一条未以空行结尾的事件。
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let eventName: string | undefined;
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const takeEvent = (): SseMessage | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      eventId = undefined;
      return undefined;
    }

    const message: SseMessage = { data: dataLines.join('\n') };
    if (eventName !== undefined) message.event = eventName;
    if (eventId !== undefined) message.id = eventId;

    eventName = undefined;
    eventId = undefined;
    dataLines = [];
    return message;
  };

  const handleLine = (rawLine: string): SseMessage | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line === '') {
      return takeEvent();
    }
    if (line.startsWith(':')) {
      return undefined;
    }
    if (line.startsWith('data:')) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
      return undefined;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      return undefined;
    }
    if (line.startsWith('id:')) {
      eventId = line.slice(3).trim();
      return undefined;
    }
    // retry: 与未知字段按 SSE 规范忽略
    return undefined;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const message = handleLine(line);
        if (message) yield message;
        newlineIndex = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const message = handleLine(buffer);
      if (message) yield message;
    }

    const last = takeEvent();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
