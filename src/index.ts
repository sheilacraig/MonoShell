#!/usr/bin/env node
import fs from 'node:fs';
import { loadConfig, writeDefaultConfig, configPath } from './config.js';
import { handleSshCommand } from './cli/hosts.js';
import { runSetupWizard, writeConfigExample } from './cli/setup.js';
import { promptLine } from './term/prompt.js';
import { getUsage } from './shell/usage.js';
import { runLocalShell } from './app/local-shell.js';
import { runSshShell } from './app/ssh-shell.js';
import { launchLoop } from './app/picker.js';

function usage(): void {
  process.stdout.write(
    `\x1b[36mai\x1b[0m — 自带 shell 的 AI 终端（不依赖系统 cmd / powershell 的语法）\n\n` +
      `  ai                     选择连接（本地 / 远程主机），确认后进 shell\n` +
      `  ai --local             跳过选择，直接进本地内置 shell\n` +
      `  ai --ssh <别名>        跳过选择，直连保存过的 Ubuntu 主机\n` +
      `  ai setup               交互式配置引导（大模型 / 远程主机 / 启动方式）\n` +
      `  ai ssh ls              列出保存的连接\n` +
      `  ai ssh add             交互式添加一个连接\n` +
      `  ai ssh rm <别名>       删除连接\n` +
      `  ai ssh init            生成默认配置文件\n` +
      `  ai config example      生成可直接手动替换的配置模板\n\n` +
      `会话内：\n` +
      `  直接敲命令            内置 shell 执行（ls/cat/grep/du/df 等已内置）\n` +
      `  ai <自然语言>          交给 AI（前缀可在配置里改）\n` +
      `  Tab 补全 / ↑↓ 历史    补全按常用度排序；空输入按 Tab 直接列出常用命令\n` +
      `  Ctrl+C 中断 / Ctrl+D 退出\n`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // 兜底：无论从哪条路径退出，都把使用统计落盘（exit 事件里只能同步写，正好 save 是同步的）
  process.on('exit', () => getUsage().flush());

  if (argv.includes('-h') || argv.includes('--help') || argv[0] === 'help') {
    usage();
    return;
  }

  const cfg = loadConfig();

  if (argv[0] === 'ssh') {
    const sub = argv[1];
    if ((sub === 'use' || sub === 'connect') && argv[2]) {
      await runSshShell(cfg, argv[2]);
      return;
    }
    await handleSshCommand(argv.slice(1));
    return;
  }

  const sshIdx = argv.indexOf('--ssh');
  if (sshIdx >= 0) {
    const name = argv[sshIdx + 1];
    if (!name) {
      process.stderr.write('用法：ai --ssh <别名>\n');
      process.exitCode = 1;
      return;
    }
    await runSshShell(cfg, name);
    return;
  }

  if (argv[0] === 'setup' || argv[0] === 'wizard') {
    await runSetupWizard();
    return;
  }

  if (argv[0] === 'config' || argv[0] === 'init') {
    const sub = argv[1];
    if (sub === 'example' || sub === 'template') {
      const p = writeConfigExample();
      process.stdout.write(
        `已生成配置模板：${p}\n\n` +
          `手动替换的步骤：\n` +
          `  1. 打开模板，把 llm.apiKey 填成你的真实 Key（baseURL / 模型名按服务商改）\n` +
          `  2. 需要连服务器的话，填好 ssh.hosts 里的 host / username / password 或 privateKeyPath\n` +
          `  3. 覆盖到：${configPath()}\n` +
          `     （覆盖前会自动把原文件备份成 config.json.bak）\n\n` +
          `也可以直接运行 ai setup 跟着问答走，不用手改 JSON。\n`,
      );
      return;
    }
    const p = writeDefaultConfig();
    process.stdout.write(`${fs.existsSync(p) ? '配置已存在' : '已生成配置'}：${p}\n`);
    if (!process.stdin.isTTY) return;
    const go = (await promptLine('现在进入配置引导（一步步问，可直接回车跳过）? [Y/n]: ')).trim().toLowerCase();
    if (go === '' || go === 'y') await runSetupWizard();
    return;
  }

  // 显式指定本地：跳过连接选择
  if (argv[0] === 'local' || argv.includes('--local')) {
    await runLocalShell(cfg);
    return;
  }

  // 默认：先选连接（本地 / 远程主机），确认之后再进 shell
  if (cfg.startup.mode === 'local') {
    await runLocalShell(cfg);
    return;
  }

  // 非交互场景（管道、脚本）没法选择，退回本地，保持可脚本化
  if (!process.stdin.isTTY) {
    await runLocalShell(cfg);
    return;
  }

  await launchLoop(cfg);
}

main().catch((e) => {
  process.stderr.write(`启动失败：${(e as Error).stack || (e as Error).message}\n`);
  process.exitCode = 1;
});
