import type { AppConfig } from '../config.js';

export type RiskCheck = {
  risky: boolean;
  /** 为什么被判危险 / 为什么被放行 */
  reason: string;
  matched?: string;
};

function compile(patterns: string[]): RegExp[] {
  return patterns.map((p) => {
    try {
      return new RegExp(p, 'i');
    } catch {
      return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
  });
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

  // 1) 高危黑名单优先拦截
  for (const re of compile(cfg.safety.dangerous)) {
    if (re.test(c)) {
      return { risky: true, reason: '命中高危规则', matched: re.source };
    }
  }

  if (level === 'dangerous') {
    return { risky: false, reason: '仅高危黑名单档，未命中' };
  }

  // 2) 写文件重定向拦截（排除 > /dev/null）
  if (/>{1,2}\s*(?!\/dev\/null)\S+/.test(c)) {
    return { risky: true, reason: '会写入文件' };
  }

  // 3) 只读白名单放行
  for (const re of compile(cfg.safety.allowlist)) {
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

  // sudo -n（非交互）或 echo pw | sudo -S 这类已经喂了密码的不算
  if (/\bsudo\b/.test(c) && !/\bsudo\b\s+(-\S+\s+)*-n\b/.test(c) && !/\bsudo\s+-\S*S\b/.test(c)) {
    return {
      needs: true,
      kind: 'sudo',
      hint: 'sudo 需要你的登录密码，AI 不能代你输入',
      fix: '想让它以后能自动跑：给该用户配 NOPASSWD（sudo visudo 加一行 `用户名 ALL=(ALL) NOPASSWD:ALL`）。',
    };
  }

  if (/(^|[\s;|&(])su\s/.test(c) || /(^|[\s;|&(])su$/.test(c)) {
    return { needs: true, kind: 'su', hint: 'su 切换用户需要输入密码', fix: '建议手敲执行，或直接用 sudo 免密切换。' };
  }

  if (/(^|[\s;|&(])passwd(\s|$)/.test(c)) {
    return { needs: true, kind: 'passwd', hint: 'passwd 必须交互式输入新密码', fix: '这条只能由你手动执行。' };
  }

  if (/\bssh-add\b/.test(c) || /\bssh-keygen\b/.test(c)) {
    return {
      needs: true,
      kind: 'key-passphrase',
      hint: 'ssh-add / ssh-keygen 可能会交互式询问私钥口令或文件名',
      fix: '建议手敲执行，或在命令里显式带上 -N "" / -f 参数避免交互。',
    };
  }

  if (/\bmysql\b[^|;&]*\s-{1,2}p(\s|$)/.test(c) || /\bpsql\b[^|;&]*\s(-W|--password)\b/.test(c)) {
    return {
      needs: true,
      kind: 'db-password',
      hint: '数据库客户端会提示输入密码',
      fix: '建议改用读取配置文件的方式（如 ~/.my.cnf / ~/.pgpass），或手敲后手动输入密码。',
    };
  }

  if (/(^|[\s;|&(])read\s+-s/.test(c)) {
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
