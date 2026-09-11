import OpenAI from 'openai';
import type { AppConfig } from '../config.js';

export function makeClient(cfg: AppConfig): OpenAI {
  return new OpenAI({
    apiKey: cfg.llm.apiKey || 'sk-placeholder',
    baseURL: cfg.llm.baseURL,
    // 关掉 SDK 自带的重试，改为由 agent 按 agent.retries 统一控制，
    // 否则实际重试次数是 1+2 的乘积，用户配的数字对不上。
    maxRetries: 0,
  });
}

/** 带超时的 LLM 调用：超时就抛，交给上层乐观放行 */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        t = setTimeout(() => rej(new Error('LLM_TIMEOUT')), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export type RetryOptions = {
  /** 额外重试次数（0 = 只尝试一次） */
  retries: number;
  /** 每次尝试的超时毫秒数 */
  timeoutMs?: number;
  /** 重试间隔基数（毫秒），第 n 次退避 = base * n */
  backoffMs?: number;
  /** 每次准备重试时回调，便于给用户提示 */
  onRetry?: (attempt: number, err: Error, delayMs: number) => void;
};

/**
 * 带超时 + 有限重试的调用封装。
 * attempt 从 1 开始计；总共最多尝试 1 + retries 次。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const total = Math.max(1, 1 + Math.floor(opts.retries));
  const backoff = opts.backoffMs ?? 600;
  let lastErr: Error = new Error('UNKNOWN');
  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      return opts.timeoutMs ? await withTimeout(fn(), opts.timeoutMs) : await fn();
    } catch (e) {
      lastErr = e as Error;
      if (attempt >= total) break;
      const delay = backoff * attempt;
      opts.onRetry?.(attempt, lastErr, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };

export async function chat(
  client: OpenAI,
  model: string,
  messages: ChatMsg[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const res = await client.chat.completions.create({
    model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1024,
  });
  return res.choices[0]?.message?.content?.trim() ?? '';
}
