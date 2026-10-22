export type ShellKind = 'powershell' | 'cmd' | 'bash';

export interface ShellInvocation {
  command: string;
  args: string[];
}

export function defaultShellKind(): ShellKind {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

export function isShellKind(value: string): value is ShellKind {
  return value === 'powershell' || value === 'cmd' || value === 'bash';
}

/**
 * 平台差异集中在这里：业务代码只传"命令字符串"，不关心 shell 参数。
 */
export function buildShellInvocation(kind: ShellKind, command: string): ShellInvocation {
  switch (kind) {
    case 'powershell': {
      const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
      const prelude =
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
        '$OutputEncoding=[System.Text.Encoding]::UTF8; ';
      return {
        command: executable,
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `${prelude}${command}`,
        ],
      };
    }
    case 'cmd':
      return {
        command: process.env.ComSpec ?? 'cmd.exe',
        args: ['/d', '/s', '/c', command],
      };
    case 'bash':
      return {
        command: 'bash',
        args: ['-lc', command],
      };
  }
}
