import OpenAI from 'openai';
import type { AppConfig } from '../config.js';

export function makeClient(cfg: AppConfig): OpenAI {
  return new OpenAI({
    apiKey: cfg.llm.apiKey || 'sk-placeholder',
    baseURL: cfg.llm.baseURL,
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
