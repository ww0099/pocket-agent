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

  request.resume();
  request.on('end', () => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const chunks = [
      'data: {"choices":[{"delta":{"content":"PLAIN_OK"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
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
const agentRoot = fs.mkdtempSync(path.join(tmpRoot, 'plain-'));
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

const child = spawn(process.execPath, [cliPath], {
  cwd: workspace,
  env: { ...process.env, AGENT_ROOT: agentRoot },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) return false;
    await delay(20);
  }
  return true;
}

const promptCount = () => (stdout.match(/› /g) ?? []).length;

child.stdin.write('hello\n');
await waitFor(() => stdout.includes('PLAIN_OK') && promptCount() >= 2);

child.stdin.write('/help\n');
await waitFor(() => stdout.includes('可用命令'));

await waitFor(() => promptCount() >= 3);
child.stdin.write('/cost\n');
await waitFor(() => stdout.includes('输入 tokens'));

await waitFor(() => promptCount() >= 4);
child.stdin.write('/quit\n');
child.stdin.end();

const exitCode = await new Promise((resolve) => child.on('close', resolve));
server.close();
fs.rmSync(agentRoot, { recursive: true, force: true });

const failures = [];
if (exitCode !== 0) failures.push(`退出码应为 0，实际 ${exitCode}`);
if (!stdout.includes('PLAIN_OK')) failures.push('stdout 未包含模型回复 PLAIN_OK');
if (!stdout.includes('可用命令')) failures.push('/help 未输出命令列表');
if (!stdout.includes('输入 tokens')) failures.push('/cost 未输出用量');
if (stderr.includes('e2e-test-key')) failures.push('stderr 泄漏了 API Key');

if (failures.length > 0) {
  console.error('PLAIN_E2E_FAILED');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`stdout: ${JSON.stringify(stdout)}`);
  console.error(`stderr: ${JSON.stringify(stderr)}`);
  process.exit(1);
}

console.log('PLAIN_E2E_OK');
console.log(`stdout contains model reply: ${stdout.includes('PLAIN_OK')}`);
console.log(`exit: ${exitCode}`);
