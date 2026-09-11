#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig, writeDefaultConfig, configPath, type AppConfig } from './config.js';
import { Agent } from './core/agent.js';
import { Classifier, looksLikeNotFound } from './core/classifier.js';
import { checkRisk } from './core/safety.js';
import { createSshSession } from './session/ssh.js';
import type { Session } from './session/types.js';
import { captureExec, type ExecResult } from './term/capture.js';
import { InputHub, TerminalUI } from './term/ui.js';
import { handleSshCommand, promptLine } from './cli/hosts.js';
import { chooseTarget, printBanner } from './cli/launcher.js';
import { runSetupWizard, writeConfigExample } from './cli/setup.js';
import { ShellEngine } from './shell/engine.js';
import { LineEditor, type Completer } from './shell/line.js';
import { builtinNames, findOnPath } from './shell/builtin.js';
import path from 'node:path';

function usage(): void {
  process.stdout.write(
    `\x1b[36mai\x1b[0m — 自带 shell 的 AI 终端（不依赖系统 cmd / powershell 的语法）\n\n` +
      `  ai                     选择连接（本地 / 远程主机），确认后进 shell\n` +
      `  ai --local             跳过选择，直接进本地内置 shell\n` +
      `  ai --ssh <别名>        跳过选择，直连保存过的 Ubuntu 主机\n` +
      `  ai setup               交互式配置引导（大模型 / 远程主机 / 启动方式）\n` +
      `  ai ssh ls              列出保存的连接\n` +
      `  ai ssh add             交互式添加一个连接\n` +
      `  ai ssh rm <别名>       删除连接\n` +
      `  ai ssh init            生成默认配置文件\n` +
      `  ai config example      生成可直接手动替换的配置模板\n\n` +
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
    const dirPrefix =
      dir === '.' && !word.startsWith('./') && !word.startsWith('.\\')
        ? ''
        : dir.endsWith('/') || dir.endsWith('\\')
          ? dir
          : dir + '/';
    try {
      return fs
        .readdirSync(absDir)
        .filter((f) => f.startsWith(base))
        .map((f) => (dirPrefix ? dirPrefix + f : f))
        .sort();
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
  getCwd?: () => string;
  /** 用户手敲的命令；本地直接执行，SSH 则发给远端 */
  execUser: (line: string) => Promise<{ output: string; code: number; clear?: boolean; exit?: boolean }>;
  /** AI 发起的命令，需要拿到输出回灌给模型 */
  execCaptured: (cmd: string, timeoutMs?: number) => Promise<ExecResult>;
  /** 会话被动结束（如远端断开）时回调，用于把控制权交回上层 */
  registerClose?: (cb: () => void) => void;
  /** 退出时是否打印告别语（连接选择循环里由上层统一提示） */
  farewell?: boolean;
};

async function repl(cfg: AppConfig, env: ReplEnv): Promise<void> {
  const hub = new InputHub();
  const ui = new TerminalUI(cfg, hub);

  let aborted = false;
  const editor = new LineEditor(env.promptLine, env.history, env.completer, env.getCwd);
  const classifier = new Classifier(cfg, env.label);

  const agent = new Agent(cfg, {
    session: {
      kind: env.label.startsWith('ssh:') ? 'ssh' : 'local',
      label: env.label,
      osFamily: env.label.startsWith('ssh:') ? 'unix' : process.platform === 'win32' ? 'windows' : 'unix',
      shellType: 'unix',
      eol: env.label.startsWith('ssh:') ? '\n' : process.platform === 'win32' ? '\r' : '\n',
      write: () => {},
      onData: () => {},
      resize: () => {},
      close: () => {},
      onExit: () => {},
    },
    cfg,
    note: (t) => ui.note(t),
    confirm: (c, r) => ui.confirm(c, r),
    needAuth: (c, h, f) => ui.needAuth(c, h, f),
    editCommand: (c) => ui.editCommand(c),
    runCaptured: env.execCaptured,
    isAborted: () => aborted,
  });

  const isTty = Boolean(process.stdin.isTTY);
  if (isTty) process.stdin.setRawMode(true);

  const onSigInt = () => {
    aborted = true;
  };
  process.on('SIGINT', onSigInt);

  // 会话被动结束（远端断开）时不要卡在等待输入上，直接收尾
  let closed = false;
  env.registerClose?.(() => {
    closed = true;
    editor.interrupt();
  });

  const takeOver = async (goal: string, why?: string) => {
    aborted = false;
    if (why) ui.note(why);
    const cwd = env.getCwd ? env.getCwd() : process.cwd();
    await agent.run(goal, cwd);
  };

  try {
    for (;;) {
      if (closed) break;
      process.stdout.write(env.promptLine());
      const line = await editor.read();
      if (line === null) break;

      const t = line.trim();
      if (!t) continue;

      if (env.history[env.history.length - 1] !== t) env.history.push(t);

      // 1) 意图判定与前缀触发
      const normLower = t.toLowerCase();
      const hit = cfg.trigger.prefixes.find((p) => {
        const normP = p.toLowerCase();
        return normLower.startsWith(normP) || normLower === normP.trim();
      });

      let isAiGoal = false;
      let goal = '';

      if (hit && cfg.trigger.mode !== 'smart') {
        // 形如 `ai ssh ...` / `ai --local` / `ai 看看...` 都会命中 `ai ` 前缀。
        // 若后面跟着的是 ai 自身的子命令/参数，说明用户想把 ai 当命令调用
        // （例如 `ai ssh init` 去初始化连接），不能误判成 AI 目标再去调 LLM，
        // 否则 apiKey 未配置时会无限卡死。这些走普通命令透传即可。
        const rest = t.slice(hit.length).trim();
        const first = rest.split(/\s+/)[0].toLowerCase();
        const aiSub = ['ssh', 'init', 'config', '--local', '--ssh', '--help', '-h', 'help', 'local'];
        if (aiSub.includes(first)) {
          isAiGoal = false;
        } else {
          isAiGoal = true;
          goal = rest;
          if (!goal) {
            ui.warn('想让我做什么？例如：ai 看看哪个目录最占空间');
            continue;
          }
        }
      } else if (cfg.trigger.mode === 'smart' || (cfg.trigger.mode === 'hybrid' && !hit)) {
        const cRes = await classifier.classify(t);
        if (cRes.verdict === 'NL') {
          isAiGoal = true;
          goal = hit ? t.slice(hit.length).trim() : t;
        }
      }

      if (isAiGoal) {
        await takeOver(goal);
        continue;
      }

      // 2) 普通命令
      // 手敲的危险命令也要确认（默认开启，safety.confirmManual 可关）。
      // 只按高危黑名单判定，不会因为 `echo x > f` 这类日常写文件而打扰。
      // 非交互（管道 / 脚本）与 SSH 会话不拦：前者没法问、后者远端是真实主机，
      // 误判会打断正常运维节奏。
      let cmd = t;
      if (cfg.safety.confirmManual && env.label === 'local' && isTty) {
        const risk = checkRisk(cmd, cfg, 'dangerous');
        if (risk.risky) {
          const ans = await ui.confirm(cmd, risk.reason);
          if (ans === 'no') {
            ui.note('已取消，未执行。');
            continue;
          }
          if (ans === 'edit') {
            const edited = await ui.editCommand(cmd);
            if (!edited) {
              ui.note('已取消，未执行。');
              continue;
            }
            cmd = edited;
          }
        }
      }

      const r = await env.execUser(cmd);
      if (r.clear) {
        process.stdout.write('\x1b[2J\x1b[H');
        continue;
      }
      if (r.exit) break;
      if (r.output) process.stdout.write(r.output.replace(/\n$/, '') + '\n');

      // 3) 兜底：说人话却被当成命令，报了「未找到命令」时自动接管。
      // 但 `ai ssh ...` 这类 ai 自身子命令报找不到时，不要接 AI（可能是路径问题），
      // 否则又会绕回调 LLM 卡死。
      if (
        cfg.trigger.fallbackOnNotFound &&
        !/^ai\s+(ssh|init|config|--local|--ssh|--help|-h|help|local)\b/i.test(cmd) &&
        looksLikeNotFound(r.output, cmd)
      ) {
        await takeOver(t, '这句不像命令，交给 AI 试试');
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigInt);
    try {
      if (isTty) process.stdin.setRawMode(false);
    } catch {
      /* noop */
    }
  }
  if (env.farewell !== false) process.stdout.write('\r\n再见。\r\n');
}

async function runLocalShell(cfg: AppConfig, farewell = true): Promise<void> {
  const engine = new ShellEngine();

  await repl(cfg, {
    label: 'local',
    farewell,
    promptLine: () => engine.prompt(),
    completer: makeCompleter(engine),
    history: engine.history,
    getCwd: () => engine.cwd,
    execUser: async (line) => {
      const r = await engine.exec(line);
      return r;
    },
    execCaptured: async (cmd, timeoutMs) => {
      // AI 的命令也要过一遍危险确认，并在终端留痕
      process.stdout.write(`\r\n\x1b[36m$ ${cmd}\x1b[0m\r\n`);
      const r = await engine.exec(cmd, timeoutMs);
      if (r.output) process.stdout.write(r.output.replace(/\n$/, '') + '\n');
      return { output: r.output, exitCode: r.code, timedOut: false };
    },
  });
}

/** 独立调用（ai --ssh x / ai ssh use x）时 standalone=true，会直接结束进程；选择器里调用则为 false */
async function runSshShell(cfg: AppConfig, name: string, standalone = true): Promise<boolean> {
  const host = cfg.ssh.hosts.find((h) => h.name === name);
  if (!host) {
    process.stderr.write(`没有保存的连接：${name}\n`);
    if (cfg.ssh.hosts.length) {
      process.stderr.write(`可选：${cfg.ssh.hosts.map((h) => h.name).join(', ')}\n`);
    } else {
      process.stderr.write('先用 ai ssh add 添加一个连接。\n');
    }
    if (standalone) process.exitCode = 1;
    return false;
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
    if (standalone) process.exitCode = 1;
    return false;
  }

  let activeCapture: ReturnType<typeof captureExec> | null = null;
  let closedByRemote = false;
  const history: string[] = [];

  session.onData((d) => {
    const out = activeCapture ? activeCapture.feed(d) : d;
    process.stdout.write(out);
  });

  // 远端主动断开（如敲了 exit / 网络掉线）：标记后交由 repl 收尾
  let closeCb: (() => void) | undefined;
  session.onExit(() => {
    if (closedByRemote) return;
    closedByRemote = true;
    process.stdout.write('\r\n\x1b[2m远端连接已关闭。\x1b[0m\r\n');
    closeCb?.();
  });

  // 关掉远端回显：输入由我们自己的行编辑器负责，避免重复显示
  setTimeout(() => {
    session.write('stty -echo 2>/dev/null; export PS1="\\u@\\h:\\w\\$ "\n');
  }, 600);

  const prompt = () => `\x1b[36m${host.username}@${host.name}\x1b[0m \x1b[35m$\x1b[0m `;

  process.stdout.write(`\x1b[32m已连接 ${host.name}\x1b[0m \x1b[2m(${host.username}@${host.host})\x1b[0m\r\n`);

  await repl(cfg, {
    label: `ssh:${host.name}`,
    farewell: standalone,
    registerClose: (cb) => {
      closeCb = cb;
    },
    promptLine: prompt,
    completer: () => [],
    history,
    execUser: async (line) => {
      // 用户手敲：直接透传，不包标记（避免交互式命令被标记卡住）
      session.write(line + '\n');
      return { output: '', code: 0 };
    },
    execCaptured: (cmd, timeoutMs) =>
      new Promise<ExecResult>((resolve) => {
        process.stdout.write(`\r\n\x1b[36m$ ${cmd}\x1b[0m\r\n`);
        const handle = captureExec(session, cmd, 'unix', timeoutMs ?? 30000, {
          // 远端已 stty -echo，没有回显，不能跳过第一行
          skipEcho: false,
          // 嗅到密码提示立刻中断，不干等超时
          abortOnPrompt: true,
          emit: (chunk) => process.stdout.write(chunk),
        });
        activeCapture = handle;
        handle.result.then((r) => {
          activeCapture = null;
          resolve(r);
        });
      }),
  });

  closedByRemote = true; // 主动收尾，避免 onExit 再报一次「远端已关闭」
  session.close();
  return true;
}

/** 连接选择 -> 打开 shell 的循环 */
async function launchLoop(cfg: AppConfig): Promise<void> {
  printBanner();
  for (;;) {
    const target = await chooseTarget(cfg);
    if (!target) return;

    if (target.kind === 'local') {
      await runLocalShell(cfg, false);
    } else {
      await runSshShell(cfg, target.host.name, false);
    }

    if (!cfg.startup.returnToPicker) return;
    process.stdout.write('\r\n\x1b[2m本次会话已结束。\x1b[0m\r\n');
  }
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

  if (argv[0] === 'setup' || argv[0] === 'wizard') {
    await runSetupWizard();
    return;
  }

  if (argv[0] === 'config' || argv[0] === 'init') {
    const sub = argv[1];
    if (sub === 'example' || sub === 'template') {
      const p = writeConfigExample();
      process.stdout.write(
        `已生成配置模板：${p}\n\n` +
          `手动替换的步骤：\n` +
          `  1. 打开模板，把 llm.apiKey 填成你的真实 Key（baseURL / 模型名按服务商改）\n` +
          `  2. 需要连服务器的话，填好 ssh.hosts 里的 host / username / password 或 privateKeyPath\n` +
          `  3. 覆盖到：${configPath()}\n` +
          `     （覆盖前会自动把原文件备份成 config.json.bak）\n\n` +
          `也可以直接运行 ai setup 跟着问答走，不用手改 JSON。\n`,
      );
      return;
    }
    const p = writeDefaultConfig();
    process.stdout.write(`${fs.existsSync(p) ? '配置已存在' : '已生成配置'}：${p}\n`);
    if (!process.stdin.isTTY) return;
    const go = (await promptLine('现在进入配置引导（一步步问，可直接回车跳过）? [Y/n]: ')).trim().toLowerCase();
    if (go === '' || go === 'y') await runSetupWizard();
    return;
  }

  // 显式指定本地：跳过连接选择
  if (argv[0] === 'local' || argv.includes('--local')) {
    await runLocalShell(cfg);
    return;
  }

  // 默认：先选连接（本地 / 远程主机），确认之后再进 shell
  if (cfg.startup.mode === 'local') {
    await runLocalShell(cfg);
    return;
  }

  // 非交互场景（管道、脚本）没法选择，退回本地，保持可脚本化
  if (!process.stdin.isTTY) {
    await runLocalShell(cfg);
    return;
  }

  await launchLoop(cfg);
}

void findOnPath; // 保留导出，供补全与调试使用

main().catch((e) => {
  process.stderr.write(`启动失败：${(e as Error).stack || (e as Error).message}\n`);
  process.exitCode = 1;
});
