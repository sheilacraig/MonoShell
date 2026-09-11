import type { AppConfig } from '../config.js';
import { Agent } from '../core/agent.js';
import { Classifier, looksLikeNotFound } from '../core/classifier.js';
import { checkRisk } from '../core/safety.js';
import type { ExecResult } from '../term/capture.js';
import { InputHub, TerminalUI } from '../term/ui.js';
import { LineEditor, type Completer } from '../shell/line.js';
import { getUsage } from '../shell/usage.js';

export type ReplEnv = {
  label: string;
  promptLine: () => string;
  completer: Completer;
  history: string[];
  getCwd?: () => string;
  /** 用户手敲的命令；本地直接执行，SSH 则发给远端 */
  execUser: (line: string) => Promise<{ output: string; code: number; clear?: boolean; exit?: boolean }>;
  /** AI 发起的命令，需要拿到输出回灌给模型 */
  execCaptured: (cmd: string, timeoutMs?: number) => Promise<ExecResult>;
  /**
   * 把命令交回用户自己的终端执行（等同手敲）。
   * SSH 会话提供它：远端是真实 TTY，sudo 密码提示出来用户自己输；
   * 本地内置 shell 不提供（非交互），走「打印命令请手敲」兜底。
   */
  execInteractive?: (cmd: string) => Promise<void>;
  /** 会话被动结束（如远端断开）时回调，用于把控制权交回上层 */
  registerClose?: (cb: () => void) => void;
  /**
   * 取走「远端输出怎么落到屏幕上」的写函数。
   * SSH 会话用它：远端消息可能在本地提示符画出去之后才到，
   * 交给行编辑器先清行、吐输出、再重画提示符，才不会被顶掉。
   */
  registerRemoteWriter?: (write: (s: string) => void) => void;
  /** 退出时是否打印告别语（连接选择循环里由上层统一提示） */
  farewell?: boolean;
};

