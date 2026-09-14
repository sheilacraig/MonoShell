import type { AppConfig } from '../config.js';

export type RiskCheck = {
  risky: boolean;
  /** 为什么被判危险 / 为什么被放行 */
  reason: string;
  matched?: string;
};

const regexCache = new Map<string, RegExp | null>();

function getCompiledRegex(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) {
    return regexCache.get(pattern)!;
  }
  try {
    const re = new RegExp(pattern, 'i');
    regexCache.set(pattern, re);
    return re;
  } catch (e) {
    process.stderr.write(`[安全警告] 无效的正则表达式 "${pattern}": ${(e as Error).message}\n`);
    regexCache.set(pattern, null);
    return null;
  }
}

function compile(patterns: string[]): RegExp[] {
  const res: RegExp[] = [];
  for (const p of patterns) {
    const re = getCompiledRegex(p);
    if (re) res.push(re);
  }
  return res;
}

/** 剥离单引号和双引号内的内容，避免把字符串字面量当命令或重定向判定 */
export function stripQuotes(s: string): string {
  return s
    .replace(/"(?:[^"\\]|\\.)*"/g, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, '');
}

/**
 * 检查级别：
 * - full：AI 生成的命令走这一档。命中高危黑名单、或存在写文件重定向都要求确认。
 * - dangerous：用户手敲的命令走这一档。只看高危黑名单——手敲 `echo x > f` 是日常操作，
 *   不该每次都拦；但手敲 `rm -rf` 这种真高危要拦一下。
 */
export type RiskLevel = 'full' | 'dangerous';

/**
 * 安全检查：
 * 1. 命中高危黑名单即拦截并要求确认
 * 2. （full 档）存在写文件重定向（> 或 >>）即拦截
 * 3. 其余情况放行，交由正常执行
 */
export function checkRisk(command: string, cfg: AppConfig, level: RiskLevel = 'full'): RiskCheck {
  const c = command.trim();
  if (!c) return { risky: false, reason: 'empty' };

  // 1) 高危黑名单优先拦截（包含 dangerous 与 extraDangerous）
  const dangerousPatterns = [
    ...(cfg.safety.dangerous || []),
    ...(cfg.safety.extraDangerous || []),
  ];
  for (const re of compile(dangerousPatterns)) {
    if (re.test(c)) {
      return { risky: true, reason: '命中高危规则', matched: re.source };
    }
  }

  if (level === 'dangerous') {
    return { risky: false, reason: '仅高危黑名单档，未命中' };
  }

  // 2) 写文件重定向拦截（排除引号内内容、排除文件描述符复制如 2>&1、排除 > /dev/null）
  const unquoted = stripQuotes(c);
  const noFdDup = unquoted.replace(/\d?>&\d+/g, ' ').replace(/\d?>&-\b/g, ' ');
  if (/(?:^|\s|\d)>{1,2}\s*(?!\/dev\/null\b)\S+/.test(noFdDup)) {
    return { risky: true, reason: '会写入文件' };
  }

  // 3) 只读白名单放行（包含 allowlist 与 extraAllowlist）
  const allowPatterns = [
    ...(cfg.safety.allowlist || []),
    ...(cfg.safety.extraAllowlist || []),
  ];
  for (const re of compile(allowPatterns)) {
    if (re.test(c)) return { risky: false, reason: '命中只读白名单', matched: re.source };
  }

  return { risky: false, reason: '未命中规则' };
}

/** 把命令截断到适合终端单行展示的长度 */
export function truncate(s: string, n = 120): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n - 1) + '…';
}

export type InteractiveNeed = {
  /** 这条命令很可能要用户在终端里敲密码 / 口令 */
  needs: boolean;
  /** 归类：sudo / su / passwd / key-passphrase / db-password / read-secret */
  kind?: string;
  /** 给用户看的说明（为什么需要密码） */
  hint?: string;
  /** 免密的替代思路 */
  fix?: string;
};

/**
 * 判断一条命令是否会卡在「等用户输入密码」上。
 *
 * 这类命令**不能**由 AI 代跑：捕获通道拿不到 TTY，sudo 会一直等密码，
 * 最后只能靠超时收场，还会把迭代轮数白白烧光（实测就是这样翻车的）。
 * 所以要在这里识别出来，交给用户手动执行。
 *
 * 注意：这不是风险判定，而是能力边界判定 —— 与"危险命令"是两码事。
 */
