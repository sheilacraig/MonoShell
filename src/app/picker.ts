import type { AppConfig } from '../config.js';
import { chooseTarget, printBanner } from '../cli/launcher.js';
import { runLocalShell } from './local-shell.js';
import { runSshShell } from './ssh-shell.js';

/** 连接选择 -> 打开 shell 的循环 */
export async function launchLoop(cfg: AppConfig): Promise<void> {
  printBanner();
  for (;;) {
    const target = await chooseTarget(cfg);
    if (!target) return;

    if (target.kind === 'local') {
      await runLocalShell(cfg, false);
    } else {
      await runSshShell(cfg, target.host.name, false);
    }

    if (!cfg.startup.returnToPicker) return;
    process.stdout.write('\r\n\x1b[2m本次会话已结束。\x1b[0m\r\n');
  }
}
