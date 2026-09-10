import { spawn } from 'node:child_process';
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

function spawnAsync(
  file: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdin?: string; timeoutMs?: number },
): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let out = '';
    let done = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (!done) {
            done = true;
            try {
              child.kill();
            } catch {
              /* noop */
            }
            resolve({ out: out + '\n(执行超时，已终止)', code: -1 });
          }
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });

    if (opts.stdin) child.stdin.write(opts.stdin);
    child.stdin.end();

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      // Windows 上 .cmd / .bat 需要解释器，这里做一次兜底
      if (process.platform === 'win32' && (e.code === 'ENOENT' || e.code === 'EINVAL')) {
        const shell = spawn(file, args, {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
          windowsHide: true,
        });
        let o2 = '';
        shell.stdout.on('data', (d: Buffer) => {
          o2 += d.toString('utf8');
        });
        shell.stderr.on('data', (d: Buffer) => {
          o2 += d.toString('utf8');
        });
        if (opts.stdin) shell.stdin.write(opts.stdin);
        shell.stdin.end();
        shell.on('error', () => resolve({ out: `${file}: ${e.message}`, code: 127 }));
        shell.on('close', (c: number | null) => resolve({ out: o2, code: c ?? 0 }));
        return;
      }
      resolve({ out: `${file}: ${e.message}`, code: 127 });
    });

    child.on('close', (c: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ out, code: c ?? 0 });
    });
  });
}

export class ShellEngine {
  cwd = process.cwd();
  env: Record<string, string> = { ...(process.env as Record<string, string>) };
  history: string[] = [];
  aliases = new Map<string, string>();

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

  private ctx(stdin: string): CmdCtx {
    return { cwd: this.cwd, env: this.env, stdin, history: this.history, aliases: this.aliases };
  }

  private async runSegment(
    seg: Segment,
    stdin: string,
    timeoutMs?: number,
  ): Promise<{ out: string; code: number; clear?: boolean; exit?: boolean }> {
    const argv = expandGlobs(seg.argv, this.cwd);
    const name = argv[0];
    const args = argv.slice(1);

    if (isBuiltin(name)) {
      const r = (await runBuiltin(name, args, this.ctx(stdin))) as CmdResult;
      if (r.newCwd) this.cwd = r.newCwd;
      return { out: r.out, code: r.code ?? 0, clear: r.clear, exit: r.exit };
    }

    const full = findOnPath(name, this.env);
    if (!full) {
      return { out: `${name}: 未找到命令（也不是内置命令）`, code: 127 };
    }
    return spawnAsync(full, args, { cwd: this.cwd, env: this.env, stdin, timeoutMs });
  }

  async exec(line: string, timeoutMs?: number): Promise<ExecOutcome> {
    const stmts = splitStatements(line);
    let last: ExecOutcome = { output: '', code: 0 };
    for (const s of stmts) {
      const r = await this.execSingle(s.text, timeoutMs);
      last = r;
      if (r.exit || r.clear) return r;
      if (s.joiner === '&&' && r.code !== 0) break;
    }
    return last;
  }

  async execSingle(line: string, timeoutMs?: number): Promise<ExecOutcome> {
    const trimmed = line.trim();

    // alias 展开（只展开首个词）
    let expanded = trimmed;
    const first = trimmed.split(/\s+/)[0];
    if (first && this.aliases.has(first)) {
      expanded = this.aliases.get(first) + trimmed.slice(first.length);
    }

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
      const seg = segments[i];
      const isLast = i === segments.length - 1;

      const r = await this.runSegment(seg, stdin, timeoutMs);
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
      if (!isLast) stdin = out;
    }

    return { output: out, code, clear, exit };
  }
}
