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

    return completePath(word, getCwd());
  };
}

/**
 * 远端 SSH 会话：远端文件系统够不着，PATH 也不是本机那份，
 * 所以候选只来自使用记录（在远端跑过的命令同样记在本机），
 * 没有记录时退回一份基础命令表。
 */
export function makeRemoteCompleter(usage: UsageStats): Completer {
  return (line, cursor) => {
    const before = line.slice(0, cursor);
    const wordStart = Math.max(before.lastIndexOf(' ') + 1, 0);
    if (wordStart !== 0) return []; // 参数补全依赖远端状态，不猜

    const word = before.slice(wordStart).toLowerCase();
    if (!word) {
      const top = usage.suggest(16);
      return top.length ? top : [...FALLBACK_COMMANDS].sort().slice(0, 16);
    }

    const seen = new Set<string>();
    const hits: string[] = [];
    for (const c of [...usage.suggest(80), ...FALLBACK_COMMANDS]) {
      if (seen.has(c) || !c.toLowerCase().startsWith(word)) continue;
      seen.add(c);
      hits.push(c);
    }
    return usage.rank(hits);
  };
}

/** 按当前目录列出匹配的文件名；目录会带 '/'，方便接着补下一层 */
function completePath(word: string, cwd: string): string[] {
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
    return fs
      .readdirSync(absDir)
      .filter((f) => f.startsWith(base))
      .map((f) => (dirPrefix ? dirPrefix + f : f))
      .sort();
  } catch {
    return [];
  }
}
