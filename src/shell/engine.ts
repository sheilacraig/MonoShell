import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findOnPath, isBuiltin, runBuiltin, type CmdCtx, type CmdResult } from './builtin.js';
import { expandGlobs, parseLine, splitStatements, type Segment } from './parser.js';

export type ExecOutcome = {
  output: string;
  code: number;
  clear?: boolean;
  exit?: boolean;
};

/**
 * 执行选项。两个都是可选的加成项，不改变 exec 的返回值语义。
 */
export type ExecOpts = {
  /** 用户按 Ctrl+C 时由调用方 abort，engine 据此杀掉子进程 */
  signal?: AbortSignal;
  /**
   * 实时流式拿输出（长耗时命令不至于界面卡死无输出）。
   * 声明它之后 output 仍照常累积 —— 调用方的「未找到命令」兜底判定要靠 output，
   * 图省事把 output 抹掉会让 AI 兜底直接失效。
   */
  onData?: (chunk: string) => void;
};

/** 中断时的约定退出码（128 + SIGINT），与常见 shell 一致 */
export const INTERRUPT_CODE = 130;

type SpawnOpts = {
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  onData?: (chunk: string) => void;
  signal?: AbortSignal;
  /** 把「杀掉本次子进程」的回调交给 engine；执行结束时以 null 注销 */
  registerKill?: (kill: (() => void) | null) => void;
};

type SpawnResult = { out: string; code: number; interrupted: boolean };

/**
 * 杀掉子进程**整棵树**。
 *
 * 只 kill 直接子进程是不够的：`sh -c "a | b"` 里 b 是孙进程，父进程一死它就
 * 孤儿化继续跑 —— 用户看到的「按了 Ctrl+C 没反应」多半就是这么来的。
 */
function killProcessTree(child: ChildProcess, force = false): void {
  if (!child.pid) return;

  if (process.platform === 'win32') {
    // **顺序是这里唯一要紧的事：必须让 taskkill 先跑。**
    //
    // Windows 上 child.kill() 不是发信号，而是直接 TerminateProcess 掉直接子进程。
    // 一旦先调它，父进程当场注销，随后才异步起来的 taskkill 连 /pid 都查不到，
    // 只会回一句「没有找到进程」—— 而它本来负责收拾的那些子孙（ping / node /
    // python...）就此脱离进程树，在后台继续跑到天荒地老。
    // /t 的树遍历要靠还活着的父进程，所以顺序反过来才对。
    try {
      const tk = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      // taskkill 起不来（PATH 里没有 / 被安全软件拦）时，至少把直接子进程收掉
      tk.on('error', () => {
        try {
          child.kill();
        } catch {
          /* noop */
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* noop */
      }
    }
    return;
  }

  // Unix：spawn 时开了 detached，pid 就是进程组组长，负号一次杀全组。
  // 第一刀发 SIGINT 给程序自己收尾的机会；force=true 时补 SIGKILL ——
  // 忽略 SIGINT 的进程（某些脚本、死锁进程）不吃这一刀就会变成后台孤儿。
  const sig = force ? 'SIGKILL' : 'SIGINT';
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* noop */
    }
  }
}

function spawnAsync(file: string, args: string[], opts: SpawnOpts): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let interrupted = false;
    let killTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    /** 当前活跃的子进程；Windows 上 .cmd/.bat 兜底会换成新 spawn 的那个 */
    let child: ChildProcess | null = null;

    const settle = (code: number) => {
      if (done) return;
      done = true;
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
      opts.registerKill?.(null);
      // 中断一律报 130：Windows 上 taskkill 给出的退出码五花八门，不能照搬
      resolve({ out, code: interrupted ? INTERRUPT_CODE : code, interrupted });
    };

    const push = (d: Buffer) => {
      const s = d.toString('utf8');
      out += s;
      opts.onData?.(s);
    };

    /**
     * 中断：先把整棵进程树按下去，再等 close 收尾。
     *
     * kill 是异步的 —— 进程还没死透、stdout 里可能还有在途数据。此刻立刻 resolve
     * 会让这些输出落到下一个提示符之后刷屏（跟 SSH 那个 settle 是同一类问题）。
     * 所以优先靠 close，只留一个兜底上限，免得杀不掉的顽固进程把 REPL 拖在原地。
     *
     * 允许被重复调用：用户连按 Ctrl+C 是常态，第一下没砍动时（进程退得慢、或者
     * 忽略了 SIGINT）后面几下要能升级成强制信号；到点还没死就再补一刀。
     */
    const interrupt = () => {
      if (done) return;
      if (interrupted) {
        if (child) killProcessTree(child, true);
        return;
      }
      interrupted = true;
      if (child) killProcessTree(child);
      killTimer = setTimeout(() => {
        if (child) killProcessTree(child, true);
        settle(INTERRUPT_CODE);
      }, 1500);
    };

    opts.registerKill?.(interrupt);
    if (opts.signal) {
      if (opts.signal.aborted) {
        interrupt();
      } else {
        onAbort = interrupt;
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const start = (useShell: boolean) => {
      const c = spawn(file, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: useShell,
        // Unix 下自成进程组，中断时才能按组杀；Windows 上 detached 会另开控制台，不开
        detached: !useShell && process.platform !== 'win32',
      });
      child = c;

      c.stdout?.on('data', push);
      c.stderr?.on('data', push);
      // 中断后 stdin 那一端可能已经断了，写失败不该升级成未捕获异常
      c.stdin?.on('error', () => {
        /* noop */
      });

      const onClose = (code: number | null) => settle(code ?? 0);

      c.on('error', (e: NodeJS.ErrnoException) => {
        if (done) return;
        // Windows 上 .cmd / .bat 需要解释器，这里做一次兜底
        if (!useShell && process.platform === 'win32' && (e.code === 'ENOENT' || e.code === 'EINVAL')) {
          // 旧进程只会发 error 不会再发 close，但保险起见先摘掉它的收尾
          c.removeListener('close', onClose);
          start(true);
          return;
        }
        out = `${file}: ${e.message}`;
        settle(127);
      });

      c.on('close', onClose);

      if (opts.stdin) c.stdin?.write(opts.stdin);
      c.stdin?.end();
    };

    if (opts.timeoutMs) {
      timeoutTimer = setTimeout(() => {
        if (done) return;
        if (child) killProcessTree(child);
        out += '\n(执行超时，已终止)';
        settle(-1);
      }, opts.timeoutMs);
    }

    start(false);
  });
}

