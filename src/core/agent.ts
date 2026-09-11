import type { AppConfig } from '../config.js';
import type { SessionContext } from '../session/types.js';
import type { ExecResult } from '../term/capture.js';
import { chat, makeClient, withRetry } from './llm.js';
import { historyBlock, systemPrompt } from './prompt.js';
import { checkRisk, detectInteractiveAuth, truncate } from './safety.js';

export type ConfirmAnswer = 'yes' | 'no' | 'edit';

export interface AgentHost {
  /** 环境描述（kind/label/osFamily/...），只用于拼 systemPrompt，不需要 IO 能力 */
  session: SessionContext;
  cfg: AppConfig;
  /** 淡色注释行，用来在单窗口里呈现 AI 的思考，不加任何气泡或分栏 */
  note(text: string): void;
  confirm(command: string, reason: string): Promise<ConfirmAnswer>;
  /** 命令需要用户手动输密码时的提示（与 confirm 分开，语义不同） */
  needAuth(command: string, hint: string, fix?: string): Promise<ConfirmAnswer>;
  /** 询问用户要改成什么命令（确认时选 e） */
  editCommand(command: string): Promise<string | null>;
  runCaptured(command: string, timeoutMs?: number): Promise<ExecResult>;
  /**
   * 把命令交回用户自己的终端执行（等同手敲）：SSH 场景下远端是真实 TTY，
   * 密码提示出来用户自己输。本地内置 shell 等非交互环境不提供此能力，
   * 走「打印命令请用户手敲」的兜底。
   */
  runInteractive?(command: string): Promise<void>;
  /** 用户按了 Ctrl+C */
  isAborted(): boolean;
}

type Step = {
  command: string;
  output: string;
  exitCode: number;
  /** 命令卡在等密码上被中断 */
  needsInput?: boolean;
  promptText?: string;
};

/** 用户坚持要试需要密码的命令时，给它一个短超时，避免干等 */
const INTERACTIVE_TIMEOUT_MS = 8000;

type Decision = {
  note: string;
  command: string;
  done: boolean;
};

function parseDecision(raw: string): Decision | null {
  let s = raw.trim();
  // 容忍模型给代码块或多余文字
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1)) as Partial<Decision>;
    return {
      note: String(o.note ?? ''),
      command: String(o.command ?? ''),
      // 模型偶尔把 done 写成字符串 "false" —— Boolean("false") 是 true，
      // 会让 Agent 刚跑一步就提前收工，必须显式比较。
      done: o.done === true || (o.done as unknown) === 'true',
    };
  } catch {
    return null;
  }
}

export class Agent {
  private client: ReturnType<typeof makeClient>;
  private chatFn: typeof chat;

  constructor(
    private cfg: AppConfig,
    private host: AgentHost,
    /** 便于测试注入假的模型调用 */
    deps: { chat?: typeof chat } = {},
  ) {
    this.client = makeClient(cfg);
    this.chatFn = deps.chat ?? chat;
  }

