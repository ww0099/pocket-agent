import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { textOf } from '../../core/messages.js';
import { addProjectAllowRule, buildAllowRule } from '../../permissions/project.js';
import { PERMISSION_MODES } from '../../permissions/rules.js';
import type { SessionRuntime } from '../../runtime/session-runtime.js';
import { errorMessage } from '../../util/errors.js';
import { PRODUCT_NAME, VERSION } from '../../version.js';
import type { ApprovalBroker, ApprovalEntry } from '../approval.js';
import { toolInputSummary } from '../tool-summary.js';
import { ApprovalPrompt, ItemView, StatusBar, type UiItem } from './components.js';

export interface AppProps {
  runtime: SessionRuntime;
  broker: ApprovalBroker;
}

export function App({ runtime, broker }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const initialItems = useMemo(() => buildInitialItems(runtime), [runtime]);
  const nextId = useRef(initialItems.length + 1);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef('');
  const approvalIndexRef = useRef(0);
  const approvalNavigatedRef = useRef(false);

  const [items, setItems] = useState<UiItem[]>(initialItems);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState({ input: 0, output: 0 });
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [approvalNavigated, setApprovalNavigated] = useState(false);

  const approval = useSyncExternalStore(broker.subscribe, broker.getSnapshot, broker.getSnapshot);

  useEffect(() => {
    if (!approval) return;
    approvalIndexRef.current = 0;
    approvalNavigatedRef.current = false;
    setApprovalIndex(0);
    setApprovalNavigated(false);
  }, [approval]);

  const selectApproval = useCallback((next: number): void => {
    const clamped = Math.max(0, Math.min(2, next));
    approvalIndexRef.current = clamped;
    approvalNavigatedRef.current = true;
    setApprovalIndex(clamped);
    setApprovalNavigated(true);
  }, []);

  const handleInputChange = useCallback((value: string): void => {
    inputRef.current = value;
    setInput(value);
  }, []);

  const addSystem = useCallback((text: string, error = false): void => {
    const id = nextId.current;
    nextId.current += 1;
    setItems((prev) => [...prev, { id, done: true, kind: 'system', text, error }]);
  }, []);

  const finalizeAssistant = useCallback((idRef: { id: number | null }): void => {
    if (idRef.id === null) return;
    const id = idRef.id;
    idRef.id = null;
    setItems((prev) =>
      prev.map((item) =>
        item.id === id ? ({ ...item, done: true, streaming: false } as UiItem) : item,
      ),
    );
  }, []);

  const runPrompt = useCallback(
    async (prompt: string): Promise<void> => {
      if (busy) return;

      setBusy(true);
      const userId = nextId.current;
      nextId.current += 1;
      setItems((prev) => [...prev, { id: userId, done: true, kind: 'user', text: prompt }]);

      const controller = new AbortController();
      abortRef.current = controller;
      const assistantRef: { id: number | null } = { id: null };
      let assistantText = '';

      try {
        for await (const event of runtime.runTurn(prompt, controller.signal)) {
          switch (event.type) {
            case 'text_delta': {
              if (assistantRef.id === null) {
                assistantRef.id = nextId.current;
                nextId.current += 1;
                const id = assistantRef.id;
                setItems((prev) => [
                  ...prev,
                  { id, done: false, kind: 'assistant', text: '', streaming: true },
                ]);
              }

              assistantText += event.text;
              const id = assistantRef.id;
              const text = assistantText;
              setItems((prev) =>
                prev.map((item) => (item.id === id ? ({ ...item, text } as UiItem) : item)),
              );
              break;
            }

            case 'tool_call_start': {
              finalizeAssistant(assistantRef);
              const id = nextId.current;
              nextId.current += 1;
              setItems((prev) => [
                ...prev,
                {
                  id,
                  done: false,
                  kind: 'tool',
                  toolUseId: event.id,
                  name: event.name,
                  summary: '',
                  status: 'running',
                  startedAt: Date.now(),
                },
              ]);
              break;
            }

            case 'tool_call_end': {
              const summary = toolInputSummary(event.name, event.input);
              setItems((prev) =>
                prev.map((item) =>
                  item.kind === 'tool' && item.toolUseId === event.id ? { ...item, summary } : item,
                ),
              );
              break;
            }

            case 'tool_result': {
              const detail = firstLine(event.result.output);
              setItems((prev) =>
                prev.map((item) =>
                  item.kind === 'tool' && item.toolUseId === event.result.id
                    ? {
                        ...item,
                        status: event.result.isError ? 'error' : 'ok',
                        detail,
                        durationMs: Date.now() - item.startedAt,
                        done: true,
                      }
                    : item,
                ),
              );
              break;
            }

            case 'turn_end': {
              finalizeAssistant(assistantRef);
              break;
            }

            case 'usage': {
              setUsage((prev) => ({
                input: prev.input + event.usage.inputTokens,
                output: prev.output + event.usage.outputTokens,
              }));
              break;
            }

            case 'compaction': {
              addSystem(
                `上下文已压缩：省略 ${event.omittedMessages} 条，约 ${event.beforeTokens} → ${event.afterTokens} tokens`,
              );
              break;
            }

            case 'error': {
              addSystem(event.message, true);
              break;
            }

            case 'notice': {
              addSystem(event.text);
              break;
            }

            default:
              break;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) {
          addSystem('已取消');
        } else {
          addSystem(`错误：${errorMessage(error)}`, true);
        }
      } finally {
        finalizeAssistant(assistantRef);
        setItems((prev) =>
          prev.map((item) =>
            item.kind === 'tool' && item.status === 'running'
              ? { ...item, status: 'error', done: true, detail: '已中断' }
              : item,
          ),
        );
        abortRef.current = null;
        setBusy(false);
      }
    },
    [addSystem, busy, finalizeAssistant, runtime],
  );

  const alwaysAllow = useCallback(
    (entry: ApprovalEntry): void => {
      try {
        const rule = buildAllowRule(entry.request, runtime.cwd);
        const result = addProjectAllowRule(runtime.cwd, rule);
        runtime.addAllowRule(rule);
        addSystem(
          result.added
            ? `已添加项目规则：${rule}\n写入：${result.file}`
            : `项目规则已存在：${rule}`,
        );
      } catch (error) {
        addSystem(`写入项目权限失败：${errorMessage(error)}（本次仍放行）`, true);
      }
      broker.respond(true);
    },
    [addSystem, broker, runtime],
  );

  const handleCommand = useCallback(
    async (raw: string): Promise<void> => {
      const [command, ...rest] = raw.slice(1).split(/\s+/);
      const argument = rest.join(' ').trim();

      switch (command) {
        case 'help':
          addSystem(HELP_TEXT);
          break;
        case 'clear': {
          runtime.newSession();
          const id = nextId.current;
          nextId.current += 1;
          setItems([
            {
              id,
              done: true,
              kind: 'system',
              text: `已开始新会话：${runtime.session.id}`,
            },
          ]);
          setUsage({ input: 0, output: 0 });
          break;
        }
        case 'model':
          if (argument) {
            runtime.setModel(argument);
            addSystem(`模型已切换为：${runtime.model}`);
          } else {
            addSystem(`当前模型：${runtime.model}`);
          }
          break;
        case 'provider':
          if (argument) {
            try {
              runtime.switchProvider(argument);
              addSystem(`Provider 已切换为：${runtime.providerId} / ${runtime.model}`);
            } catch (error) {
              addSystem(`切换失败：${errorMessage(error)}`, true);
            }
          } else {
            addSystem(`当前 Provider：${runtime.providerId}`);
          }
          break;
        case 'permissions': {
          if (argument) {
            const mode = PERMISSION_MODES.find((candidate) => candidate === argument);
            if (!mode) {
              addSystem(`无效模式：${argument}（可选：${PERMISSION_MODES.join(', ')}）`, true);
            } else {
              runtime.setPermissionMode(mode);
              addSystem(`权限模式已切换为：${runtime.permissionMode}`);
            }
          } else {
            addSystem(
              `权限模式：${runtime.permissionMode} · 规则数：${runtime.permissionRules.length}`,
            );
          }
          break;
        }
        case 'cost':
          addSystem(runtime.formatUsage());
          break;
        case 'models': {
          try {
            addSystem('正在拉取模型列表…');
            const models = await runtime.listModels();
            addSystem(
              models.length > 0
                ? models
                    .map((model) =>
                      model.displayName ? `${model.id} — ${model.displayName}` : model.id,
                    )
                    .join('\n')
                : '服务商未返回模型列表。',
            );
          } catch (error) {
            addSystem(`拉取模型列表失败：${errorMessage(error)}`, true);
          }
          break;
        }
        case 'status':
          addSystem(
            [
              `Provider：${runtime.providerId}`,
              `模型：${runtime.model}`,
              `权限：${runtime.permissionMode}`,
              `会话：${runtime.session.id}`,
              `目录：${runtime.cwd}`,
            ].join('\n'),
          );
          break;
        case 'compact': {
          addSystem('正在压缩上下文…');
          const result = await runtime.compactNow();
          addSystem(
            result
              ? `已压缩：省略 ${result.omittedMessages} 条，${result.beforeTokens} → ${result.afterTokens} tokens`
              : '当前会话过短，无需压缩',
          );
          break;
        }
        case 'quit':
        case 'exit':
          broker.cancelAll();
          runtime.close('exit');
          exit();
          break;
        default: {
          const expanded = runtime.expandCustomCommand(raw);
          if (expanded) {
            addSystem(`执行自定义命令：/${command}`);
            void runPrompt(expanded);
          } else {
            addSystem(`未知命令：/${command}。输入 /help 查看可用命令。`, true);
          }
          break;
        }
      }
    },
    [addSystem, broker, exit, runPrompt, runtime],
  );

  const handleSubmit = useCallback(
    (value: string): void => {
      const trimmed = value.trim();
      if (!trimmed || busy) return;
      inputRef.current = '';
      setInput('');

      if (trimmed.startsWith('/')) {
        void handleCommand(trimmed);
        return;
      }

      void runPrompt(trimmed);
    },
    [busy, handleCommand, runPrompt],
  );

  useInput((inputValue, key) => {
    if (approval) {
      if (key.ctrl) return;

      if (key.upArrow) {
        selectApproval((approvalIndexRef.current + 2) % 3);
        return;
      }
      if (key.downArrow) {
        selectApproval((approvalIndexRef.current + 1) % 3);
        return;
      }
      if (key.tab) {
        selectApproval((approvalIndexRef.current + (key.shift ? 2 : 1)) % 3);
        return;
      }
      if (inputValue === '1' || inputValue === '2' || inputValue === '3') {
        selectApproval(Number(inputValue) - 1);
        return;
      }
      if (key.return) {
        // 必须先显式选择，避免输入法提交用的 Enter 意外授权。
        if (!approvalNavigatedRef.current) return;

        const selected = approvalIndexRef.current;
        if (selected === 0) broker.respond(true);
        else if (selected === 1) alwaysAllow(approval);
        else broker.respond(false);
        return;
      }

      const lower = inputValue.toLowerCase();
      const shifted = key.shift || inputValue === inputValue.toUpperCase();

      if (lower === 'a' && !shifted) {
        broker.respond(true);
        return;
      }
      if (lower === 'a' && shifted) {
        alwaysAllow(approval);
        return;
      }
      if (lower === 'd' || key.escape) {
        broker.respond(false);
        return;
      }
      return;
    }

    if (key.ctrl && inputValue === 'c') {
      if (busy) {
        abortRef.current?.abort();
      } else {
        broker.cancelAll();
        runtime.close('exit');
        exit();
      }
      return;
    }

    if (key.ctrl && inputValue === 'd') {
      broker.cancelAll();
      runtime.close('exit');
      exit();
      return;
    }

    if (key.return) {
      handleSubmit(inputRef.current);
    }
  });

  const completed = useMemo(() => items.filter((item) => item.done), [items]);
  const live = items.filter((item) => !item.done);

  return (
    <Box flexDirection="column">
      <Static key={runtime.session.id} items={completed}>
        {(item) => <ItemView key={item.id} item={item} />}
      </Static>

      {live.map((item) => (
        <ItemView key={item.id} item={item} />
      ))}

      {approval ? (
        <ApprovalPrompt
          approval={approval}
          cwd={runtime.cwd}
          selected={approvalNavigated ? approvalIndex : -1}
        />
      ) : null}

      <Box marginTop={1}>
        {approval ? (
          <Text dimColor>先按 ↑/↓、Tab 或 1/2/3 选择，再按 Enter；也可直接按 a / Shift+A / d</Text>
        ) : busy ? (
          <Text dimColor>生成中… Ctrl+C 取消</Text>
        ) : (
          <>
            <Text color="cyan" bold>
              ›{' '}
            </Text>
            <TextInput
              value={input}
              onChange={handleInputChange}
              placeholder="输入消息，/help 查看命令"
            />
          </>
        )}
      </Box>

      <StatusBar
        provider={runtime.providerId}
        model={runtime.model}
        mode={runtime.permissionMode}
        sessionId={runtime.session.id}
        usage={usage}
        busy={busy}
      />
    </Box>
  );
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  return line.replace(/\s+/g, ' ').slice(0, 120);
}

function buildInitialItems(runtime: SessionRuntime): UiItem[] {
  const items: UiItem[] = [];
  let id = 0;

  for (const message of runtime.history()) {
    const text = textOf(message.content).trim();
    if (!text) continue;
    items.push({
      id,
      done: true,
      kind: message.role === 'user' ? 'user' : 'assistant',
      text,
    });
    id += 1;
  }

  const restored = items.length > 0 ? `\n已恢复 ${items.length} 条历史消息。` : '';
  items.push({
    id,
    done: true,
    kind: 'system',
    text:
      `${PRODUCT_NAME} ${VERSION} · ${runtime.providerId}/${runtime.model}\n` +
      `输入消息开始，/help 查看命令，Ctrl+C 取消或退出。${restored}`,
  });

  return items;
}

const HELP_TEXT = `可用命令：
  /help                显示帮助
  /clear               清空上下文并开始新会话
  /model [name]        查看或切换模型
  /models              拉取当前 Provider 的模型列表
  /provider [id]       查看或切换 Provider
  /permissions [mode]  查看或切换权限模式
  /cost                查看本次运行的 token 用量
  /status              查看当前状态
  /compact             压缩当前上下文
  /quit                退出

快捷键：Ctrl+C 取消生成 / 空闲时退出；Ctrl+D 退出；审批时 a/A/d。`;
