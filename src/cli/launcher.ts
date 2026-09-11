import os from 'node:os';
import { loadConfig, type AppConfig, type SshHost } from '../config.js';
import { addHostInteractive, removeHost } from './hosts.js';
import { promptLine, type Asker } from '../term/prompt.js';
import { runSetupWizard, setupHint } from './setup.js';

export type { Asker } from '../term/prompt.js';

const C = {
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  purple: '\x1b[35m',
  bold: '\x1b[1m',
};

/** 选择结果：本地，或某台远程主机 */
export type Target = { kind: 'local' } | { kind: 'ssh'; host: SshHost };

export function printBanner(): void {
  process.stdout.write(
    `\r\n${C.cyan}${C.bold}MonoShell${C.reset} ${C.dim}单窗口 AI 运维终端${C.reset}\r\n` +
      `${C.dim}先选连接，确认之后再进 shell。远程主机的命令与 AI 都在远端执行。${C.reset}\r\n`,
  );
}

/** 按显示宽度补空格（中文按 2 列算），保证表格对齐 */
function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(
      ch,
    )
      ? 2
      : 1;
  }
  return w;
}

function pad(s: string, width: number): string {
  const d = width - dispWidth(s);
  return d > 0 ? s + ' '.repeat(d) : s;
}

function authOf(h: SshHost): string {
  if (h.privateKeyPath) return '私钥';
  if (h.password) return '密码(已保存)';
  return '连接时输入密码';
}

function localEndpoint(): string {
  const shell = process.platform === 'win32' ? '内置 shell' : process.env.SHELL || '/bin/bash';
  return `${os.userInfo().username}@${os.hostname()} · ${shell}`;
}

function drawPicker(cfg: AppConfig): void {
  const hosts = cfg.ssh.hosts;
  const rows: string[] = [];

  rows.push(
    `  ${C.bold}[0]${C.reset}  ${C.green}${pad('本地终端', 22)}${C.reset}` +
      `${pad(localEndpoint(), 40)} ${C.dim}—${C.reset}`,
  );
  hosts.forEach((h, i) => {
    const endpoint = `${h.username}@${h.host}:${h.port ?? 22}`;
    const comment = h.comment ? ` ${C.dim}# ${h.comment}${C.reset}` : '';
    rows.push(
      `  ${C.bold}[${i + 1}]${C.reset}  ${pad(h.name, 22)}${pad(endpoint, 40)} ${authOf(h)}${comment}`,
    );
  });

  const emptyHint = hosts.length
    ? ''
    : `${C.dim}  还没有远程主机。按 a 添加一台（推荐私钥认证），之后就能在远端主机上跑命令和 AI。${C.reset}\r\n`;

  const hint = setupHint(cfg);

  process.stdout.write(
    `\r\n${C.cyan}${C.bold}选择要连接的终端${C.reset}\r\n\r\n` +
      rows.join('\r\n') +
      `\r\n\r\n` +
      emptyHint +
      (hint ? `\r\n${hint}` : '') +
      `${C.dim}  a 新增远程主机    d 删除远程主机    c 配置引导    q 退出${C.reset}\r\n`,
  );
}

/** 把序号 / 别名 / 唯一前缀解析成主机 */
function resolveHost(cfg: AppConfig, token: string): SshHost | null {
  if (/^\d+$/.test(token)) {
    return cfg.ssh.hosts[Number(token) - 1] ?? null;
  }
  const exact = cfg.ssh.hosts.find((h) => h.name === token);
  if (exact) return exact;
  const partial = cfg.ssh.hosts.filter((h) => h.name.startsWith(token));
  return partial.length === 1 ? partial[0] : null;
}

/** 提问函数，便于测试时注入假输入 */
const askDefault: Asker = (q, hidden) => promptLine(q, hidden);