  async run(goal: string, cwd = process.cwd()): Promise<void> {
    const steps: Step[] = [];
    // 迭代轮数（AI 反复「规划→执行→看输出」的次数上限），默认 5，可在 agent.maxRounds 调整
    const max = Math.max(1, this.cfg.agent.maxRounds);

    // 没有配置 API Key 时不要无限卡住，直接提示用户去配
    if (!this.cfg.llm.apiKey) {
      this.host.note('还没有配置大模型 API Key，AI 功能无法工作。');
      this.host.note('运行 ai setup 跟着提示配一遍，或直接编辑 ~/.ai-shell/config.json 的 llm.apiKey（也可用环境变量 OPENAI_API_KEY / LLM_API_KEY）。');
      if (goal) this.host.note(`你的输入「${goal.slice(0, 60)}」暂时没法交给 AI 处理。`);
      return;
    }

    for (let round = 1; round <= max; round++) {
      if (this.host.isAborted()) {
        this.host.note('已停止。');
        return;
      }

      const messages = [
        { role: 'system' as const, content: systemPrompt(this.host.session, cwd) },
        { role: 'user' as const, content: `用户目标：${goal}${historyBlock(steps)}` },
      ];

      let raw: string;
      try {
        // 超时 + 有限重试都由 agent 段配置控制（agent.timeoutMs / agent.retries）。
        // 兜住 SDK 在 apiKey/baseURL 错误时的长时间挂起，否则表现就是「一直卡着」。
        raw = await withRetry(
          () =>
            this.chatFn(this.client, this.cfg.llm.chatModel, messages, {
              temperature: 0.2,
              maxTokens: 800,
            }),
          {
            retries: this.cfg.agent.retries,
            timeoutMs: this.cfg.agent.timeoutMs,
            onRetry: (attempt, err) =>
              this.host.note(
                `模型调用失败，重试中（第 ${attempt}/${this.cfg.agent.retries} 次）：${err.message}`,
              ),
          },
        );
      } catch (e) {
        const msg = (e as Error).message;
        this.host.note(
          /LLM_TIMEOUT/.test(msg)
            ? `调用模型超时（${Math.round(this.cfg.agent.timeoutMs / 1000)}s，已重试 ${this.cfg.agent.retries} 次），本轮中止。请检查 llm.baseURL / apiKey / 网络。`
            : `调用模型失败（已重试 ${this.cfg.agent.retries} 次）：${msg}`,
        );
        return;
      }

      const decision = parseDecision(raw);
      if (!decision) {
        this.host.note(`模型返回无法解析，原文：${truncate(raw, 80)}`);
        return;
      }

      if (decision.note) this.host.note(decision.note);

      if (decision.done || !decision.command.trim()) {
        // 模型按规则 10 给出「需要手动执行」的命令（典型：sudo 要密码）时，
        // 不能默默收工——历史上这里只打了一句 note 就 return，
        // 用户连该敲什么都不知道（实测翻车现场）。命令必须交到用户手上。
        const c = decision.command.trim();
        if (decision.done && c) await this.handToTerminal(c);
        return;
      }

      let cmd = decision.command.trim();

      // 需要交互式密码的命令：AI 拿不到终端，硬跑只会卡到超时，
      // 而且会让模型接下来连着试各种 sudo 变体、把轮数烧光。所以先问用户。
      const need = detectInteractiveAuth(cmd);
      if (need.needs) {
        // 完整说明（含 hint / fix）由 needAuth 的提示框呈现，这里不再重复打印，避免同一句话出现两遍。
        const ans = await this.host.needAuth(cmd, need.hint ?? '需要交互式密码', need.fix);
        if (ans === 'no') {
          this.host.note('已跳过，未执行。');
          return;
        }
        if (ans === 'edit') {
          const edited = await this.host.editCommand(cmd);
          if (!edited) {
            this.host.note('已取消，未执行。');
            return;
          }
          cmd = edited;
        } else {
          if (this.host.runInteractive) {
            // 有交互通道（SSH）：交回用户自己的终端，密码提示出来自己输
            this.host.note('已交到你的终端执行（密码提示出来自己输）：');
            await this.host.runInteractive(cmd);
            return;
          }
          // 没有交互通道（本地内置 shell）：给个短超时试一次，别干等 30 秒
          this.host.note('好，试一次，卡住会自动中断。');
          const step = await this.exec(cmd, INTERACTIVE_TIMEOUT_MS);
          if (step.needsInput) {
            this.host.note(`命令卡在密码提示上（${step.promptText ?? '等输入'}），已中断。请手敲执行。`);
            return;
          }
          steps.push(step);
          continue;
        }
      }

      const risk = checkRisk(cmd, this.cfg);
      if (risk.risky) {
        const ans = await this.host.confirm(cmd, risk.reason);
        if (ans === 'no') {
          this.host.note('已取消，未执行。');
          return;
        }
        if (ans === 'edit') {
          const edited = await this.host.editCommand(cmd);
          if (!edited) {
            this.host.note('已取消，未执行。');
            return;
          }
          const again = checkRisk(edited, this.cfg);
          if (again.risky) {
            const a2 = await this.host.confirm(edited, again.reason);
            if (a2 !== 'yes') {
              this.host.note('已取消，未执行。');
              return;
            }
          }
          cmd = edited;
        }
      }

      const step = await this.exec(cmd);
      if (step.needsInput) {
        // 兜底：预判没覆盖到的命令（例如 `sudo -S`）跑到一半卡在密码提示上被嗅探中断。
        // 同样直接收尾，不把轮数浪费在"换一种写法再试"上。
        this.host.note(`命令卡在密码提示上（${step.promptText ?? '等输入'}），已中断，不再往下试。`);
        if (this.host.runInteractive) {
          // 有交互通道就直接问用户要不要交回终端，别只甩一句「请手敲」
          await this.handToTerminal(cmd);
        } else {
          this.host.note(`要看这条的结果，请在本会话里手敲：`);
          this.host.note(`  ${cmd}`);
          const hint = detectInteractiveAuth(cmd).fix;
          if (hint) this.host.note(hint);
        }
        return;
      }
      steps.push(step);
    }

    this.host.note(`已达最大迭代轮数 ${max}（agent.maxRounds 可调），停止。`);
  }

  /**
   * 「需要交互输密码」的统一出口：把命令交回用户自己的终端执行，
   * 密码提示出来用户自己输。没有交互通道（本地内置 shell / 测试）时，
   * 至少把命令完整打出来，让用户知道该敲什么。
   */
  private async handToTerminal(cmd: string): Promise<void> {
    const need = detectInteractiveAuth(cmd);
    if (!this.host.runInteractive) {
      this.host.note('请在本会话里手敲执行：');
      this.host.note(`  ${cmd}`);
      if (need.fix) this.host.note(need.fix);
      return;
    }
    const ans = await this.host.needAuth(cmd, need.hint ?? '需要交互式输入', need.fix);
    if (ans === 'no') {
      this.host.note('已跳过，未执行。');
      return;
    }
    let finalCmd = cmd;
    if (ans === 'edit') {
      const edited = await this.host.editCommand(cmd);
      if (!edited) {
        this.host.note('已取消，未执行。');
        return;
      }
      finalCmd = edited;
    }
    this.host.note('已交到你的终端执行（密码提示出来自己输）：');
    await this.host.runInteractive(finalCmd);
  }

  private async exec(command: string, timeoutMs?: number): Promise<Step> {
    const r = await this.host.runCaptured(command, timeoutMs);
    if (r.timedOut) this.host.note('命令超时已中断。');
    return { command, output: r.output, exitCode: r.exitCode, needsInput: r.needsInput, promptText: r.promptText };
  }
}
