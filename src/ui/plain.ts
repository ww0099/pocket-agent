import { createInterface } from 'node:readline/promises';

import type { AskHandler } from '../permissions/gate.js';
import { PERMISSION_MODES } from '../permissions/rules.js';
import type { SessionRuntime } from '../runtime/session-runtime.js';
import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/log.js';
import { PRODUCT_NAME, VERSION } from '../version.js';
import { toolInputSummary } from './tool-summary.js';

export interface StartPlainOptions {
  createRuntime: (ask: AskHandler) => SessionRuntime;
  logger: Logger;
}

export async function startPlain(options: StartPlainOptions): Promise<number> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });

  const ask: AskHandler = async (request, reason) => {
    const summary = toolInputSummary(request.tool, request.input);
    const detail = summary ? `\n  输入：${summary}` : '';
    const answer = await readline.question(
      `\n需要授权：${request.tool}${detail}\n  原因：${reason}\n允许？[y/N] `,
    );
    return /^y/i.test(answer.trim());
  };

  const runtime = options.createRuntime(ask);

  console.log(`${PRODUCT_NAME} ${VERSION} · plain 模式`);
  console.log(
    `Provider: ${runtime.providerId} / ${runtime.model} · 权限: ${runtime.permissionMode}`,
  );
  const restored = runtime.history().length;
  if (restored > 0) {
    console.log(`已恢复 ${restored} 条历史消息。`);
  }
  console.log('输入 /help 查看命令，/quit 退出。\n');

  const usage = { input: 0, output: 0 };
  let hadError = false;

  try {
    while (true) {
      let line: string;
      try {
        line = await readline.question('› ');
      } catch {
        break;
      }

      const input = line.trim();
      if (!input) continue;
      if (input === '/quit' || input === '/exit') break;

      let promptInput = input;

      if (input.startsWith('/')) {
        const handled = await handleCommand(input, runtime);
        if (handled === 'exit') break;
        if (handled !== 'unknown') continue;

        const expanded = runtime.expandCustomCommand(input);
        if (!expanded) {
          console.log(`未知命令：${input}。输入 /help 查看可用命令。`);
          continue;
        }
        promptInput = expanded;
      }

      const controller = new AbortController();
      const onSigint = (): void => {
        controller.abort(new DOMException('用户中断', 'AbortError'));
      };
      process.once('SIGINT', onSigint);

      try {
        for await (const event of runtime.runTurn(promptInput, controller.signal)) {
          switch (event.type) {
            case 'text_delta':
              process.stdout.write(event.text);
              break;
            case 'thinking_delta':
              if (runtime.debug) console.error(`[thinking] ${event.text}`);
              break;
            case 'tool_result':
              if (runtime.debug) {
                console.error(
                  `[tool] ${event.result.name} ${event.result.isError ? 'error' : 'ok'}`,
                );
              }
              break;
            case 'usage':
              usage.input += event.usage.inputTokens;
              usage.output += event.usage.outputTokens;
              break;
            case 'compaction':
              console.log(
                `\n[上下文已压缩] 省略 ${event.omittedMessages} 条，约 ${event.beforeTokens} → ${event.afterTokens} tokens`,
              );
              break;
            case 'error':
              hadError = true;
              console.error(`\n[错误] ${event.message}`);
              break;
            case 'notice':
              console.error(`[提示] ${event.text}`);
              break;
            default:
              break;
          }
        }
        process.stdout.write('\n');
      } catch (error) {
        if (controller.signal.aborted) {
          console.log('\n已取消');
        } else {
          hadError = true;
          console.error(`错误：${errorMessage(error)}`);
        }
      } finally {
        process.removeListener('SIGINT', onSigint);
      }
    }
  } finally {
    readline.close();
    runtime.close('exit');
  }

  return hadError ? 1 : 0;
}

async function handleCommand(
  input: string,
  runtime: SessionRuntime,
): Promise<'handled' | 'exit' | 'unknown'> {
  const [command, ...rest] = input.slice(1).split(/\s+/);
  const argument = rest.join(' ').trim();

  switch (command) {
    case 'help':
      printHelp();
      return 'handled';

    case 'clear':
      runtime.newSession();
      console.log('已开始新会话（上下文已清空）');
      return 'handled';

    case 'model':
      if (argument) {
        runtime.setModel(argument);
        console.log(`模型已切换为：${runtime.model}`);
      } else {
        console.log(`当前模型：${runtime.model}`);
      }
      return 'handled';

    case 'provider':
      if (argument) {
        try {
          runtime.switchProvider(argument);
          console.log(`Provider 已切换为：${runtime.providerId} / ${runtime.model}`);
        } catch (error) {
          console.error(`切换失败：${errorMessage(error)}`);
        }
      } else {
        console.log(`当前 Provider：${runtime.providerId}`);
      }
      return 'handled';

    case 'permissions': {
      if (argument) {
        const mode = PERMISSION_MODES.find((candidate) => candidate === argument);
        if (!mode) {
          console.error(`无效模式：${argument}（可选：${PERMISSION_MODES.join(', ')}）`);
        } else {
          runtime.setPermissionMode(mode);
          console.log(`权限模式已切换为：${runtime.permissionMode}`);
        }
      } else {
        console.log(
          `权限模式：${runtime.permissionMode} · 规则数：${runtime.permissionRules.length}`,
        );
      }
      return 'handled';
    }

    case 'cost':
      console.log(runtime.formatUsage());
      return 'handled';

    case 'models': {
      try {
        console.log('正在拉取模型列表…');
        const models = await runtime.listModels();
        if (models.length === 0) {
          console.log('服务商未返回模型列表。');
        } else {
          for (const model of models) {
            console.log(`  ${model.id}${model.displayName ? ` — ${model.displayName}` : ''}`);
          }
        }
      } catch (error) {
        console.error(`拉取模型列表失败：${errorMessage(error)}`);
      }
      return 'handled';
    }

    case 'status':
      console.log(
        [
          `Provider：${runtime.providerId}`,
          `模型：${runtime.model}`,
          `权限：${runtime.permissionMode}`,
          `会话：${runtime.session.id}`,
          `目录：${runtime.cwd}`,
        ].join('\n'),
      );
      return 'handled';

    case 'compact': {
      console.log('正在压缩上下文…');
      const result = await runtime.compactNow();
      console.log(
        result
          ? `已压缩：省略 ${result.omittedMessages} 条，${result.beforeTokens} → ${result.afterTokens} tokens`
          : '当前会话过短，无需压缩',
      );
      return 'handled';
    }

    case 'quit':
    case 'exit':
      return 'exit';

    default:
      return 'unknown';
  }
}

function printHelp(): void {
  console.log(`可用命令：
  /help                显示帮助
  /clear               清空上下文并开始新会话
  /model [name]        查看或切换模型
  /models              拉取当前 Provider 的模型列表
  /provider [id]       查看或切换 Provider
  /permissions [mode]  查看或切换权限模式
  /cost                查看本次运行的 token 用量
  /status              查看当前状态
  /compact             压缩当前上下文
  /quit                退出`);
}
