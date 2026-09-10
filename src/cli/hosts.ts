import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configPath, defaultConfig, loadConfig, type AppConfig, type SshHost } from '../config.js';

const C = {
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

/** 问一行，hidden=true 时不回显（用于密码） */
export function promptLine(q: string, hidden = false): Promise<string> {
  process.stdout.write(q);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    } else {
      stdin.setEncoding('utf8');
    }
    stdin.resume();
    let buf = '';
    const onData = (d: Buffer | string) => {
      const s = typeof d === 'string' ? d : d.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\r\n');
          resolve(buf);
          return;
        }
        if (ch === '\x03') {
          cleanup();
          process.stdout.write('^C\r\n');
          process.exit(130);
        }
        if (ch === '\x7f' || ch === '\b') {
          buf = buf.slice(0, -1);
          if (!hidden) process.stdout.write('\b \b');
          continue;
        }
        buf += ch;
        if (!hidden) process.stdout.write(ch);
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.pause();
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
    };
    stdin.on('data', onData);
  });
}

function saveConfig(cfg: AppConfig): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* Windows 无 chmod，忽略 */
  }
}

function expand(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

async function addHost(cfg: AppConfig): Promise<void> {
  const name = (await promptLine('别名 (如 prod-web-01): ')).trim();
  if (!name) {
    console.log('别名不能为空');
    return;
  }
  if (cfg.ssh.hosts.some((h) => h.name === name)) {
    const overwrite = (await promptLine(`别名 ${name} 已存在，覆盖? [y/N]: `)).trim().toLowerCase();
    if (overwrite !== 'y') return;
  }

  const host = (await promptLine('主机 IP / 域名: ')).trim();
  const portStr = (await promptLine('端口 [22]: ')).trim();
  const username = (await promptLine('用户名: ')).trim();
  if (!host || !username) {
    console.log('主机和用户名必填');
    return;
  }

  const authType = (await promptLine('认证方式: [1] 私钥 (推荐)  [2] 密码  : ')).trim();

  const entry: SshHost = {
    name,
    host,
    port: portStr ? Number(portStr) : 22,
    username,
  };

  if (authType === '2') {
    const pw = await promptLine('密码 (不回显): ', true);
    const save = (await promptLine('是否明文保存密码到配置? [y/N]: ')).trim().toLowerCase();
    if (save === 'y') {
      entry.password = pw;
      console.log(`${C.yellow}注意：密码以明文存在 ~/.ai-shell/config.json，已尝试设置文件权限 600。更推荐改用私钥。${C.reset}`);
    } else {
      console.log(`${C.dim}本次不保存密码，之后连接会提示输入。${C.reset}`);
    }
  } else {
    const defaultKey = path.join(os.homedir(), '.ssh', 'id_rsa');
    const key = (await promptLine(`私钥路径 [${defaultKey}]: `)).trim() || defaultKey;
    entry.privateKeyPath = key;
    if (fs.existsSync(expand(key) + '.pub') === false && fs.existsSync(expand(key)) === false) {
      console.log(`${C.yellow}警告：${key} 看起来不存在，连接时可能失败。${C.reset}`);
    }
    const pp = await promptLine('私钥口令 (没有则直接回车): ', true);
    if (pp) entry.passphrase = pp;
  }

  const startup = (await promptLine('登录后自动执行的命令 (可选，多条用 ; 分隔): ')).trim();
  if (startup) entry.startup = startup.split(';').map((s) => s.trim()).filter(Boolean);

  const comment = (await promptLine('备注 (可选): ')).trim();
  if (comment) entry.comment = comment;

  cfg.ssh.hosts = cfg.ssh.hosts.filter((h) => h.name !== name);
  cfg.ssh.hosts.push(entry);
  saveConfig(cfg);
  console.log(`${C.green}已保存：${name} -> ${username}@${host}${C.reset}`);
}

function listHosts(cfg: AppConfig): void {
  if (!cfg.ssh.hosts.length) {
    console.log(`${C.dim}还没有保存任何连接。用 ai ssh add 添加一个。${C.reset}`);
    return;
  }
  console.log(`${C.cyan}已保存的连接：${C.reset}`);
  for (const h of cfg.ssh.hosts) {
    const auth = h.privateKeyPath ? 'key' : h.password ? 'password' : 'prompt';
    const extra = h.comment ? `  ${C.dim}# ${h.comment}${C.reset}` : '';
    console.log(`  ${C.green}${h.name.padEnd(16)}${C.reset} ${h.username}@${h.host}:${h.port ?? 22}  [${auth}]${extra}`);
  }
  console.log(`${C.dim}连接：ai --ssh <别名>   或   ai ssh use <别名>${C.reset}`);
}

function removeHost(cfg: AppConfig, name: string): void {
  const before = cfg.ssh.hosts.length;
  cfg.ssh.hosts = cfg.ssh.hosts.filter((h) => h.name !== name);
  if (cfg.ssh.hosts.length === before) {
    console.log(`没有找到别名 ${name}`);
    return;
  }
  saveConfig(cfg);
  console.log(`已删除 ${name}`);
}

export async function handleSshCommand(args: string[]): Promise<void> {
  const cfg = loadConfig();
  const sub = args[0];

  if (!sub || sub === 'ls' || sub === 'list') {
    listHosts(cfg);
    return;
  }
  if (sub === 'add' || sub === 'new') {
    await addHost(cfg);
    return;
  }
  if (sub === 'rm' || sub === 'remove' || sub === 'del') {
    const name = args[1];
    if (!name) {
      console.log('用法：ai ssh rm <别名>');
      return;
    }
    removeHost(cfg, name);
    return;
  }
  if (sub === 'use' || sub === 'connect') {
    const name = args[1];
    if (!name) {
      listHosts(cfg);
      return;
    }
    // 由主程序接手：这里只校验存在性
    const h = cfg.ssh.hosts.find((x) => x.name === name);
    if (!h) {
      console.log(`没有找到别名 ${name}`);
      process.exitCode = 1;
      return;
    }
    return;
  }
  if (sub === 'path') {
    console.log(configPath());
    return;
  }
  if (sub === 'init') {
    const p = configPath();
    if (fs.existsSync(p)) {
      console.log(`配置已存在：${p}`);
      return;
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(defaultConfig(), null, 2), 'utf8');
    console.log(`已生成默认配置：${p}`);
    return;
  }

  console.log(`未知子命令：${sub}`);
  console.log('用法：ai ssh <ls|add|rm <别名>|use <别名>|init|path>');
}
