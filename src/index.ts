#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig, writeDefaultConfig, type AppConfig } from './config.js';
import { Agent } from './core/agent.js';
import { looksLikeNotFound } from './core/classifier.js';
import { createSshSession } from './session/ssh.js';
import type { Session } from './session/types.js';
import { captureExec, type ExecResult } from './term/capture.js';
import { InputHub, TerminalUI } from './term/ui.js';
import { handleSshCommand, promptLine } from './cli/hosts.js';
import { ShellEngine } from './shell/engine.js';
import { LineEditor, type Completer } from './shell/line.js';
import { builtinNames, findOnPath } from './shell/builtin.js';
import path from 'node:path';

function usage(): void {
  process.stdout.write(
    `\x1b[36mai\x1b[0m — 自带 shell 的 AI 终端（不依赖系统 cmd / powershell 的语法）\n\n` +
      `  ai                     启动本地内置 shell\n` +
      `  ai --ssh <别名>        直连保存过的 Ubuntu 主机\n` +
      `  ai ssh ls              列出保存的连接\n` +
      `  ai ssh add             交互式添加一个连接\n` +
      `  ai ssh rm <别名>       删除连接\n` +
      `  ai ssh init            生成默认配置文件\n\n` +
      `会话内：\n` +
      `  直接敲命令            内置 shell 执行（ls/cat/grep/du/df 等已内置）\n` +
      `  ai <自然语言>          交给 AI（前缀可在配置里改）\n` +
      `  Tab 补全 / ↑↓ 历史    自带行编辑，不依赖宿主 shell\n` +
      `  Ctrl+C 中断 / Ctrl+D 退出\n`,
  );
}

function makeCompleter(engine: ShellEngine): Completer {
  let exeCache: string[] | null = null;
  return (line, cursor) => {
    const before = line.slice(0, cursor);
    const wordStart = Math.max(before.lastIndexOf(' ') + 1, 0);
    const word = before.slice(wordStart);

    if (wordStart === 0) {
      if (!exeCache) {
        const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
        const set = new Set<string>();
        for (const d of dirs) {
          try {
            for (const f of fs.readdirSync(d)) {
              if (process.platform === 'win32') {
                const low = f.toLowerCase();
                if (low.endsWith('.exe') || low.endsWith('.cmd') || low.endsWith('.bat')) {
                  set.add(f.slice(0, f.lastIndexOf('.')));
                }
              } else {
                set.add(f);
              }
            }
          } catch {
            /* noop */
          }
        }
        exeCache = [...set];
      }
      return [...builtinNames(), ...exeCache].filter((c) => c.toLowerCase().startsWith(word.toLowerCase())).sort();
    }

    const dir = path.dirname(word) || '.';
    const base = path.basename(word);
    const absDir = path.resolve(engine.cwd, dir.replace(/^~/, os.homedir()));
    try {
      return fs.readdirSync(absDir).filter((f) => f.startsWith(base)).sort();
    } catch {
      return [];
    }
  };
}

type ReplEnv = {
  label: string;
  promptLine: () => string;
  completer: Completer;
  history: string[];
  /** 用户手敲的命令；本地直接执行，SSH 则发给远端 */
  execUser: (line: string) => Promise<{ output: string; code: number; clear?: boolean; exit?: boolean }>;
  /** AI 发起的命令，需要拿到输出回灌给模型 */
  execCaptured: (cmd: string) => Promise<ExecResult>;
};

async function repl(cfg: AppConfig, env: ReplEnv): Promise<void> {
  const hub = new InputHub();
  const ui = new TerminalUI(cfg, hub);

  let aborted = false;
  const editor = new LineEditor(env.promptLine, env.history, env.completer);

  const agent = new Agent(cfg, {
    session: {
      kind: env.label.startsWith('ssh:') ? 'ssh' : 'local',
      label: env.label,
      osFamily: env.label.startsWith('ssh:') ? 'unix' : 'windows',
      shellType: env.label.startsWith('ssh:') ? 'unix' : 'powershell',
      eol: env.label.startsWith('ssh:') ? '\n' : '\r',
      write: () => {},
      onData: () => {},
      resize: () => {},
      close: () => {},
      onExit: () => {},
    },
    cfg,
    note: (t) => ui.note(t),
    confirm: (c, r) => ui.confirm(c, r),
    editCommand: (c) => ui.editCommand(c),
    runCaptured: env.execCaptured,
    isAborted: () => aborted,
  });

  const isTty = Boolean(process.stdin.isTTY);
  if (isTty) process.stdin.setRawMode(true);

  const takeOver = async (goal: string, why?: string) => {
    aborted = false;
    if (why) ui.note(why);
    await agent.run(goal);
  };

  try {
    for (;;) {
      process.stdout.write(env.promptLine());
      const line = await editor.read();
      if (line === null) break;

      const t = line.trim();
      if (!t) continue;

      if (env.history[env.history.length - 1] !== t) env.history.push(t);

      // 1) AI 前缀
      if (cfg.trigger.mode !== 'smart') {
        const hit = cfg.trigger.prefixes.find((p) => t.toLowerCase().startsWith(p.trim().toLowerCase()));
        if (hit) {
          const goal = t.slice(hit.length).trim();
          if (!goal) {
            ui.warn('想让我做什么？例如：ai 看看哪个目录最占空间');
            continue;
          }
          await takeOver(goal);
          continue;
        }
      }

      // 2) 普通命令
      const r = await env.execUser(t);
      if (r.clear) {
        process.stdout.write('\x1b[2J\x1b[H');
        continue;
      }
      if (r.exit) break;
      if (r.output) process.stdout.write(r.output.replace(/\n$/, '') + '\n');

      // 3) 兜底：说人话却被当成命令，报了「未找到命令」时自动接管
      if (cfg.trigger.fallbackOnNotFound && looksLikeNotFound(r.output, t)) {
        await takeOver(t, '这句不像命令，交给 AI 试试');
      }
    }
  } finally {
    try {
      if (isTty) process.stdin.setRawMode(false);
    } catch {
      /* noop */
    }
  }
  process.stdout.write('\r\n再见。\r\n');
}

