import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const agentRoot = process.env.AGENT_ROOT_UNDER_TEST ?? 'E:\\agent';
const agentCmd = path.join(agentRoot, 'agent.cmd');
const workspace = path.join(agentRoot, 'workspace', 'bench');
fs.mkdirSync(workspace, { recursive: true });

if (!fs.existsSync(agentCmd)) {
  console.error(`缺少启动器：${agentCmd}`);
  process.exit(1);
}

const cmdExe = process.env.ComSpec ?? 'cmd.exe';

function runVersion() {
  const started = process.hrtime.bigint();
  const result = spawnSync(cmdExe, ['/d', '/s', '/c', agentCmd, '--version'], {
    encoding: 'utf8',
  });
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  return { elapsed, code: result.status, stdout: (result.stdout ?? '').trim() };
}

function runPlain() {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(cmdExe, ['/d', '/s', '/c', agentCmd, '--plain'], {
      cwd: workspace,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let promptElapsed = null;
    let sentQuit = false;

    const quit = () => {
      if (sentQuit) return;
      sentQuit = true;
      child.stdin.write('/quit\n');
      child.stdin.end();
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (promptElapsed === null && stdout.includes('› ')) {
        promptElapsed = Number(process.hrtime.bigint() - started) / 1e6;
        quit();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    setTimeout(quit, 5_000);

    child.on('close', (code) => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ elapsed, promptElapsed, code, stdout, stderr });
    });
  });
}

const versionRuns = [];
for (let index = 0; index < 5; index += 1) {
  versionRuns.push(runVersion());
}

const plainRuns = [];
for (let index = 0; index < 3; index += 1) {
  plainRuns.push(await runPlain());
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

console.log('START_BENCH');
console.log(`version_ms: ${versionRuns.map((run) => run.elapsed.toFixed(0)).join(', ')}`);
console.log(`version_median_ms: ${median(versionRuns.map((run) => run.elapsed)).toFixed(0)}`);
console.log(
  `plain_prompt_ms: ${plainRuns
    .map((run) => (run.promptElapsed ?? Number.NaN).toFixed(0))
    .join(', ')}`,
);
console.log(
  `plain_prompt_median_ms: ${median(
    plainRuns.map((run) => run.promptElapsed ?? Number.NaN),
  ).toFixed(0)}`,
);
console.log(`plain_total_ms: ${plainRuns.map((run) => run.elapsed.toFixed(0)).join(', ')}`);

const failed = [...versionRuns, ...plainRuns].filter((run) => run.code !== 0);
if (failed.length > 0) {
  console.error(`有 ${failed.length} 次启动失败`);
  for (const run of failed) {
    console.error(
      `- code=${run.code} stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`,
    );
  }
  process.exit(1);
}
