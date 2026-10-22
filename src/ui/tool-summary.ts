export function toolInputSummary(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';

  const record = input as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
  };

  let summary = '';

  switch (name) {
    case 'Bash':
      summary = pick('command') ?? '';
      break;
    case 'Read':
    case 'Write':
    case 'Edit':
      summary = pick('file_path') ?? '';
      break;
    case 'Glob':
      summary = pick('pattern') ?? '';
      break;
    case 'Grep': {
      const pattern = pick('pattern') ?? '';
      const searchPath = pick('path');
      summary = searchPath ? `${pattern}  ${searchPath}` : pattern;
      break;
    }
    case 'TodoWrite': {
      const todos = record.todos;
      summary = Array.isArray(todos) ? `${todos.length} 项待办` : '';
      break;
    }
    case 'Task':
      summary = pick('description') ?? '';
      break;
    default: {
      summary = JSON.stringify(input);
      break;
    }
  }

  return summary.replace(/\s+/g, ' ').slice(0, 100);
}