/** 连接前的确认卡片。返回 true 表示用户确认 */
async function confirmTarget(t: Target, ask: Asker): Promise<boolean> {
  process.stdout.write('\r\n');
  if (t.kind === 'local') {
    process.stdout.write(
      `  ${C.cyan}${C.bold}本地终端${C.reset}\r\n` +
        `    类型      ${C.dim}内置 shell — 命令在本机执行，不经过网络${C.reset}\r\n` +
        `    用户      ${os.userInfo().username}@${os.hostname()}\r\n` +
        `    平台      ${process.platform} ${process.arch}\r\n` +
        `    工作目录  ${process.cwd()}\r\n`,
    );
  } else {
    const h = t.host;
    const auth = h.privateKeyPath
      ? `私钥 ${h.privateKeyPath}`
      : h.password
        ? '密码（已保存在配置文件）'
        : '连接时输入密码';
    process.stdout.write(
      `  ${C.cyan}${C.bold}${h.name}${C.reset}\r\n` +
        `    地址      ${h.username}@${h.host}:${h.port ?? 22}\r\n` +
        `    认证      ${auth}\r\n` +
        (h.startup?.length ? `    登录后执行 ${h.startup.join(' ; ')}\r\n` : '') +
        (h.comment ? `    备注      ${h.comment}\r\n` : '') +
        `    ${C.dim}命令与 AI 均在远端主机上执行${C.reset}\r\n`,
    );
  }

  const ans = (await ask('  连接? [Y/n] ')).trim().toLowerCase();
  if (ans === '' || ans === 'y' || ans === 'yes') return true;
  process.stdout.write(`  ${C.dim}已取消，回到连接选择。${C.reset}\r\n`);
  return false;
}

/**
 * 连接选择主循环。返回 null 表示用户选择退出。
 * 增删主机后会重新读取配置文件，保证列表是最新的。
 */
export async function chooseTarget(cfg: AppConfig, ask: Asker = askDefault): Promise<Target | null> {
  for (;;) {
    drawPicker(cfg);
    const raw = (await ask('选择 > ')).trim();
    const key = raw.toLowerCase();

    // 本地（编号 0，也是空回车时的默认值）
    if (key === '' || key === '0' || key === 'local' || key === '本地') {
      if (await confirmTarget({ kind: 'local' }, ask)) return { kind: 'local' };
      continue;
    }

    if (key === 'q' || key === 'quit' || key === 'exit') return null;

    if (key === 'a' || key === 'add' || key === 'new') {
      await addHostInteractive(cfg);
      Object.assign(cfg, loadConfig());
      continue;
    }

    // 配置引导：未配置 / 想改配置都可以走这里
    if (key === 'c' || key === 'config' || key === 'setup') {
      await runSetupWizard({ cfg });
      Object.assign(cfg, loadConfig());
      continue;
    }

    if (key === 'd' || key === 'del' || key === 'rm') {
      const token = (await ask('  删除哪一台（序号或别名，回车取消）: ')).trim();
      if (!token) continue;
      const h = resolveHost(cfg, token);
      if (!h) {
        process.stdout.write(`  ${C.yellow}没有找到 ${token}${C.reset}\r\n`);
        continue;
      }
      const ok = (
        await ask(`  确认删除 ${C.green}${h.name}${C.reset} (${h.username}@${h.host})? [y/N]: `)
      )
        .trim()
        .toLowerCase();
      if (ok === 'y') {
        removeHost(cfg, h.name);
        Object.assign(cfg, loadConfig());
      } else {
        process.stdout.write(`  ${C.dim}已取消。${C.reset}\r\n`);
      }
      continue;
    }

    const host = resolveHost(cfg, raw);
    if (!host) {
      process.stdout.write(`  ${C.yellow}无法识别「${raw}」，请输入序号或别名。${C.reset}\r\n`);
      continue;
    }
    if (await confirmTarget({ kind: 'ssh', host }, ask)) return { kind: 'ssh', host };
  }
}

export { C as palette };
