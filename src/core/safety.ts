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
 * 两层判断：白名单优先放行，其次命中黑名单即拦截。
 * 黑名单只是兜底，LLM 自己也会在生成时标注 risk —— 两层任一命中都会要求确认。
 */
export function checkRisk(command: string, cfg: AppConfig): RiskCheck {
  const c = command.trim();
  if (!c) return { risky: false, reason: 'empty' };

  for (const re of compile(cfg.safety.allowlist)) {
    if (re.test(c)) return { risky: false, reason: '命中只读白名单', matched: re.source };
  }

  for (const re of compile(cfg.safety.dangerous)) {
    if (re.test(c)) {
      return { risky: true, reason: '命中高危规则', matched: re.source };
    }
  }

  // 写操作兜底：任何带重定向写文件、或明显变更类的命令都提示一次
  if (/>\s*\S+/.test(c) && !/>\s*\/dev\/null/.test(c)) {
    return { risky: true, reason: '会写入文件' };
  }

  return { risky: false, reason: '未命中规则' };
}

/** 把命令截断到适合终端单行展示的长度 */
export function truncate(s: string, n = 120): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : one.slice(0, n - 1) + '…';
}
