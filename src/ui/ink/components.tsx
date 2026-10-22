import { Box, Text } from 'ink';
import type React from 'react';

import type { ApprovalEntry } from '../approval.js';
import { renderMarkdown } from '../markdown.js';
import { toolInputSummary } from '../tool-summary.js';

export interface UiItemBase {
  id: number;
  done: boolean;
}

export type UiItem =
  | (UiItemBase & {
      kind: 'user' | 'assistant' | 'system';
      text: string;
      error?: boolean;
      streaming?: boolean;
    })
  | (UiItemBase & {
      kind: 'tool';
      toolUseId: string;
      name: string;
      summary: string;
      status: 'running' | 'ok' | 'error';
      detail?: string;
      startedAt: number;
      durationMs?: number;
    });

export function ItemView({ item }: { item: UiItem }): React.ReactElement {
  if (item.kind === 'user') {
    return (
      <Box marginBottom={1}>
        <Text color="cyan" bold>
          ›{' '}
        </Text>
        <Text>{item.text}</Text>
      </Box>
    );
  }

  if (item.kind === 'assistant') {
    return (
      <Box marginBottom={1} flexDirection="column">
        <Text>{renderMarkdown(item.text)}</Text>
        {item.streaming ? <Text color="gray">▌</Text> : null}
      </Box>
    );
  }

  if (item.kind === 'system') {
    return (
      <Box marginBottom={1}>
        <Text color={item.error ? 'red' : 'gray'}>{item.text}</Text>
      </Box>
    );
  }

  if (item.kind === 'tool') {
    return <ToolCard item={item} />;
  }

  return <Text>{''}</Text>;
}

function ToolCard({
  item,
}: {
  item: Extract<UiItem, { kind: 'tool' }>;
}): React.ReactElement {
  const icon = item.status === 'running' ? '◐' : item.status === 'ok' ? '✓' : '✗';
  const color = item.status === 'running' ? 'yellow' : item.status === 'ok' ? 'green' : 'red';
  const duration = item.durationMs !== undefined ? ` ${(item.durationMs / 1000).toFixed(1)}s` : '';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color}>{icon} </Text>
        <Text bold>{item.name}</Text>
        {item.summary ? <Text dimColor> {item.summary}</Text> : null}
        <Text dimColor>{duration}</Text>
      </Box>
      {item.detail ? (
        <Box paddingLeft={3}>
          <Text dimColor>{item.detail}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function ApprovalPrompt({
  approval,
  cwd,
  selected,
}: {
  approval: ApprovalEntry;
  cwd: string;
  selected: number;
}): React.ReactElement {
  const summary = toolInputSummary(approval.request.tool, approval.request.input);
  const options = [
    { key: 'a', label: '允许本次', color: 'green' as const },
    { key: 'Shift+A', label: '本项目始终允许', color: 'green' as const },
    { key: 'd', label: '拒绝', color: 'red' as const },
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginBottom={1}
    >
      <Text color="yellow" bold>
        ⚠ 需要授权：{approval.request.tool}
      </Text>
      <Text>{approval.reason}</Text>
      {summary ? <Text dimColor>输入：{summary}</Text> : null}
      <Text dimColor>目录：{cwd}</Text>

      {options.map((option, index) => (
        <Text key={option.key} color={index === selected ? option.color : undefined}>
          {index === selected ? '▶ ' : '  '}[{option.key}] {option.label}
        </Text>
      ))}

      {selected < 0 ? (
        <Text color="yellow">请先按 ↑/↓、Tab 或 1/2/3 选择选项，再按 Enter 确认</Text>
      ) : (
        <Text dimColor>Enter 确认 · 也可按 1/2/3 选择，或 a / Shift+A / d</Text>
      )}
    </Box>
  );
}

export function StatusBar({
  provider,
  model,
  mode,
  sessionId,
  usage,
  busy,
}: {
  provider: string;
  model: string;
  mode: string;
  sessionId: string;
  usage: { input: number; output: number };
  busy: boolean;
}): React.ReactElement {
  return (
    <Box justifyContent="space-between" marginTop={1}>
      <Text dimColor>
        {provider}/{model} · {mode}
      </Text>
      <Text dimColor>
        ↑{usage.input} ↓{usage.output} · {sessionId.slice(-8)}
        {busy ? ' · 生成中' : ''}
      </Text>
    </Box>
  );
}