export async function repl(cfg: AppConfig, env: ReplEnv): Promise<void> {
  const hub = new InputHub();
  const ui = new TerminalUI(cfg, hub);

  let aborted = false;
  const editor = new LineEditor(env.promptLine, env.history, env.completer, env.getCwd);
  const classifier = new Classifier(cfg, env.label);
  // 命名避开 index.ts 的 usage() 帮助函数，免得读起来打架
  const stats = getUsage();

  const agent = new Agent(cfg, {
    // Agent 只需要环境描述（SessionContext），不需要 IO 能力，
    // 本地内置 shell 场景下没有真实 Session，直接给描述对象即可。
    session: {
      kind: env.label.startsWith('ssh:') ? 'ssh' : 'local',
      label: env.label,
      osFamily: env.label.startsWith('ssh:') ? 'unix' : process.platform === 'win32' ? 'windows' : 'unix',
      shellType: 'unix',
      eol: env.label.startsWith('ssh:') ? '\n' : process.platform === 'win32' ? '\r' : '\n',
    },
    cfg,
    note: (t) => ui.note(t),
    confirm: (c, r) => ui.confirm(c, r),
    needAuth: (c, h, f) => ui.needAuth(c, h, f),
    editCommand: (c) => ui.editCommand(c),
    runCaptured: env.execCaptured,
    runInteractive: env.execInteractive,
    isAborted: () => aborted,
  });

  const isTty = Boolean(process.stdin.isTTY);
  if (isTty) process.stdin.setRawMode(true);

  const onSigInt = () => {
    aborted = true;
  };
  process.on('SIGINT', onSigInt);

  // 会话被动结束（远端断开）时不要卡在等待输入上，直接收尾
  let closed = false;
  env.registerClose?.(() => {
    closed = true;
    editor.interrupt();
  });
  // 把「远端输出怎么落屏」交给行编辑器：它才知道要不要先清掉提示符那一行
  env.registerRemoteWriter?.((s) => editor.writeExternal(s));

  const takeOver = async (goal: string, why?: string) => {
    aborted = false;
    if (why) ui.note(why);
    const cwd = env.getCwd ? env.getCwd() : process.cwd();
    // raw 模式下 Ctrl+C 不会触发 SIGINT，只会作为 \x03 字符进入 stdin，
    // 上面的 process.on('SIGINT') 永远等不到。AI 运行期间盯一下这个字符，
    // 否则「Ctrl+C 中断 AI」形同虚设（stdin 被 editor pause 了，要先 resume）。
    const onAbortKey = (d: Buffer | string) => {
      if (String(d).includes('\x03')) aborted = true;
    };
    if (isTty) {
      process.stdin.on('data', onAbortKey);
      process.stdin.resume();
    }
    try {
      await agent.run(goal, cwd);
    } finally {
      process.stdin.removeListener('data', onAbortKey);
      if (isTty) process.stdin.pause();
    }
  };

  try {
    for (;;) {
      if (closed) break;
      process.stdout.write(env.promptLine());
      const line = await editor.read();
      if (line === null) break;

      const t = line.trim();
      if (!t) continue;

      if (env.history[env.history.length - 1] !== t) env.history.push(t);

      // 1) 意图判定与前缀触发
      const normLower = t.toLowerCase();
      const hit = cfg.trigger.prefixes.find((p) => {
        const normP = p.toLowerCase();
        return normLower.startsWith(normP) || normLower === normP.trim();
      });

      let isAiGoal = false;
      let goal = '';

      if (hit && cfg.trigger.mode !== 'smart') {
        // 形如 `ai ssh ...` / `ai --local` / `ai 看看...` 都会命中 `ai ` 前缀。
        // 若后面跟着的是 ai 自身的子命令/参数，说明用户想把 ai 当命令调用
        // （例如 `ai ssh init` 去初始化连接），不能误判成 AI 目标再去调 LLM，
        // 否则 apiKey 未配置时会无限卡死。这些走普通命令透传即可。
        const rest = t.slice(hit.length).trim();
        const first = rest.split(/\s+/)[0].toLowerCase();
        const aiSub = ['ssh', 'init', 'config', '--local', '--ssh', '--help', '-h', 'help', 'local'];
        if (aiSub.includes(first)) {
          isAiGoal = false;
        } else {
          isAiGoal = true;
          goal = rest;
          if (!goal) {
            ui.warn('想让我做什么？例如：ai 看看哪个目录最占空间');
            continue;
          }
        }
      } else if (cfg.trigger.mode === 'smart' || (cfg.trigger.mode === 'hybrid' && !hit)) {
        const cRes = await classifier.classify(t);
        if (cRes.verdict === 'NL') {
          isAiGoal = true;
          goal = hit ? t.slice(hit.length).trim() : t;
        }
      }

      if (isAiGoal) {
        await takeOver(goal);
        continue;
      }

      // 2) 普通命令
      // 手敲的危险命令也要确认（默认开启，safety.confirmManual 可关）。
      // 只按高危黑名单判定，不会因为 `echo x > f` 这类日常写文件而打扰。
      // 非交互（管道 / 脚本）与 SSH 会话不拦：前者没法问、后者远端是真实主机，
      // 误判会打断正常运维节奏。
      let cmd = t;
      if (cfg.safety.confirmManual && env.label === 'local' && isTty) {
        const risk = checkRisk(cmd, cfg, 'dangerous');
        if (risk.risky) {
          const ans = await ui.confirm(cmd, risk.reason);
          if (ans === 'no') {
            ui.note('已取消，未执行。');
            continue;
          }
          if (ans === 'edit') {
            const edited = await ui.editCommand(cmd);
            if (!edited) {
              ui.note('已取消，未执行。');
              continue;
            }
            cmd = edited;
          }
        }
      }

      // 记一笔使用统计，供下次 Tab 按常用度推荐。
      // 放在这里而不是 takeOver：AI 代跑的命令体现的是模型的选择，
      // 记进去会把「用户习惯」带偏。手敲的即使是危险命令、最终取消，也算一次意图。
      stats.record(cmd);

      const r = await env.execUser(cmd);
      if (r.clear) {
        process.stdout.write('\x1b[2J\x1b[H');
        continue;
      }
      if (r.exit) break;
      if (r.output) process.stdout.write(r.output.replace(/\n$/, '') + '\n');

      // 3) 兜底：说人话却被当成命令，报了「未找到命令」时自动接管。
      // 但 `ai ssh ...` 这类 ai 自身子命令报找不到时，不要接 AI（可能是路径问题），
      // 否则又会绕回调 LLM 卡死。
      if (
        cfg.trigger.fallbackOnNotFound &&
        !/^ai\s+(ssh|init|config|--local|--ssh|--help|-h|help|local)\b/i.test(cmd) &&
        looksLikeNotFound(r.output, cmd)
      ) {
        await takeOver(t, '这句不像命令，交给 AI 试试');
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigInt);
    // 使用统计平时靠合并窗口攒着写，会话收尾时强制落盘
    stats.flush();
    try {
      if (isTty) process.stdin.setRawMode(false);
    } catch {
      /* noop */
    }
  }
  if (env.farewell !== false) process.stdout.write('\r\n再见。\r\n');
}
