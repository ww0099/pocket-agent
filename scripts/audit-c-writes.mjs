import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const agentRoot = process.env.AGENT_ROOT_UNDER_TEST ?? 'E:\\agent';
const agentCmd = path.join(agentRoot, 'agent.cmd');
const workspace = path.join(agentRoot, 'workspace', 'c-audit');
fs.mkdirSync(workspace, { recursive: true });

if (!fs.existsSync(agentCmd)) {
  console.error(`缺少启动器：${agentCmd}`);
  process.exit(1);
}

const watchPaths = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Temp'),
  path.join(process.env.LOCALAPPDATA ?? '', 'npm-cache'),
  path.join(process.env.APPDATA ?? '', 'npm-cache'),
].filter((candidate) => candidate && fs.existsSync(candidate));

const events = [];
const watchers = [];

for (const watchPath of watchPaths) {
  try {
    const watcher = fs.watch(watchPath, { recursive: false }, (eventType, filename) => {
      if (!filename) return;
      events.push({
        root: watchPath,
        event: eventType,
        file: String(filename),
        at: new Date().toISOString(),
      });
    });
    watchers.push(watcher);
  } catch (error) {
    console.warn(`无法监视 ${watchPath}: ${error.message}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const prompt =
  '请在当前目录创建 c-audit.txt，内容为 audit；然后读取它；最后只回复 C_AUDIT_OK。不要执行其他命令。';

const child = spawn(
  process.env.ComSpec ?? 'cmd.exe',
  ['/d', '/s', '/c', agentCmd, '--permission-mode', 'acceptEdits', '--yes', '-p', '-'],
  {
    cwd: workspace,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
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
child.stdin.write(prompt);
child.stdin.end();

const exitCode = await new Promise((resolve) => child.on('close', resolve));
await delay(1_500);
for (const watcher of watchers) watcher.close();

const interesting = events.filter((entry) => {
  const base = path.basename(entry.file).toLowerCase();
  return base !== 'desktop.ini' && base !== 'thumbs.db';
});

console.log('C_AUDIT_RESULT');
console.log(`agent: ${agentCmd}`);
console.log(`workspace: ${workspace}`);
console.log(`watched: ${watchPaths.join(' | ') || '(none)'}`);
console.log(`exit: ${exitCode}`);
console.log(`stdout: ${JSON.stringify(stdout.trim())}`);
console.log(`stderr: ${JSON.stringify(stderr.trim())}`);
console.log(`c_events: ${interesting.length}`);

for (const entry of interesting.slice(0, 50)) {
  console.log(`- ${entry.event} ${path.join(entry.root, entry.file)} @ ${entry.at}`);
}

if (exitCode !== 0) {
  console.error('审计任务本身失败');
  process.exit(1);
}

if (interesting.length > 0) {
  console.error('检测到 C 盘写入事件（需要人工确认归属）');
  process.exit(1);
}

console.log('C_AUDIT_OK（未观察到 C 盘 Temp/npm 缓存写入）');
