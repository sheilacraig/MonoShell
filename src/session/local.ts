import path from 'node:path';
import * as pty from 'node-pty';
import type { AppConfig } from '../config.js';
import type { Session, ShellType } from './types.js';
import { termSize } from './types.js';

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
  const { cols, rows } = termSize();

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...cfg.shell.env,
    AI_SHELL: '1',
    TERM: process.env.TERM || 'xterm-256color',
  };

  const proc = pty.spawn(program, cfg.shell.args ?? [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env,
    useConpty: process.platform === 'win32' ? true : undefined,
  } as pty.IPtyForkOptions);

  const listeners: ((data: string) => void)[] = [];
  const exitListeners: ((code: number | null, signal: number | null) => void)[] = [];

  proc.onData((d) => {
    for (const l of listeners) l(d);
  });
  proc.onExit(({ exitCode, signal }) => {
    for (const l of exitListeners) l(exitCode, signal ?? null);
  });

  return {
    kind: 'local',
    label: `local:${path.basename(program)}`,
    osFamily: family,
    shellType: shellTypeOf(program),
    eol: family === 'windows' ? '\r' : '\n',
    write: (d) => proc.write(d),
    onData: (cb) => listeners.push(cb),
    resize: (c, r) => {
      try {
        proc.resize(c, r);
      } catch {
        /* 会话已退出 */
      }
    },
    close: () => {
      try {
        proc.kill();
      } catch {
        /* noop */
      }
    },
    onExit: (cb) => exitListeners.push(cb),
  };
}
