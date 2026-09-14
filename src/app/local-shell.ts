import type { AppConfig } from '../config.js';
import { ShellEngine } from '../shell/engine.js';
import { makeLocalCompleter } from '../shell/complete.js';
import { getUsage } from '../shell/usage.js';
import { repl } from './repl.js';

export async function runLocalShell(cfg: AppConfig, farewell = true): Promise<void> {
  const engine = new ShellEngine();

  await repl(cfg, {
    label: 'local',
    farewell,
    promptLine: () => engine.prompt(),
    completer: makeLocalCompleter(getUsage(), () => engine.cwd),
    history: engine.history,
    getCwd: () => engine.cwd,
    expandAlias: (line) => engine.expandAlias(line),
    // Ctrl+C：杀掉正在跑的子进程树（含内置 sleep 这类没有子进程的命令）
    interrupt: () => engine.interrupt(),
    execUser: async (line, signal) => {
      let streamed = false;
      let tail = '';
      const r = await engine.exec(line, undefined, {
        signal,
        // 边跑边打，长耗时命令不至于界面上一片死寂、看不出在跑
        onData: (chunk) => {
          streamed = true;
          process.stdout.write(chunk);
          tail = chunk.slice(-1);
        },
      });
      // 流式输出没以换行收尾时补一个，免得提示符跟输出黏在同一行
      if (streamed && tail && tail !== '\n') process.stdout.write('\n');
      // output 必须原样带回去：REPL 靠它跑「未找到命令」的 AI 兜底。
      // 只是同一份内容已经实时打过了，用 streamed 告诉它别再打一遍。
      return { ...r, streamed };
    },
    execCaptured: async (cmd, timeoutMs) => {
      // AI 的命令也要过一遍危险确认，并在终端留痕
      process.stdout.write(`\r\n\x1b[36m$ ${cmd}\x1b[0m\r\n`);
      const r = await engine.exec(cmd, timeoutMs);
      if (r.output) process.stdout.write(r.output.replace(/\n$/, '') + '\n');
      return { output: r.output, exitCode: r.code, timedOut: false };
    },
  });
}
