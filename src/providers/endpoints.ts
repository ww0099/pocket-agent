function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function anthropicMessagesUrl(baseUrl: string): string {
  const base = trimBase(baseUrl);
  if (base.endsWith('/messages')) return base;
  if (/\/v\d+$/.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
}

export function anthropicModelsUrl(baseUrl: string): string {
  const base = trimBase(baseUrl);
  if (base.endsWith('/messages')) return base.replace(/\/messages$/, '/models');
  if (/\/v\d+$/.test(base)) return `${base}/models`;
  return `${base}/v1/models`;
}

export function openAiChatUrl(baseUrl: string): string {
  const base = trimBase(baseUrl);
  if (base.endsWith('/chat/completions')) return base;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function openAiModelsUrl(baseUrl: string): string {
  const base = trimBase(baseUrl);
  if (base.endsWith('/chat/completions')) {
    return base.replace(/\/chat\/completions$/, '/models');
  }
  if (/\/v\d+$/.test(base)) return `${base}/models`;
  return `${base}/v1/models`;
}
