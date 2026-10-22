import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');

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

  if (request.headers.authorization !== 'Bearer e2e-test-key') {
    response.writeHead(401);
    response.end('bad key');
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
    const hasToolResult = messages.some((message) => message.role === 'tool');

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const chunks = hasToolResult
      ? [
          'data: {"choices":[{"delta":{"content":"DONE"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ]
      : [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Write","arguments":"{\\"file_path\\":\\"note.txt\\",\\"content\\":\\"hello from tool\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
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
const agentRoot = fs.mkdtempSync(path.join(tmpRoot, 'e2e-'));
const workspace = path.join(agentRoot, 'workspace');
const configDir = path.join(agentRoot, 'config');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });

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
        maxContextTokens: 1000,
        maxOutputTokens: 100,
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

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: workspace,
      env: { ...process.env, AGENT_ROOT: agentRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const first = await runCli([
  '-p',
  'create note.txt',
  '--permission-mode',
  'acceptEdits',
  '--debug',
]);

const notePath = path.join(workspace, 'note.txt');
const noteContent = fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf8') : '';
const sessionRoot = path.join(agentRoot, 'data', 'sessions');
const sessionFiles = fs.existsSync(sessionRoot)
  ? fs
      .readdirSync(sessionRoot, { recursive: true })
      .filter((entry) => String(entry).endsWith('.jsonl'))
  : [];

const sessionId = sessionFiles.length > 0 ? path.basename(String(sessionFiles[0]), '.jsonl') : '';
const second = sessionId
  ? await runCli([
      '--resume',
      sessionId,
      '-p',
      'again',
      '--permission-mode',
      'acceptEdits',
      '--yes',
    ])
  : { code: 1, stdout: '', stderr: '没有可恢复的会话' };

server.close();

const failures = [];
if (first.code !== 0) failures.push(`首次运行退出码应为 0，实际 ${first.code}`);
if (!first.stdout.includes('DONE')) failures.push('首次 stdout 未包含最终回答 DONE');
if (noteContent !== 'hello from tool') {
  failures.push(`工具未正确写文件，note.txt 内容为 ${JSON.stringify(noteContent)}`);
}
if (sessionFiles.length === 0) failures.push('未生成会话 JSONL');
if (second.code !== 0) failures.push(`恢复会话退出码应为 0，实际 ${second.code}`);
if (!second.stdout.includes('DONE')) failures.push('恢复会话后未得到回答');
if (first.stderr.includes('e2e-test-key') || second.stderr.includes('e2e-test-key')) {
  failures.push('stderr 泄漏了 API Key');
}

fs.rmSync(agentRoot, { recursive: true, force: true });

if (failures.length > 0) {
  console.error('E2E_FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`first stdout: ${JSON.stringify(first.stdout)}`);
  console.error(`first stderr: ${JSON.stringify(first.stderr)}`);
  console.error(`second stdout: ${JSON.stringify(second.stdout)}`);
  console.error(`second stderr: ${JSON.stringify(second.stderr)}`);
  process.exit(1);
}

console.log('E2E_OK');
console.log(`stdout: ${JSON.stringify(first.stdout.trim())}`);
console.log(`note.txt: ${JSON.stringify(noteContent)}`);
console.log(`session files: ${sessionFiles.length}`);
console.log(`session id: ${sessionId}`);
console.log(`resume stdout: ${JSON.stringify(second.stdout.trim())}`);
console.log(`exit: ${first.code}/${second.code}`);
