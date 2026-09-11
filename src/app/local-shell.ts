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
    execUser: async (line) => {
      const r = await engine.exec(line);
      return r;
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
