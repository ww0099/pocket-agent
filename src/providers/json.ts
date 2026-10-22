export type ParsedToolInput = { ok: true; value: unknown } | { ok: false; error: string };

export function parseToolInput(text: string): ParsedToolInput {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };

  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
