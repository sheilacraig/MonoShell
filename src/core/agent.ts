import type { AppConfig } from '../config.js';
import type { Session } from '../session/types.js';
import type { ExecResult } from '../term/capture.js';
import { chat, makeClient } from './llm.js';
import { historyBlock, systemPrompt } from './prompt.js';
import { checkRisk, truncate } from './safety.js';

export type ConfirmAnswer = 'yes' | 'no' | 'edit';

export interface AgentHost {
  session: Session;
  cfg: AppConfig;
  /** 淡色注释行，用来在单窗口里呈现 AI 的思考，不加任何气泡或分栏 */
  note(text: string): void;
  confirm(command: string, reason: string): Promise<ConfirmAnswer>;
  /** 询问用户要改成什么命令（确认时选 e） */
  editCommand(command: string): Promise<string | null>;
  runCaptured(command: string): Promise<ExecResult>;
  /** 用户按了 Ctrl+C */
  isAborted(): boolean;
}

type Step = { command: string; output: string; exitCode: number };

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
      done: Boolean(o.done),
    };
  } catch {
    return null;
  }
}

export class Agent {
  private client: ReturnType<typeof makeClient>;

  constructor(
    private cfg: AppConfig,
    private host: AgentHost,
  ) {
    this.client = makeClient(cfg);
  }

  async run(goal: string, cwd = process.cwd()): Promise<void> {
    const steps: Step[] = [];
    const max = Math.max(1, this.cfg.safety.maxRounds);

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
        raw = await chat(this.client, this.cfg.llm.chatModel, messages, {
          temperature: 0.2,
          maxTokens: 800,
        });
      } catch (e) {
        this.host.note(`调用模型失败：${(e as Error).message}`);
        return;
      }

      const decision = parseDecision(raw);
      if (!decision) {
        this.host.note(`模型返回无法解析，原文：${truncate(raw, 80)}`);
        return;
      }

      if (decision.note) this.host.note(decision.note);

      if (decision.done || !decision.command.trim()) return;

      const cmd = decision.command.trim();
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
          steps.push(await this.exec(edited));
          continue;
        }
      }

      steps.push(await this.exec(cmd));
    }

    this.host.note(`已达最大步数 ${max}，停止。`);
  }

  private async exec(command: string): Promise<Step> {
    const r = await this.host.runCaptured(command);
    if (r.timedOut) this.host.note('命令超时已中断。');
    return { command, output: r.output, exitCode: r.exitCode };
  }
}
