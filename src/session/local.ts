import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AppConfig } from '../config.js';
import type { Session, ShellType } from './types.js';

/** 判断配置文件里指定的 shell 属于哪个家族，决定 Windows / Unix 行为差异 */
export function shellFamily(program: string): 'windows' | 'unix' {
  if (process.platform === 'win32') {
    const base = path.basename(program).toLowerCase();
    // WSL / Git Bash 场景：程序名带 bash|zsh|sh 但跑在 Windows 上，按 unix 处理
    if (/^(bash|zsh|sh|fish)(\.exe)?$/.test(base)) return 'unix';
    return 'windows';
  }
  return 'unix';
}

export function shellTypeOf(program: string): ShellType {
  const base = path.basename(program).toLowerCase();
  if (base.includes('pwsh') || base.includes('powershell')) return 'powershell';
  if (base === 'cmd.exe' || base === 'cmd') return 'cmd';
  return 'unix';
}

export function createLocalSession(cfg: AppConfig): Session {
  const program = cfg.shell.program;
  const family = shellFamily(program);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...cfg.shell.env,
    AI_SHELL: '1',
    TERM: process.env.TERM || 'xterm-256color',
  };

  const child = spawn(program, cfg.shell.args ?? [], {
    cwd: process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const listeners: ((data: string) => void)[] = [];
  const exitListeners: ((code: number | null, signal: number | null) => void)[] = [];

  child.stdout?.on('data', (d: Buffer) => {
    const s = d.toString('utf8');
    for (const l of listeners) l(s);
  });
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString('utf8');
    for (const l of listeners) l(s);
  });
  child.on('close', (exitCode) => {
    for (const l of exitListeners) l(exitCode, null);
  });

  return {
    kind: 'local',
    label: `local:${path.basename(program)}`,
    osFamily: family,
    shellType: shellTypeOf(program),
    eol: family === 'windows' ? '\r\n' : '\n',
    write: (d) => {
      try {
        child.stdin?.write(d);
      } catch {
        /* noop */
      }
    },
    onData: (cb) => listeners.push(cb),
    resize: () => {
      /* standard child_process does not support pty resize */
    },
    close: () => {
      try {
        child.kill();
      } catch {
        /* noop */
      }
    },
    onExit: (cb) => exitListeners.push(cb),
  };
}
