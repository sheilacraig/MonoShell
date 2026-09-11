import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 命令使用统计：记录用户手敲过哪些命令、各敲了多少次，
 * 供 Tab 补全「按常用度推荐」使用。
 *
 * 只统计**命令名本身**（行首那个词），不记参数 —— 参数千变万化，
 * 记下来既没用又会让文件膨胀；而「常用命令」这件事恰恰是由命令名承载的。
 *
 * 口径上只认**用户手敲**的命令：AI 代跑的命令反映的是模型的选择，
 * 不是用户的习惯，记进去会把榜单带偏。
 */

const MAX_ENTRIES = 500;
/** 文件写入的合并窗口：连着敲十条命令只落盘一次 */
const SAVE_DEBOUNCE_MS = 1200;

/**
 * 不值得参与补全的命令名。
 * 这些要么短到没有补全价值（`cd` / `ls` 的兄弟），要么是退出类指令，
 * 而且它们出现频率极高 —— 不排掉的话，按常用度排序出来的前几名
 * 全是它们，推荐等于废掉。
 */
const IGNORED = new Set(['cd', 'exit', 'quit', 'clear', 'cls', 'history', 'ai']);

export type UsageFile = {
  /** 命令名 → 累计使用次数 */
  commands: Record<string, number>;
  /** 命令名 → 最后一次使用时间（毫秒） */
  lastUsed: Record<string, number>;
};

export function usagePath(): string {
  return path.join(os.homedir(), '.ai-shell', 'usage.json');
}

/**
 * 从一整行输入里取出要计数的命令名。
 *
 * - 跳过开头的环境变量赋值（`FOO=bar cmd` 记 cmd）
 * - 去掉路径前缀与 Windows 可执行后缀（`/usr/bin/ls` → `ls`）
 * - 含引号 / 重定向 / 管道符等非命令名形态的，直接放弃计数
 */
export function commandNameOf(line: string): string | null {
  const t = line.trim();
  if (!t) return null;

  // 剥掉前置的 `NAME=value`，注意值里可能带引号
  let s = t;
  for (;;) {
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  if (!s) return null;

  const m = /^(\S+)/.exec(s);
  if (!m) return null;

  let name = m[1].replace(/^.*[\\/]/, '');
  if (process.platform === 'win32') name = name.replace(/\.(exe|cmd|bat)$/i, '');

  // 命令名只可能是这些字符；带 `$` `"` `|` 之类说明这不是一条普通命令
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) return null;
  return name;
}

export class UsageStats {
  private commands: Record<string, number> = {};
  private lastUsed: Record<string, number> = {};
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private file: string = usagePath()) {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<UsageFile>;
      for (const [k, v] of Object.entries(raw?.commands ?? {})) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) this.commands[k] = v;
      }
      for (const [k, v] of Object.entries(raw?.lastUsed ?? {})) {
        if (typeof v === 'number' && Number.isFinite(v)) this.lastUsed[k] = v;
      }
    } catch {
      // 首次运行没有文件 / 文件损坏 —— 都按空统计处理，不影响使用
    }
  }

  /** 记一次使用。传整行，内部自己取命令名 */
  record(line: string): void {
    const name = commandNameOf(line);
    if (!name || IGNORED.has(name)) return;
    this.commands[name] = (this.commands[name] ?? 0) + 1;
    this.lastUsed[name] = Date.now();
    this.dirty = true;
    this.trim();
    this.scheduleSave();
  }

  /** 某个命令名当前的常用度（累计次数） */
  score(name: string): number {
    return this.commands[name] ?? 0;
  }

  /**
   * 按常用度给候选排序：次数多的在前；次数相同看谁最近用过；
   * 再相同就按字典序，保证同一份数据每次排序结果一致。
   *
   * 用的是稳定排序，所以「按常用度排」这件事不会打乱同分候选的相对位置。
   */
  rank(names: string[]): string[] {
    return [...names].sort((a, b) => {
      const d = this.score(b) - this.score(a);
      if (d !== 0) return d;
      const t = (this.lastUsed[b] ?? 0) - (this.lastUsed[a] ?? 0);
      if (t !== 0) return t;
      return a.localeCompare(b);
    });
  }

  /** 最常用的前 n 个命令名，直接用来做「空输入按 Tab」的推荐 */
  suggest(n: number): string[] {
    return this.rank(Object.keys(this.commands)).slice(0, n);
  }

  private trim(): void {
    const keys = Object.keys(this.commands);
    if (keys.length <= MAX_ENTRIES) return;
    const keep = new Set(this.rank(keys).slice(0, MAX_ENTRIES));
    for (const k of keys) {
      if (!keep.has(k)) {
        delete this.commands[k];
        delete this.lastUsed[k];
      }
    }
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
    // 别让一个待写的定时器拖住进程退出
    this.timer.unref?.();
  }

  save(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload: UsageFile = { commands: this.commands, lastUsed: this.lastUsed };
      fs.writeFileSync(this.file, JSON.stringify(payload, null, 2), 'utf8');
      this.dirty = false;
    } catch {
      // 写不进去（权限 / 磁盘）不影响本次会话使用，静默跳过
    }
  }

  /** 退出前把还在合并窗口里的改动同步落盘 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.save();
  }
}

/**
 * 远端 SSH 会话够不着本机的 PATH，没法扫描可执行文件。
 * 这里给一份基础的常用命令表做兜底，只在「还没有使用记录」时补位，
 * 一旦用户真的敲过命令，就完全以记录为准。
 */
export const FALLBACK_COMMANDS = [
  'ls', 'll', 'pwd', 'cat', 'tail', 'head', 'less', 'grep', 'find', 'awk',
  'sed', 'sort', 'uniq', 'wc', 'du', 'df', 'free', 'top', 'ps', 'kill',
  'systemctl', 'journalctl', 'service', 'docker', 'kubectl', 'git', 'tar',
  'zip', 'unzip', 'curl', 'wget', 'ping', 'ss', 'netstat', 'chmod', 'chown',
  'mkdir', 'rm', 'cp', 'mv', 'vim', 'nano', 'sudo', 'su', 'whoami', 'uname',
];

let singleton: UsageStats | null = null;

/** 进程内共用一个实例：文件路径固定，没必要按会话重读 */
export function getUsage(): UsageStats {
  if (!singleton) singleton = new UsageStats();
  return singleton;
}
