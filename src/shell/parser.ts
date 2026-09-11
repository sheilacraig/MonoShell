import fs from 'node:fs';
import path from 'node:path';

export type Redirect = { type: '>' | '>>' | '<'; target: string };

export type Segment = {
  argv: string[];
  /** 该段的输出重定向（管道场景下只在最后一段生效） */
  redirect?: Redirect;
};

export type ParsedLine = {
  segments: Segment[];
  /** 整行是否以后台 & 结尾 */
  background: boolean;
  /** 由 < 指定的输入文件 */
  stdinFrom?: string;
};

/**
 * 轻量 POSIX 风格解析：支持单双引号、反斜杠转义、管道、> >> < 重定向、末尾 &。
 * 不追求完整 shell 语法（不做子 shell、不做 glob 展开以外的展开），够用即可。
 */
const SHELL_META = new Set([' ', '\t', '"', "'", '|', '&', ';', '>', '<', '$', '\\']);

export function parseLine(line: string): ParsedLine {
  const segments: Segment[] = [];
  let cur: string[] = [];
  let tok = '';
  let quote: "'" | '"' | null = null;
  let hasToken = false;
  let background = false;
  let pendingStdin: string | undefined;

  const pushToken = () => {
    if (hasToken) {
      cur.push(tok);
      tok = '';
      hasToken = false;
    }
  };
  const pushSegment = () => {
    pushToken();
    if (cur.length) segments.push({ argv: cur });
    cur = [];
  };

  let i = 0;
  while (i < line.length) {
    const ch = line[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      if (ch === '\\' && quote === '"' && i + 1 < line.length) {
        const next = line[i + 1];
        tok += next === '"' || next === '\\' ? next : '\\' + next;
        i += 2;
        continue;
      }
      tok += ch;
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      // Windows 下反斜杠常作为路径分隔符，只有转义特殊字符时才吞掉反斜杠
      if (process.platform === 'win32' && !SHELL_META.has(line[i + 1])) {
        tok += ch;
        hasToken = true;
        i++;
        continue;
      }
      tok += line[i + 1];
      hasToken = true;
      i += 2;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      pushToken();
      i++;
      continue;
    }
    if (ch === '|') {
      pushSegment();
      i++;
      continue;
    }
    if (ch === '>' || ch === '<') {
      // 先把当前段固化下来，否则重定向无处可挂
      pushSegment();
      let type: Redirect['type'];
      if (ch === '<') {
        type = '<';
        i++;
      } else if (line[i + 1] === '>') {
        type = '>>';
        i += 2;
      } else {
        type = '>';
        i++;
      }
      while (line[i] === ' ') i++;
      let target = '';
      while (i < line.length && line[i] !== ' ' && line[i] !== '|' && line[i] !== '>' && line[i] !== '<') {
        if (line[i] === '\\' && i + 1 < line.length) {
          if (process.platform === 'win32' && !SHELL_META.has(line[i + 1])) {
            target += line[i];
            i++;
            continue;
          }
          target += line[i + 1];
          i += 2;
          continue;
        }
        target += line[i];
        i++;
      }
      if (type === '<') {
        // 输入重定向：读文件内容作为下一段的 stdin
        pendingStdin = target;
      } else {
        const seg = segments[segments.length - 1];
        if (seg) seg.redirect = { type, target };
      }
      continue;
    }
    if (ch === '&' && i === line.length - 1) {
      background = true;
      i++;
      continue;
    }
    if (ch === '#') break;

    tok += ch;
    hasToken = true;
    i++;
  }

  pushSegment();
  return { segments, background, stdinFrom: pendingStdin };
}

export type Statement = { text: string; joiner: '&&' | ';' | null };

/**
 * 按 && 和 ; 拆分语句（引号内的不算）。
 * 拆开后交给引擎顺序执行，&& 遇到非 0 退出码就停。
 */
export function splitStatements(line: string): Statement[] {
  const out: Statement[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  let i = 0;

  const flush = (joiner: '&&' | ';' | null) => {
    const text = cur.trim();
    if (text) out.push({ text, joiner });
    cur = '';
  };

  while (i < line.length) {
    const ch = line[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      cur += ch + line[i + 1];
      i += 2;
      continue;
    }
    if (ch === '&' && line[i + 1] === '&') {
      flush('&&');
      i += 2;
      continue;
    }
    if (ch === ';') {
      flush(';');
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  flush(null);
  return out;
}

/** 把 a* 之类的通配展开为文件列表（只处理最后一段路径） */
export function expandGlobs(argv: string[], cwd: string): string[] {
  if (!argv.some((a) => /[*?]/.test(a))) return argv;
  const out: string[] = [];
  for (const a of argv) {
    if (!/[*?]/.test(a)) {
      out.push(a);
      continue;
    }
    const abs = path.isAbsolute(a) ? a : path.join(cwd, a);
    const dir = path.dirname(abs);
    const pat = path.basename(abs);
    try {
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      const files = fs.readdirSync(dir).filter((f) => re.test(f));
      if (files.length) out.push(...files.map((f) => path.join(dir, f)));
      else out.push(a);
    } catch {
      out.push(a);
    }
  }
  return out;
}