async function runLocalShell(cfg: AppConfig): Promise<void> {
  const engine = new ShellEngine();

  await repl(cfg, {
    label: 'local',
    promptLine: () => engine.prompt(),
    completer: makeCompleter(engine),
    history: engine.history,
    execUser: async (line) => {
      const r = await engine.exec(line);
      return r;
    },
    execCaptured: async (cmd) => {
      // AI 的命令也要过一遍危险确认，并在终端留痕
      process.stdout.write(`\r\n\x1b[36m$ ${cmd}\x1b[0m\r\n`);
      const r = await engine.exec(cmd);
      if (r.output) process.stdout.write(r.output.replace(/\n$/, '') + '\n');
      return { output: r.output, exitCode: r.code, timedOut: false };
    },
  });
}

async function runSshShell(cfg: AppConfig, name: string): Promise<void> {
  const host = cfg.ssh.hosts.find((h) => h.name === name);
  if (!host) {
    process.stderr.write(`没有保存的连接：${name}\n`);
    if (cfg.ssh.hosts.length) {
      process.stderr.write(`可选：${cfg.ssh.hosts.map((h) => h.name).join(', ')}\n`);
    } else {
      process.stderr.write('先用 ai ssh add 添加一个连接。\n');
    }
    process.exitCode = 1;
    return;
  }
  if (!host.password && !host.privateKeyPath) {
    host.password = await promptLine(`${host.username}@${host.host} 密码 (不回显): `, true);
  }

  process.stdout.write(`\x1b[2m连接 ${host.username}@${host.host}:${host.port ?? 22} ...\x1b[0m\r\n`);
  let session: Session;
  try {
    session = await createSshSession(host);
  } catch (e) {
    process.stderr.write(`连接失败：${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  let activeCapture: ReturnType<typeof captureExec> | null = null;
  const history: string[] = [];

  session.onData((d) => {
    const out = activeCapture ? activeCapture.feed(d) : d;
    process.stdout.write(out);
  });

  // 关掉远端回显：输入由我们自己的行编辑器负责，避免重复显示
  setTimeout(() => {
    session.write('stty -echo 2>/dev/null; export PS1="\\u@\\h:\\w\\$ "\n');
  }, 600);

  const prompt = () => `\x1b[36m${host.username}@${host.name}\x1b[0m \x1b[35m$\x1b[0m `;

  await repl(cfg, {
    label: `ssh:${host.name}`,
    promptLine: prompt,
    completer: () => [],
    history,
    execUser: async (line) => {
      // 用户手敲：直接透传，不包标记（避免交互式命令被标记卡住）
      session.write(line + '\n');
      return { output: '', code: 0 };
    },
    execCaptured: (cmd) =>
      new Promise<ExecResult>((resolve) => {
        process.stdout.write(`\r\n\x1b[36m$ ${cmd}\x1b[0m\r\n`);
        const handle = captureExec(session, cmd, 'unix', 30000, {
          // 远端已 stty -echo，没有回显，不能跳过第一行
          skipEcho: false,
        });
        activeCapture = handle;
        handle.result.then((r) => {
          activeCapture = null;
          resolve(r);
        });
      }),
  });

  session.close();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes('-h') || argv.includes('--help') || argv[0] === 'help') {
    usage();
    return;
  }

  const cfg = loadConfig();

  if (argv[0] === 'ssh') {
    const sub = argv[1];
    if ((sub === 'use' || sub === 'connect') && argv[2]) {
      await runSshShell(cfg, argv[2]);
      return;
    }
    await handleSshCommand(argv.slice(1));
    return;
  }

  const sshIdx = argv.indexOf('--ssh');
  if (sshIdx >= 0) {
    const name = argv[sshIdx + 1];
    if (!name) {
      process.stderr.write('用法：ai --ssh <别名>\n');
      process.exitCode = 1;
      return;
    }
    await runSshShell(cfg, name);
    return;
  }

  if (argv[0] === 'config' || argv[0] === 'init') {
    const p = writeDefaultConfig();
    process.stdout.write(`${fs.existsSync(p) ? '配置已存在' : '已生成配置'}：${p}\n`);
    return;
  }

  await runLocalShell(cfg);
}

void findOnPath; // 保留导出，供补全与调试使用

main().catch((e) => {
  process.stderr.write(`启动失败：${(e as Error).stack || (e as Error).message}\n`);
  process.exitCode = 1;
});