export function detectInteractiveAuth(command: string): InteractiveNeed {
  const c = command.trim();
  if (!c) return { needs: false };

  // 剥离引号，避免 echo "sudo is..."、find . -name "sudo" 中的字面量被误判
  const unquoted = stripQuotes(c);

  // sudo 判定：必须在命令起始位置（行首，或 ; / && / || / | / ( / do / then 之后）
  const sudoCmdRe = /(?:^|[;&|(]|\b(?:do|then))\s*sudo\b/;
  if (sudoCmdRe.test(unquoted)) {
    // sudo -n（非交互）不算
    const isNonInteractive = /\bsudo\b\s+(-\S+\s+)*-n\b/.test(unquoted);
    // 前置有管道把密码喂给 sudo -S（如 echo pw | sudo -S cmd）的不算
    const hasPipedStdin = /(?:^|[\r\n]|;)\s*[^;&|]+\|\s*sudo\b.*-S\b/.test(unquoted);

    if (!isNonInteractive && !hasPipedStdin) {
      return {
        needs: true,
        kind: 'sudo',
        hint: 'sudo 需要你的登录密码，AI 不能代你输入',
        fix: '想让它以后能自动跑：给该用户配 NOPASSWD（sudo visudo 加一行 `用户名 ALL=(ALL) NOPASSWD:ALL`）。',
      };
    }
  }

  // su 判定：必须在命令起始位置
  if (/(?:^|[;&|(]|\b(?:do|then))\s*su(?:\s+.*)?$/.test(unquoted)) {
    return { needs: true, kind: 'su', hint: 'su 切换用户需要输入密码', fix: '建议手敲执行，或直接用 sudo 免密切换。' };
  }

  // passwd 判定：必须在命令起始位置
  if (/(?:^|[;&|(]|\b(?:do|then))\s*passwd(?:\s+.*)?$/.test(unquoted)) {
    return { needs: true, kind: 'passwd', hint: 'passwd 必须交互式输入新密码', fix: '这条只能由你手动执行。' };
  }

  if (/(?:^|[;&|(]|\b(?:do|then))\s*(ssh-add|ssh-keygen)\b/.test(unquoted)) {
    return {
      needs: true,
      kind: 'key-passphrase',
      hint: 'ssh-add / ssh-keygen 可能会交互式询问私钥口令或文件名',
      fix: '建议手敲执行，或在命令里显式带上 -N "" / -f 参数避免交互。',
    };
  }

  if (
    /(?:^|[;&|(]|\b(?:do|then))\s*mysql\b[^|;&]*\s-{1,2}p(\s|$)/.test(unquoted) ||
    /(?:^|[;&|(]|\b(?:do|then))\s*psql\b[^|;&]*\s(-W|--password)\b/.test(unquoted)
  ) {
    return {
      needs: true,
      kind: 'db-password',
      hint: '数据库客户端会提示输入密码',
      fix: '建议改用读取配置文件的方式（如 ~/.my.cnf / ~/.pgpass），或手敲后手动输入密码。',
    };
  }

  if (/(?:^|[;&|(]|\b(?:do|then))\s*read\s+-s/.test(unquoted)) {
    return { needs: true, kind: 'read-secret', hint: 'read -s 在等交互式输入', fix: '这条只能由你手动执行。' };
  }

  return { needs: false };
}

/**
 * 输出流里出现这些片段，说明命令正在等密码 —— 与其干等超时，不如立刻中断并告诉用户。
 * 都是"明确在等输入"的提示，不是普通报错。
 */
const STRONG_PROMPT_PATTERNS: RegExp[] = [
  /\[sudo\]\s*password for/i,
  /\bsudo:\s*a password is required/i,
  /Enter passphrase for key/i,
  /Enter password\b/i,
  /\bPassword for [^:\r\n]*:/i,
  /Are you sure you want to continue connecting/i,
];

/**
 * 通用提示（`Password:` / `passphrase:` 单独一行）。
 * 必须出现在缓冲**末尾**才算 —— 否则 `grep password xx` 这种把
 * 文件里 "password:" 一行打出来的情况会被误判成在等输入。
 */
const TAIL_PROMPT_RE = /(?:^|\n)[ \t]*(?:password|passphrase)[ \t]*[:：][ \t]*$/i;

/** 从一段输出里嗅出「正在等密码 / 正在等确认」的提示；没有则返回 null */
export function sniffPasswordPrompt(text: string): string | null {
  for (const re of STRONG_PROMPT_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  const tail = TAIL_PROMPT_RE.exec(text);
  if (tail) return tail[0].trim();
  return null;
}