export class ShellEngine {
  cwd = process.cwd();
  env: Record<string, string> = { ...(process.env as Record<string, string>) };
  history: string[] = [];
  aliases = new Map<string, string>();

  /** 正在跑的子进程的「杀掉它」回调，由 spawnAsync 注册 / 注销 */
  private activeKill: (() => void) | null = null;
  /** 本轮 exec 是否被用户中断过 */
  private interrupted = false;
  /**
   * 本轮执行的中断信号。内置命令（sleep 之类）是纯 JS 实现，没有子进程可以被
   * 外部杀掉，只能靠这个信号自己收手 —— 光置 interrupted 标志它看不到。
   */
  private abortCtrl: AbortController | null = null;

  constructor(startCwd?: string) {
    if (startCwd) this.cwd = startCwd;
  }

  /** 提示符：Linux 风格，不暴露 Windows 路径差异 */
  prompt(): string {
    const home = os.homedir();
    let shown = this.cwd;
    if (shown.startsWith(home)) shown = '~' + shown.slice(home.length);
    return `\x1b[36m${shown}\x1b[0m \x1b[35m$\x1b[0m `;
  }

  /** alias 展开（只展开命令行的首个词） */
  expandAlias(line: string): string {
    const trimmed = line.trim();
    const first = trimmed.split(/\s+/)[0];
    if (first && this.aliases.has(first)) {
      return this.aliases.get(first)! + trimmed.slice(first.length);
    }
    return trimmed;
  }

  /**
   * 用户按下 Ctrl+C。
   *
   * raw 模式下终端不会产生 SIGINT，Ctrl+C 只是一个 \x03 字符，所以中断必须由
   * 上层显式转达进来。正在跑的子进程会被连树杀掉；若当前没有子进程（例如内置
   * sleep），只置位标志，由 exec 的循环负责短路收尾。
   */
  interrupt(): void {
    this.interrupted = true;
    this.abortCtrl?.abort();
    // 故意**不**在这里清空 activeKill：用户连按 Ctrl+C 时，后面几下要能对同一个
    // 进程再补一刀（第一刀没砍动的情况真实存在）。真正的注销交给 spawnAsync
    // settle 时的 registerKill(null) —— 那次之后 activeKill 才是 null，
    // 不会留着一个已经结束的 PID 去误伤别人。
    try {
      this.activeKill?.();
    } catch {
      /* 进程可能刚好自己退出了 */
    }
  }

  private ctx(stdin: string, piped?: boolean, signal?: AbortSignal): CmdCtx {
    return {
      cwd: this.cwd,
      env: this.env,
      stdin,
      history: this.history,
      aliases: this.aliases,
      piped,
      signal,
    };
  }

  private async runSegment(
    seg: Segment,
    stdin: string,
    timeoutMs?: number,
    piped?: boolean,
    opts?: ExecOpts,
  ): Promise<{ out: string; code: number; clear?: boolean; exit?: boolean }> {
    const argv = expandGlobs(seg.argv, this.cwd);
    const name = argv[0];
    const args = argv.slice(1);

    if (isBuiltin(name)) {
      // 内置命令也得能中断：sleep 这类是纯 JS 的 setTimeout，没有子进程可杀，
      // 只能靠信号通知它自己收手。外部传进来的 signal 已在 exec 里桥接到 abortCtrl。
      const signal = this.abortCtrl?.signal ?? opts?.signal;
      const r = (await runBuiltin(name, args, this.ctx(stdin, piped, signal))) as CmdResult;
      if (r.newCwd) this.cwd = r.newCwd;
      return { out: r.out, code: r.code ?? 0, clear: r.clear, exit: r.exit };
    }

    const full = findOnPath(name, this.env);
    if (!full) {
      return { out: `${name}: 未找到命令（也不是内置命令）`, code: 127 };
    }
    return spawnAsync(full, args, {
      cwd: this.cwd,
      env: this.env,
      stdin,
      timeoutMs,
      onData: opts?.onData,
      signal: opts?.signal,
      registerKill: (kill) => {
        this.activeKill = kill;
      },
    });
  }

