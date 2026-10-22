import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const fixture = path.join(repoRoot, 'scripts', 'fixtures', 'mcp-echo-server.mjs');

if (!fs.existsSync(cliPath)) {
  console.error('缺少 dist/cli.js，请先运行 npm run build');
  process.exit(1);
}

const server = http.createServer((request, response) => {
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404);
    response.end();
    return;
  }

  let raw = '';
  request.on('data', (chunk) => {
    raw += chunk;
  });
  request.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      response.writeHead(400);
      response.end('bad json');
      return;
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const toolMessages = messages.filter((message) => message.role === 'tool');
    const toolText = toolMessages.map((message) => String(message.content ?? '')).join('\n');

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const chunks =
      toolMessages.length > 0
        ? [
            `data: {"choices":[{"delta":{"content":"${toolText.includes('echo:from-mcp') ? 'MCP_OK' : 'MCP_BAD'}"}}]}\n\n`,
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ]
        : [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_mcp","type":"function","function":{"name":"mcp__echo_test__echo","arguments":"{\\"text\\":\\"from-mcp\\"}"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ];

    let index = 0;
    const timer = setInterval(() => {
      if (index >= chunks.length) {
        clearInterval(timer);
        response.end();
        return;
      }
      response.write(chunks[index]);
      index += 1;
    }, 10);
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const tmpRoot = path.join(repoRoot, '.tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const agentRoot = fs.mkdtempSync(path.join(tmpRoot, 'mcp-'));
const workspace = path.join(agentRoot, 'workspace');
const configDir = path.join(agentRoot, 'config');
const agentDir = path.join(workspace, '.agent');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });

fs.writeFileSync(
  path.join(configDir, 'settings.json'),
  JSON.stringify({ defaultProvider: 'mock' }),
  'utf8',
);
fs.writeFileSync(
  path.join(configDir, 'providers.json'),
  JSON.stringify({
    default: 'mock',
    providers: {
      mock: {
        type: 'openai',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'mock-model',
        apiKeyEnv: 'MOCK_KEY',
        maxContextTokens: 10_000,
        maxOutputTokens: 1_000,
      },
    },
  }),
  'utf8',
);
fs.writeFileSync(
  path.join(configDir, 'secrets.json'),
  JSON.stringify({ mock: 'e2e-test-key' }),
  'utf8',
);

fs.writeFileSync(
  path.join(agentDir, 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      'echo-test': {
        command: process.execPath,
        args: [fixture],
        timeoutMs: 15_000,
      },
    },
  }),
  'utf8',
);

const child = spawn(
  process.execPath,
  [cliPath, '-p', 'use mcp', '--permission-mode', 'acceptEdits', '--yes', '--debug'],
  {
    cwd: workspace,
    env: { ...process.env, AGENT_ROOT: agentRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const exitCode = await new Promise((resolve) => child.on('close', resolve));
server.close();
fs.rmSync(agentRoot, { recursive: true, force: true });

const failures = [];
if (exitCode !== 0) failures.push(`退出码应为 0，实际 ${exitCode}`);
if (!stdout.includes('MCP_OK')) failures.push('stdout 未包含 MCP_OK');
if (!stderr.includes('MCP Server "echo-test" 已连接')) {
  failures.push('未观察到 MCP Server 连接日志');
}
if (stderr.includes('e2e-test-key')) failures.push('stderr 泄漏了 API Key');

if (failures.length > 0) {
  console.error('MCP_E2E_FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`stdout: ${JSON.stringify(stdout)}`);
  console.error(`stderr: ${JSON.stringify(stderr)}`);
  process.exit(1);
}

console.log('MCP_E2E_OK');
console.log(`stdout: ${JSON.stringify(stdout.trim())}`);
console.log(`exit: ${exitCode}`);
