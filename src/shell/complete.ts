import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Completer } from './line.js';
import { builtinNames } from './builtin.js';
import { FALLBACK_COMMANDS, type UsageStats } from './usage.js';

/**
 * 补全候选的来源与排序。
 *
 * 与行编辑器分开：行编辑器只管「按下 Tab 之后怎么改输入」，
 * 这里只管「有哪些候选、谁排在前面」。两个关注点各自可测。
 */

/**
 * 本地会话：候选 = 内置命令 + PATH 里的可执行文件。
 * 排序交给使用统计 —— 最常用的排最前；空输入按 Tab 直接推荐高频命令。
 */
export function makeLocalCompleter(usage: UsageStats, getCwd: () => string): Completer {
  let pool: string[] | null = null;

  const allCommands = (): string[] => {
    if (pool) return pool;
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const found = new Set<string>();
    for (const d of dirs) {
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          // 只收可执行文件。PATH 目录下还躺着不少子目录，不过滤的话
          // 补全列表会被 `bin` / `lib` 这类目录名塞满。
          if (!entry.isFile() && !entry.isSymbolicLink()) continue;
          const name = entry.name;
          if (process.platform === 'win32') {
            const low = name.toLowerCase();
            if (low.endsWith('.exe') || low.endsWith('.cmd') || low.endsWith('.bat')) {
              found.add(name.slice(0, name.lastIndexOf('.')));
            }
          } else {
            found.add(name);
          }
        }
      } catch {
        // 某个 PATH 项不可读就跳过，补全不该因此整个失效
      }
    }
    // 内置命令优先于同名外部程序（引擎也是这个优先级），去重后缓存
    pool = [...new Set([...builtinNames(), ...found])];
    return pool;
  };

  return (line, cursor) => {
    const before = line.slice(0, cursor);
    const wordStart = Math.max(before.lastIndexOf(' ') + 1, 0);
    const word = before.slice(wordStart);

    if (wordStart === 0) {
      const all = allCommands();

      // 空输入按 Tab：不猜，直接摊开最常用的几条
      if (!word) {
        const known = new Set(all);
        const top = usage.suggest(24).filter((n) => known.has(n));
        // 还没攒下使用记录时给一份基础命令兜底，别让 Tab 毫无反应
        return top.length ? top : all.slice(0, 24);
      }

      return usage.rank(all.filter((c) => c.toLowerCase().startsWith(word.toLowerCase())));
    }

    // 检查是否是 cd / pushd / rmdir 这类只接受目录参数的命令
    const lastStmt = before.split(/[;&|]/).pop() || '';
    const firstWord = lastStmt.trimStart().split(/\s+/)[0]?.toLowerCase();
    const onlyDirs = firstWord === 'cd' || firstWord === 'pushd' || firstWord === 'rmdir';

    return completePath(word, getCwd(), { onlyDirs });
  };
}

export type RemotePathCompleter = (word: string, onlyDirs: boolean) => Promise<string[]> | string[];

/**
 * 远端 SSH 会话：远端文件系统够不着，PATH 也不是本机那份，
 * 候选来自使用记录（在远端跑过的命令同样记在本机）；没有记录时退回基础命令表。
 * 若提供了 remotePathCompleter，在参数位置可向远端查询路径补全。
 */
export function makeRemoteCompleter(usage: UsageStats, remotePathCompleter?: RemotePathCompleter): Completer {
  return (line, cursor) => {
    const before = line.slice(0, cursor);
    const wordStart = Math.max(before.lastIndexOf(' ') + 1, 0);
    const word = before.slice(wordStart);

    if (wordStart !== 0) {
      if (remotePathCompleter) {
        const lastStmt = before.split(/[;&|]/).pop() || '';
        const firstWord = lastStmt.trimStart().split(/\s+/)[0]?.toLowerCase();
        const onlyDirs = firstWord === 'cd' || firstWord === 'pushd' || firstWord === 'rmdir';
        return remotePathCompleter(word, onlyDirs);
      }
      return []; // 未配置远端查询通道时，参数位置不猜
    }

    const low = word.toLowerCase();
    if (!low) {
      const top = usage.suggest(16);
      return top.length ? top : [...FALLBACK_COMMANDS].sort().slice(0, 16);
    }

    const seen = new Set<string>();
    const hits: string[] = [];
    for (const c of [...usage.suggest(80), ...FALLBACK_COMMANDS]) {
      if (seen.has(c) || !c.toLowerCase().startsWith(low)) continue;
      seen.add(c);
      hits.push(c);
    }
    return usage.rank(hits);
  };
}

export type CompletePathOpts = {
  /** 仅补全目录（cd / pushd / rmdir 等命令专用） */
  onlyDirs?: boolean;
};

/** 按当前目录列出匹配的文件或目录名；当 onlyDirs=true 时仅列出目录 */
export function completePath(word: string, cwd: string, opts?: CompletePathOpts): string[] {
  // 不能用 path.dirname / basename 切：Node 会把末尾分隔符吃掉
  // （dirname('src/') === '.'、basename('src/') === 'src'），于是 `ls src/`
  // 被当成「在 cwd 里找以 src 开头的名字」，候选只剩 src 自己 ——
  // 用户按多少次 Tab 都进不去那个目录。按最后一个分隔符手工切才准。
  const lastSep = Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\'));
  const dir = lastSep >= 0 ? word.slice(0, lastSep + 1) : '.';
  const base = lastSep >= 0 ? word.slice(lastSep + 1) : word;
  const absDir = path.resolve(cwd, dir.replace(/^~/, os.homedir()));
  // 带分隔符时直接用原前缀（保序、保住用户敲的 ./ 或绝对路径），否则拼回相对名
  const dirPrefix = dir === '.' ? '' : dir;
  try {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    const isWin = process.platform === 'win32';
    const baseLow = base.toLowerCase();

    return entries
      .filter((e) => {
        if (opts?.onlyDirs) {
          if (!e.isDirectory() && !e.isSymbolicLink()) return false;
          if (e.isSymbolicLink()) {
            try {
              if (!fs.statSync(path.join(absDir, e.name)).isDirectory()) return false;
            } catch {
              return false;
            }
          }
        }
        // 大小写匹配：Windows 下大小写不敏感；在 Unix 下若输入全小写也做忽略大小写的前缀匹配
        if (isWin || base === baseLow) {
          return e.name.toLowerCase().startsWith(baseLow);
        }
        return e.name.startsWith(base);
      })
      .map((e) => (dirPrefix ? dirPrefix + e.name : e.name))
      .sort();
  } catch {
    return [];
  }
}