  async exec(line: string, timeoutMs?: number, opts?: ExecOpts): Promise<ExecOutcome> {
    // 每次执行都是新的一轮：清掉上一轮遗留的中断标志。否则一次 Ctrl+C 会让
    // 之后所有命令一进来就直接短路，看起来像 shell 坏了。
    this.interrupted = false;
    // 本轮的中断信号。调用方给的 signal 也桥接过来，保证「外部 abort」和
    // 「ShellEngine.interrupt()」两条来源都能一路传到最里层的内置命令。
    const ctrl = new AbortController();
    this.abortCtrl = ctrl;
    const outer = opts?.signal;
    const onOuterAbort = () => ctrl.abort();
    if (outer) {
      if (outer.aborted) ctrl.abort();
      else outer.addEventListener('abort', onOuterAbort, { once: true });
    }

    const stmts = splitStatements(line);
    // 逐条累积输出，不能只留最后一条的结果：`echo 1 && echo 2` 只回 "2" 的话，
    // AI 跑多步探测（echo "---disk---"; df -h; echo "---mem---"; free -m）就只剩
    // 最后一段，前面的上下文全丢 —— 模型据此判断必然跑偏。
    let out = '';
    let code = 0;
    try {
      for (const s of stmts) {
        // Ctrl+C 中断的是**整条命令行**：`a; b` 里的 b 也不该再跑
        if (this.interrupted) break;
        const r = await this.execSingle(s.text, timeoutMs, opts);
        // clear 是清屏语义，前面累的输出没有意义，直接短路
        if (r.clear) return { output: '', code: r.code, clear: true };
        if (r.output) {
          // 段与段之间补一个换行；上一段自己以换行收尾时就不再补，免得出现空行
          out += out && !out.endsWith('\n') ? '\n' + r.output : r.output;
        }
        code = r.code;
        if (r.exit) return { output: out, code, exit: true };
        if (this.interrupted) break;
        if (s.joiner === '&&' && r.code !== 0) break;
      }
    } finally {
      outer?.removeEventListener('abort', onOuterAbort);
    }
    return { output: out, code: this.interrupted ? INTERRUPT_CODE : code };
  }

  async execSingle(line: string, timeoutMs?: number, opts?: ExecOpts): Promise<ExecOutcome> {
    // alias 展开（只展开首个词）
    const expanded = this.expandAlias(line);

    const parsed = parseLine(expanded);
    const segments = parsed.segments;
    if (!segments.length) return { output: '', code: 0 };

    let stdin = '';
    if (parsed.stdinFrom) {
      try {
        stdin = fs.readFileSync(path.resolve(this.cwd, parsed.stdinFrom), 'utf8');
      } catch {
        return { output: `<: 无法读取 ${parsed.stdinFrom}`, code: 1 };
      }
    }
    let out = '';
    let code = 0;
    let clear = false;
    let exit = false;

    for (let i = 0; i < segments.length; i++) {
      // 管道中途被 Ctrl+C：后面的段没必要再跑
      if (this.interrupted) break;
      const seg = segments[i];
      const isLast = i === segments.length - 1;

      // 只有「最后一段、且不是写文件重定向」的输出才是给用户看的。
      // 管道中间段是喂给下一段的、`> file` 是要落盘的 —— 这两类要是也接上流式
      // 回调，同一份数据就会既进管道/文件、又额外打一遍到屏幕上。
      // signal 则相反：每一段都要带着，中断得能砍到管道里的任意一环。
      const toFile = Boolean(seg.redirect && (seg.redirect.type === '>' || seg.redirect.type === '>>'));
      const streamOpts: ExecOpts | undefined = !opts
        ? undefined
        : isLast && !toFile
          ? opts
          : { signal: opts.signal };
      const r = await this.runSegment(
        seg,
        stdin,
        timeoutMs,
        !isLast || Boolean(seg.redirect),
        streamOpts,
      );
      out = r.out;
      code = r.code;
      if (r.clear) clear = true;
      if (r.exit) exit = true;

      if (isLast && seg.redirect && (seg.redirect.type === '>' || seg.redirect.type === '>>')) {
        const target = path.resolve(this.cwd, seg.redirect.target);
        try {
          if (seg.redirect.type === '>>') fs.appendFileSync(target, out.endsWith('\n') ? out : out + '\n');
          else fs.writeFileSync(target, out.endsWith('\n') ? out : out + '\n');
          out = '';
        } catch (e) {
          return { output: `重定向失败: ${(e as Error).message}`, code: 1 };
        }
      }
      if (this.interrupted) break;
      if (!isLast) stdin = out;
    }

    return { output: out, code: this.interrupted ? INTERRUPT_CODE : code, clear, exit };
  }
}
