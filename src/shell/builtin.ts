import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type CmdCtx = {
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  history: string[];
  aliases: Map<string, string>;
  piped?: boolean;
};

export type CmdResult = {
  out: string;
  code?: number;
  /** 返回表示要切换工作目录 */
  newCwd?: string;
  /** 返回表示要清屏 */
  clear?: boolean;
  /** 返回表示要退出 shell */
  exit?: boolean;
};

type Handler = (args: string[], ctx: CmdCtx) => CmdResult | Promise<CmdResult>;

function humanSize(n: number): string {
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${u[i]}`;
}

export function parseHumanSize(s: string): number {
  const m = s.trim().match(/^([0-9.]+)\s*([KkMmGgTtPp]?)(?:i?B)?$/);
  if (!m) return Number(s) || 0;
  const num = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };
  return num * (mult[unit] ?? 1);
}

function resolve(p: string, cwd: string): string {
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

function walk(dir: string, maxDepth: number, depth = 0, acc: string[] = []): string[] {
  if (depth > maxDepth) return acc;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    acc.push(full);
    if (e.isDirectory()) walk(full, maxDepth, depth + 1, acc);
  }
  return acc;
}

const commands: Record<string, Handler> = {
  help: () => ({
    out: [
      '内置命令（不依赖系统 shell，Windows / Linux 行为一致）：',
      '  pwd  cd  ls  cat  head  tail  wc  grep  find  du  df  stat  sort',
      '  mkdir  rmdir  touch  rm  cp  mv  echo  env  export  unset',
      '  which  whoami  date  uname  sleep  history  alias  clear  exit',
      '  ai <自然语言>   交给 AI（前缀可在配置里改）',
      '',
      '外部命令会直接调用可执行文件；支持管道 | 和重定向 > >> <。',
    ].join('\n'),
  }),

  pwd: (_a, ctx) => ({ out: ctx.cwd }),

  cd: (args, ctx) => {
    const target = args[0] ? resolve(args[0], ctx.cwd) : os.homedir();
    try {
      const st = fs.statSync(target);
      if (!st.isDirectory()) return { out: `cd: 不是目录: ${args[0]}`, code: 1 };
      return { out: '', newCwd: target };
    } catch {
      return { out: `cd: 没有那个目录: ${args[0]}`, code: 1 };
    }
  },

  ls: (args, ctx) => {
    const flags = args.filter((a) => a.startsWith('-'));
    const long = flags.some((f) => f.includes('l'));
    const all = flags.some((f) => f.includes('a'));
    const targets = args.filter((a) => !a.startsWith('-'));
    const items = targets.length ? targets.map((t) => resolve(t, ctx.cwd)) : [ctx.cwd];

    const lines: string[] = [];
    for (const item of items) {
      let st: fs.Stats;
      try {
        st = fs.statSync(item);
      } catch {
        lines.push(`ls: 无法访问: ${item}`);
        continue;
      }

      if (!st.isDirectory()) {
        if (long) {
          const mtime = st.mtime.toISOString().slice(5, 16);
          lines.push(
            `-${(st.mode & 0o777).toString(8).padStart(3, '0')} ${humanSize(st.size).padStart(6)} ${mtime} ${path.basename(item)}`,
          );
        } else {
          lines.push(path.basename(item));
        }
        continue;
      }

      if (items.length > 1) lines.push(`${item}:`);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(item, { withFileTypes: true });
      } catch {
        lines.push(`ls: 无法访问: ${item}`);
        continue;
      }
      const list = all ? entries : entries.filter((e) => !e.name.startsWith('.'));
      list.sort((a, b) => a.name.localeCompare(b.name));
      if (long) {
        for (const e of list) {
          let subSt: fs.Stats;
          try {
            subSt = fs.statSync(path.join(item, e.name));
          } catch {
            continue;
          }
          const type = e.isDirectory() ? 'd' : '-';
          const mtime = subSt.mtime.toISOString().slice(5, 16);
          lines.push(
            `${type}${(subSt.mode & 0o777).toString(8).padStart(3, '0')} ${humanSize(subSt.size).padStart(6)} ${mtime} ${e.name}${e.isDirectory() ? '/' : ''}`,
          );
        }
      } else {
        const sep = ctx.piped ? '\n' : '  ';
        lines.push(list.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join(sep));
      }
    }
    return { out: lines.join('\n') };
  },

  cat: (args, ctx) => {
    const files = args.filter((a) => !a.startsWith('-'));
    if (!files.length) return { out: ctx.stdin };
    const chunks: string[] = [];
    let code = 0;
    for (const f of files) {
      try {
        chunks.push(fs.readFileSync(resolve(f, ctx.cwd), 'utf8').replace(/\n$/, ''));
      } catch {
        chunks.push(`cat: ${f}: 无法读取`);
        code = 1;
      }
    }
    return { out: chunks.join('\n'), code };
  },

  echo: (args, ctx) => {
    if (!args.length) return { out: ctx.stdin ?? '' };
    return { out: args.join(' ') };
  },

  head: (args, ctx) => {
    const nArg = args.findIndex((a) => a === '-n');
    let n = 10;
    let files = args.filter((a) => !a.startsWith('-'));
    if (nArg >= 0 && args[nArg + 1]) {
      n = Number(args[nArg + 1]) || 10;
      files = args.filter((a, i) => !a.startsWith('-') && i !== nArg + 1);
    }
    const src = (
      files.length
        ? files
            .map((f) => {
              try {
                return fs.readFileSync(resolve(f, ctx.cwd), 'utf8').replace(/\n$/, '');
              } catch {
                return `head: ${f}: 无法读取`;
              }
            })
            .join('\n')
        : ctx.stdin
    ).replace(/\n$/, '');
    return { out: src.split('\n').slice(0, n).join('\n') };
  },

  tail: (args, ctx) => {
    const nArg = args.findIndex((a) => a === '-n');
    let n = 10;
    let files = args.filter((a) => !a.startsWith('-'));
    if (nArg >= 0 && args[nArg + 1]) {
      n = Number(args[nArg + 1]) || 10;
      files = args.filter((a, i) => !a.startsWith('-') && i !== nArg + 1);
    }
    const src = (
      files.length
        ? files
            .map((f) => {
              try {
                return fs.readFileSync(resolve(f, ctx.cwd), 'utf8').replace(/\n$/, '');
              } catch {
                return `tail: ${f}: 无法读取`;
              }
            })
            .join('\n')
        : ctx.stdin
    ).replace(/\n$/, '');
    const lines = src.split('\n');
    return { out: lines.slice(Math.max(0, lines.length - n)).join('\n') };
  },

  wc: (args, ctx) => {
    const files = args.filter((a) => !a.startsWith('-'));
    const src = files.length
      ? files.map((f) => {
          try {
            return fs.readFileSync(resolve(f, ctx.cwd), 'utf8');
          } catch {
            return '';
          }
        }).join('\n')
      : ctx.stdin;
    const l = src ? src.split('\n').length : 0;
    const w = src ? src.split(/\s+/).filter(Boolean).length : 0;
    return { out: `${String(l).padStart(6)} ${String(w).padStart(6)} ${String(Buffer.byteLength(src)).padStart(6)}` };
  },

  grep: (args, ctx) => {
    const flags = args.filter((a) => a.startsWith('-'));
    const rest = args.filter((a) => !a.startsWith('-'));
    const insensitive = flags.some((f) => f.includes('i'));
    const showNum = flags.some((f) => f.includes('n'));
    const invert = flags.some((f) => f.includes('v'));
    const countOnly = flags.some((f) => f.includes('c'));
    const pattern = rest.shift();
    if (!pattern) return { out: 'usage: grep [-incv] <pattern> [file...]', code: 2 };
    let re: RegExp;
    try {
      re = new RegExp(pattern, insensitive ? 'i' : '');
    } catch {
      return { out: `grep: 无效的正则: ${pattern}`, code: 2 };
    }
    const src = rest.length
      ? rest
          .map((f) => {
            try {
              return fs.readFileSync(resolve(f, ctx.cwd), 'utf8');
            } catch {
              return `grep: ${f}: 无法读取`;
            }
          })
          .join('\n')
      : ctx.stdin;

    const lines = src.split('\n');
    const matched = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => (invert ? !re.test(l) : re.test(l)));

    if (countOnly) {
      return { out: String(matched.length), code: matched.length > 0 ? 0 : 1 };
    }

    const out = matched
      .map(({ l, i }) => (showNum ? `${i + 1}:${l}` : l))
      .join('\n');
    return { out, code: out ? 0 : 1 };
  },

  find: (args, ctx) => {
    let start = '.';
    let namePat: string | null = null;
    let typeFilter: 'f' | 'd' | null = null;
    let maxDepth = Infinity;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-name') namePat = args[++i];
      else if (a === '-type') typeFilter = args[++i] as 'f' | 'd';
      else if (a === '-maxdepth') maxDepth = Number(args[++i]) || 1;
      else if (!a.startsWith('-')) start = a;
    }
    const root = resolve(start, ctx.cwd);
    let re: RegExp | null = null;
    if (namePat) {
      re = new RegExp(
        '^' + namePat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      );
    }
    const depth = maxDepth === Infinity ? 32 : maxDepth;
    const files = walk(root, depth);
    const out = files
      .filter((f) => {
        if (re && !re.test(path.basename(f))) return false;
        if (typeFilter) {
          try {
            const st = fs.statSync(f);
            if (typeFilter === 'f' && !st.isFile()) return false;
            if (typeFilter === 'd' && !st.isDirectory()) return false;
          } catch {
            return false;
          }
        }
        return true;
      })
      .map((f) => (start === '.' ? path.relative(ctx.cwd, f) || '.' : f))
      .join('\n');
    return { out };
  },

  du: (args, ctx) => {
    const summarize = args.some((a) => a.includes('s'));
    const human = args.some((a) => a.includes('h'));
    const depthArg = args.findIndex((a) => a.startsWith('--max-depth'));
    const maxDepth = depthArg >= 0 ? Number(args[depthArg].split('=')[1] ?? args[depthArg + 1]) || 1 : 1;
    const target = args.find((a) => !a.startsWith('-')) ?? '.';
    const root = resolve(target, ctx.cwd);

    const sizeOf = (p: string): number => {
      try {
        const st = fs.statSync(p);
        if (st.isFile()) return st.size;
      } catch {
        return 0;
      }
      let total = 0;
      try {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          total += sizeOf(path.join(p, e.name));
        }
      } catch {
        /* 权限不足 */
      }
      return total;
    };

    if (summarize) {
      const s = sizeOf(root);
      return { out: `${human ? humanSize(s) : Math.ceil(s / 1024)}\t${target}` };
    }

    const entries: { p: string; s: number }[] = [];
    const collect = (dir: string, curDepth: number) => {
      if (curDepth > maxDepth) return;
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            entries.push({ p: full, s: sizeOf(full) });
            collect(full, curDepth + 1);
          }
        }
      } catch {
        /* 忽略 */
      }
    };
    collect(root, 1);

    entries.sort((a, b) => b.s - a.s);
    const out = entries
      .map((e) => `${human ? humanSize(e.s) : Math.ceil(e.s / 1024)}\t${path.relative(ctx.cwd, e.p) || '.'}`)
      .join('\n');
    return { out };
  },

  df: () => {
    try {
      const st = (fs as unknown as { statfsSync: (p: string) => { bsize: number; bfree: number; blocks: number } })
        .statfsSync(process.platform === 'win32' ? 'C:\\' : '/');
      const total = st.blocks * st.bsize;
      const free = st.bfree * st.bsize;
      const used = total - free;
      const pct = total ? Math.round((used / total) * 100) : 0;
      return {
        out:
          `Filesystem  Size  Used  Avail  Use%\n` +
          `${process.platform === 'win32' ? 'C:' : '/'}  ${humanSize(total)}  ${humanSize(used)}  ${humanSize(free)}  ${pct}%`,
      };
    } catch {
      return { out: 'df: 当前环境不支持', code: 1 };
    }
  },

  stat: (args, ctx) => {
    if (!args.length) return { out: 'usage: stat <path>', code: 2 };
    try {
      const p = resolve(args[0], ctx.cwd);
      const st = fs.statSync(p);
      return {
        out: [
          `  File: ${p}`,
          `  Size: ${st.size}\tBlocks: ${Math.ceil(st.size / 512)}\t${st.isDirectory() ? 'directory' : 'regular file'}`,
          `Access: ${(st.mode & 0o777).toString(8)}`,
          `Modify: ${st.mtime.toISOString()}`,
          `Change: ${st.ctime.toISOString()}`,
        ].join('\n'),
      };
    } catch {
      return { out: `stat: 无法访问: ${args[0]}`, code: 1 };
    }
  },

  sort: (args, ctx) => {
    const flags = args.filter((a) => a.startsWith('-'));
    const reverse = flags.some((f) => f.includes('r'));
    const numeric = flags.some((f) => f.includes('n'));
    const human = flags.some((f) => f.includes('h'));
    const unique = flags.some((f) => f.includes('u'));
    let colIdx = 0;
    const kIdx = args.findIndex((a) => a === '-k');
    if (kIdx >= 0 && args[kIdx + 1]) {
      colIdx = Math.max(0, parseInt(args[kIdx + 1], 10) - 1);
    }

    const files = args.filter((a, i) => !a.startsWith('-') && i !== kIdx + 1);
    const src = files.length
      ? files
          .map((f) => {
            try {
              return fs.readFileSync(resolve(f, ctx.cwd), 'utf8');
            } catch {
              return '';
            }
          })
          .join('\n')
      : ctx.stdin;

    let lines = src.split(/\r?\n/).filter((l, i, arr) => (i === arr.length - 1 && !l ? false : true));
    if (unique) lines = [...new Set(lines)];

    const parseVal = (line: string): number | string => {
      const parts = line.trim().split(/\s+/);
      const target = parts[colIdx] ?? line;
      if (human) return parseHumanSize(target);
      if (numeric) return parseFloat(target) || 0;
      return target;
    };

    lines.sort((a, b) => {
      const va = parseVal(a);
      const vb = parseVal(b);
      let cmp = 0;
      if (typeof va === 'number' && typeof vb === 'number') {
        cmp = va - vb;
      } else {
        cmp = String(va).localeCompare(String(vb));
      }
      return reverse ? -cmp : cmp;
    });

    return { out: lines.join('\n') };
  },

  mkdir: (args, ctx) => {
    const recursive = args.includes('-p');
    const dirs = args.filter((a) => !a.startsWith('-'));
    if (!dirs.length) return { out: 'usage: mkdir [-p] <dir>', code: 2 };
    for (const d of dirs) {
      try {
        fs.mkdirSync(resolve(d, ctx.cwd), { recursive: recursive || undefined });
      } catch (e) {
        return { out: `mkdir: ${d}: ${(e as Error).message}`, code: 1 };
      }
    }
    return { out: '' };
  },

  rmdir: (args, ctx) => {
    for (const d of args) {
      try {
        fs.rmdirSync(resolve(d, ctx.cwd));
      } catch (e) {
        return { out: `rmdir: ${d}: ${(e as Error).message}`, code: 1 };
      }
    }
    return { out: '' };
  },

  touch: (args, ctx) => {
    for (const f of args) {
      const p = resolve(f, ctx.cwd);
      try {
        const now = new Date();
        fs.closeSync(fs.openSync(p, 'a'));
        fs.utimesSync(p, now, now);
      } catch {
        return { out: `touch: ${f}: 无法创建`, code: 1 };
      }
    }
    return { out: '' };
  },

  rm: (args, ctx) => {
    const force = args.some((a) => a.startsWith('-') && a.includes('f'));
    const recursive = args.some((a) => a.startsWith('-') && a.includes('r'));
    const files = args.filter((a) => !a.startsWith('-'));
    if (!files.length) return { out: 'usage: rm [-rf] <path>', code: force ? 0 : 2 };
    for (const f of files) {
      try {
        fs.rmSync(resolve(f, ctx.cwd), { recursive: Boolean(recursive), force: Boolean(force) });
      } catch (e) {
        if (!force) return { out: `rm: ${f}: ${(e as Error).message}`, code: 1 };
      }
    }
    return { out: '' };
  },

  cp: (args, ctx) => {
    const recursive = args.some((a) => a.startsWith('-') && (a.includes('r') || a.includes('R')));
    const files = args.filter((a) => !a.startsWith('-'));
    if (files.length < 2) return { out: 'usage: cp [-r] <src> <dst>', code: 2 };
    const rawDst = resolve(files[files.length - 1], ctx.cwd);
    const isDstDir = fs.existsSync(rawDst) && fs.statSync(rawDst).isDirectory();

    for (const src of files.slice(0, -1)) {
      const srcPath = resolve(src, ctx.cwd);
      const dstPath = isDstDir ? path.join(rawDst, path.basename(srcPath)) : rawDst;
      try {
        const srcSt = fs.statSync(srcPath);
        if (srcSt.isDirectory()) {
          if (!recursive) return { out: `cp: -r not specified; omitting directory '${src}'`, code: 1 };
          fs.cpSync(srcPath, dstPath, { recursive: true });
        } else {
          fs.copyFileSync(srcPath, dstPath);
        }
      } catch (e) {
        return { out: `cp: ${(e as Error).message}`, code: 1 };
      }
    }
    return { out: '' };
  },

  mv: (args, ctx) => {
    const files = args.filter((a) => !a.startsWith('-'));
    if (files.length < 2) return { out: 'usage: mv <src> <dst>', code: 2 };
    const rawDst = resolve(files[files.length - 1], ctx.cwd);
    const isDstDir = fs.existsSync(rawDst) && fs.statSync(rawDst).isDirectory();

    for (const src of files.slice(0, -1)) {
      const srcPath = resolve(src, ctx.cwd);
      const dstPath = isDstDir ? path.join(rawDst, path.basename(srcPath)) : rawDst;
      try {
        fs.renameSync(srcPath, dstPath);
      } catch (e) {
        return { out: `mv: ${(e as Error).message}`, code: 1 };
      }
    }
    return { out: '' };
  },

  env: (_a, ctx) => ({
    out: Object.entries(ctx.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  }),

  export: (args, ctx) => {
    if (!args.length) return commands.env(args, ctx);
    for (const a of args) {
      const idx = a.indexOf('=');
      if (idx > 0) ctx.env[a.slice(0, idx)] = a.slice(idx + 1).replace(/^["']|["']$/g, '');
    }
    return { out: '' };
  },

  unset: (args, ctx) => {
    for (const a of args) delete ctx.env[a];
    return { out: '' };
  },

  which: (args, ctx) => {
    const out: string[] = [];
    let code = 0;
    for (const name of args) {
      if (commands[name]) {
        out.push(`${name}: 内置命令`);
        continue;
      }
      const found = findOnPath(name, ctx.env);
      if (found) out.push(found);
      else {
        out.push(`which: 未找到 ${name}`);
        code = 1;
      }
    }
    return { out: out.join('\n'), code };
  },

  whoami: (_a, ctx) => ({ out: ctx.env.USER || ctx.env.USERNAME || os.userInfo().username }),

  date: () => ({ out: new Date().toString() }),

  uname: (args) => {
    if (args.includes('-a')) {
      return { out: `${os.type()} ${os.hostname()} ${os.release()} ${os.arch()}` };
    }
    return { out: os.type() };
  },

  sleep: async (args) => {
    const sec = Number(args[0]) || 1;
    await new Promise((r) => setTimeout(r, sec * 1000));
    return { out: '' };
  },

  history: (_a, ctx) => ({
    out: ctx.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join('\n'),
  }),

  alias: (args, ctx) => {
    if (!args.length) {
      return { out: [...ctx.aliases].map(([k, v]) => `alias ${k}='${v}'`).join('\n') };
    }
    for (const a of args) {
      const idx = a.indexOf('=');
      if (idx > 0) ctx.aliases.set(a.slice(0, idx), a.slice(idx + 1).replace(/^['"]|['"]$/g, ''));
      else if (ctx.aliases.has(a)) return { out: `alias ${a}='${ctx.aliases.get(a)}'` };
    }
    return { out: '' };
  },

  unalias: (args, ctx) => {
    for (const a of args) ctx.aliases.delete(a);
    return { out: '' };
  },

  clear: () => ({ out: '', clear: true }),

  exit: () => ({ out: '', exit: true }),
};

export function findOnPath(name: string, env: Record<string, string>): string | null {
  const p = env.PATH || env.Path || '';
  const dirs = p.split(path.delimiter).filter(Boolean);
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  if (name.includes('/') || name.includes('\\')) {
    return fs.existsSync(name) ? name : null;
  }
  const hasExt = isWin && exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  for (const dir of dirs) {
    if (hasExt) {
      const direct = path.join(dir, name);
      try {
        if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
      } catch {
        /* ignore */
      }
      continue;
    }
    for (const ext of exts) {
      const full = path.join(dir, name + (isWin ? ext.toLowerCase() : ext));
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        /* ignore */
      }
    }
    if (!isWin) {
      const direct = path.join(dir, name);
      try {
        if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function isBuiltin(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(commands, name);
}

export function runBuiltin(name: string, args: string[], ctx: CmdCtx): CmdResult | Promise<CmdResult> {
  return commands[name](args, ctx);
}

export function builtinNames(): string[] {
  return Object.keys(commands).sort();
}
