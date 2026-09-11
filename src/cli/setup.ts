import fs from 'node:fs';
import path from 'node:path';
import { configPath, loadConfig, saveConfig, type AppConfig } from '../config.js';
import { addHostInteractive } from './hosts.js';
import { promptLine, type Asker } from '../term/prompt.js';
import { chat, makeClient, withTimeout } from '../core/llm.js';

const C = {
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
};

type ProviderPreset = {
  key: string;
  label: string;
  name: string;
  baseURL: string;
  classifyModel: string;
  chatModel: string;
  /** 该服务商是否需要 apiKey（本地 Ollama 随便填一个即可） */
  keyHint: string;
};

const PROVIDERS: ProviderPreset[] = [
  {
    key: '1',
    label: 'DeepSeek（推荐，国内直连）',
    name: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    classifyModel: 'deepseek-chat',
    chatModel: 'deepseek-chat',
    keyHint: 'sk- 开头，在 platform.deepseek.com 获取',
  },
  {
    key: '2',
    label: '阿里云通义千问 Qwen',
    name: 'qwen',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    classifyModel: 'qwen-turbo',
    chatModel: 'qwen-plus',
    keyHint: 'sk- 开头，在阿里云百炼控制台获取',
  },
  {
    key: '3',
    label: 'OpenAI',
    name: 'openai',
    baseURL: 'https://api.openai.com/v1',
    classifyModel: 'gpt-4o-mini',
    chatModel: 'gpt-4o',
    keyHint: 'sk- 开头；国内访问可能需要代理',
  },
  {
    key: '4',
    label: '本地 Ollama',
    name: 'ollama',
    baseURL: 'http://localhost:11434/v1',
    classifyModel: 'qwen2.5:7b',
    chatModel: 'qwen2.5:14b',
    keyHint: '本地服务不校验，直接回车即可（会填成 ollama）',
  },
  {
    key: '5',
    label: '自定义 / 其它 OpenAI 兼容服务',
    name: 'custom',
    baseURL: '',
    classifyModel: '',
    chatModel: '',
    keyHint: '按服务商文档填写',
  },
];

export type SetupOptions = {
  /** 注入提问函数（测试用） */
  ask?: Asker;
  /** 起始配置，默认从磁盘读 */
  cfg?: AppConfig;
  /** 落盘方式，默认「备份 + 覆盖写 config.json」 */
  persist?: (cfg: AppConfig) => void;
  /** 输出方式，默认 stdout */
  out?: (s: string) => void;
  /** 只计算不落盘（测试用） */
  dryRun?: boolean;
};

export type SetupResult = { cfg: AppConfig; changed: string[] };

const askDefault: Asker = (q, hidden) => promptLine(q, hidden);

function defaultPersist(cfg: AppConfig): void {
  saveConfig(cfg);
}

/** 打码显示已保存的 key，只露头尾，避免旁观泄露 */
function maskKey(k: string): string {
  if (!k) return '(空)';
  if (k.length <= 10) return k[0] + '*'.repeat(Math.max(0, k.length - 1));
  return `${k.slice(0, 6)}${'*'.repeat(6)}${k.slice(-4)}`;
}

/**
 * 带默认值的提问：
 * - 回车 = 保留当前值
 * - 输入 `-` = 清空（仅当 allowClear）
 * 已有值时会把当前值写在提示里，方便「手动替换」而不是重新填一遍。
 */
async function askWithDefault(
  ask: Asker,
  label: string,
  current: string,
  opts: { hidden?: boolean; allowClear?: boolean; isSecret?: boolean; fallback?: string } = {},
): Promise<string> {
  const shown = opts.isSecret ? maskKey(current) : current || '(空)';
  const clearHint = opts.allowClear ? '，输入 - 清空' : '';
  const q = `  ${label} [当前 ${shown}，回车保留${clearHint}]: `;
  const ans = (await ask(q, opts.hidden)).trim();
  if (ans === '') return current || opts.fallback || '';
  if (ans === '-' && opts.allowClear) return '';
  return ans;
}

function statusBlock(cfg: AppConfig): string {
  const llmOk = Boolean(cfg.llm.apiKey);
  const llmLine = llmOk
    ? `${C.green}🟢 已配置${C.reset}  ${cfg.llm.name} · ${cfg.llm.chatModel} · ${maskKey(cfg.llm.apiKey)}`
    : `${C.red}🔴 未配置${C.reset}  ${C.dim}（AI 说人话的功能不可用，只当 shell 用没问题）${C.reset}`;

  const n = cfg.ssh.hosts.length;
  const hostLine = n
    ? `${C.green}🟢 ${n} 台${C.reset}  ${C.dim}${cfg.ssh.hosts
        .slice(0, 4)
        .map((h) => `${h.name}(${h.username}@${h.host})`)
        .join('、')}${n > 4 ? ' …' : ''}${C.reset}`
    : `${C.yellow}🟡 0 台${C.reset}  ${C.dim}（只能连本地）${C.reset}`;

  const startupLine = `${cfg.startup.mode === 'picker' ? '先选连接' : '直接进本地 shell'} · ${
    cfg.startup.returnToPicker ? '会话结束回到列表' : '会话结束即退出'
  }`;
  const agentLine = `${cfg.agent.maxRounds} 轮迭代 · ${cfg.agent.retries} 次重试 · 超时 ${Math.round(
    cfg.agent.timeoutMs / 1000,
  )}s · 手敲危险命令${cfg.safety.confirmManual ? '会' : '不会'}确认`;

  return (
    `  ${C.bold}大模型${C.reset}    ${llmLine}\r\n` +
    `  ${C.bold}远程主机${C.reset}  ${hostLine}\r\n` +
    `  ${C.bold}启动方式${C.reset}  ${startupLine}\r\n` +
    `  ${C.bold}AI 策略${C.reset}   ${agentLine}\r\n`
  );
}

/** 未配置时的引导性提示，给选择界面 / 首次启动复用 */
export function setupHint(cfg: AppConfig): string | null {
  const missing: string[] = [];
  if (!cfg.llm.apiKey) missing.push('大模型 API Key（AI 说人话的功能）');
  if (!cfg.ssh.hosts.length) missing.push('远程主机（要连服务器才需要）');
  if (!missing.length) return null;
  return (
    `${C.yellow}⚠ 还没配置：${missing.join('、')}${C.reset}\r\n` +
    `${C.dim}  按 ${C.reset}${C.bold}c${C.reset}${C.dim} 进入配置引导（一步步问，回车保留原值），也可以随时运行 ${C.reset}${C.bold}ai setup${C.reset}\r\n`
  );
}

async function testLlm(cfg: AppConfig): Promise<{ ok: boolean; msg: string }> {
  try {
    const client = makeClient(cfg);
    const out = await withTimeout(
      chat(
        client,
        cfg.llm.chatModel,
        [{ role: 'user', content: '回复两个字：可用' }],
        { temperature: 0, maxTokens: 8 },
      ),
      15000,
    );
    return { ok: true, msg: out || '(空响应)' };
  } catch (e) {
    const m = (e as Error).message || String(e);
    return { ok: false, msg: /LLM_TIMEOUT/.test(m) ? '超时（15s）' : m };
  }
}

function diffList(before: AppConfig, after: AppConfig): string[] {
  const changed: string[] = [];
  if (before.llm.name !== after.llm.name) changed.push(`llm.name: ${before.llm.name} → ${after.llm.name}`);
  if (before.llm.baseURL !== after.llm.baseURL) changed.push(`llm.baseURL: ${before.llm.baseURL} → ${after.llm.baseURL}`);
  if (before.llm.apiKey !== after.llm.apiKey) changed.push(`llm.apiKey: ${maskKey(before.llm.apiKey)} → ${maskKey(after.llm.apiKey)}`);
  if (before.llm.classifyModel !== after.llm.classifyModel)
    changed.push(`llm.classifyModel: ${before.llm.classifyModel} → ${after.llm.classifyModel}`);
  if (before.llm.chatModel !== after.llm.chatModel) changed.push(`llm.chatModel: ${before.llm.chatModel} → ${after.llm.chatModel}`);
  if (before.ssh.hosts.length !== after.ssh.hosts.length)
    changed.push(`ssh.hosts: ${before.ssh.hosts.length} 台 → ${after.ssh.hosts.length} 台`);
  if (before.startup.mode !== after.startup.mode) changed.push(`startup.mode: ${before.startup.mode} → ${after.startup.mode}`);
  if (before.startup.returnToPicker !== after.startup.returnToPicker)
    changed.push(`startup.returnToPicker: ${before.startup.returnToPicker} → ${after.startup.returnToPicker}`);
  if (before.agent.maxRounds !== after.agent.maxRounds)
    changed.push(`agent.maxRounds: ${before.agent.maxRounds} → ${after.agent.maxRounds}`);
  if (before.agent.retries !== after.agent.retries)
    changed.push(`agent.retries: ${before.agent.retries} → ${after.agent.retries}`);
  if (before.safety.confirmManual !== after.safety.confirmManual)
    changed.push(`safety.confirmManual: ${before.safety.confirmManual} → ${after.safety.confirmManual}`);
  return changed;
}

/**
 * 交互式配置引导：三段（大模型 / 远程主机 / 启动方式）。
 * 每问一项都显示当前值，回车即保留，可随时回车跳过整段。
 */
export async function runSetupWizard(opts: SetupOptions = {}): Promise<SetupResult> {
  const ask = opts.ask ?? askDefault;
  const write = opts.out ?? ((s: string) => void process.stdout.write(s));
  const cfg: AppConfig = opts.cfg ?? loadConfig();
  const before = JSON.parse(JSON.stringify(cfg)) as AppConfig;
  const persist = opts.dryRun ? () => {} : (opts.persist ?? defaultPersist);

  write(
    `\r\n${C.cyan}${C.bold}MonoShell 配置引导${C.reset}\r\n` +
      `${C.dim}回车 = 保留当前值并跳到下一项；输入 - 可清空某项；整段直接回车 = 跳过。${C.reset}\r\n\r\n` +
      `当前状态 ${C.dim}(${configPath()})${C.reset}\r\n` +
      statusBlock(cfg),
  );

  // ── 第 1 段：大模型 ────────────────────────────────────────────
  write(`\r\n${C.bold}第 1 段 / 4 · 大模型${C.reset}\r\n`);
  for (const p of PROVIDERS) write(`  [${p.key}] ${p.label}\r\n`);
  const pick = (await ask(`  选择服务商 [1-5，回车跳过这一段，保持当前 ${C.green}${cfg.llm.name}${C.reset}]: `)).trim();

  if (pick) {
    const preset = PROVIDERS.find((p) => p.key === pick);
    if (!preset) {
      write(`  ${C.yellow}没看懂「${pick}」，这一段跳过。${C.reset}\r\n`);
    } else {
      const switching = preset.name !== cfg.llm.name;
      cfg.llm.name = preset.name;

      // 换服务商时，baseURL / 模型名默认跟着预设走；同服务商则保留用户改过的值
      const defBase = switching ? preset.baseURL : cfg.llm.baseURL || preset.baseURL;
      const defClassify = switching ? preset.classifyModel : cfg.llm.classifyModel || preset.classifyModel;
      const defChat = switching ? preset.chatModel : cfg.llm.chatModel || preset.chatModel;

      cfg.llm.baseURL = await askWithDefault(ask, '接口地址 baseURL', defBase);
      write(`  ${C.dim}${preset.keyHint}${C.reset}\r\n`);
      cfg.llm.apiKey = await askWithDefault(ask, 'API Key', switching ? '' : cfg.llm.apiKey, {
        hidden: true,
        isSecret: true,
        allowClear: true,
        fallback: preset.name === 'ollama' ? 'ollama' : '',
      });
      cfg.llm.classifyModel = await askWithDefault(ask, '判定用小模型（求快）', defClassify);
      cfg.llm.chatModel = await askWithDefault(ask, '生成用大模型（求准）', defChat);

      if (cfg.llm.apiKey) {
        const go = (await ask('  现在测一下能不能连通? [Y/n]: ')).trim().toLowerCase();
        if (go === '' || go === 'y') {
          write(`  ${C.dim}正在请求 ${cfg.llm.chatModel} …${C.reset}\r\n`);
          const r = await testLlm(cfg);
          write(
            r.ok
              ? `  ${C.green}✓ 连通正常${C.reset} ${C.dim}模型返回：${r.msg}${C.reset}\r\n`
              : `  ${C.red}✗ 连接失败${C.reset} ${C.dim}${r.msg}${C.reset}\r\n` +
                  `  ${C.dim}配置照样会保存，稍后可以重跑 ai setup 再试。${C.reset}\r\n`,
          );
        }
      } else {
        write(`  ${C.yellow}API Key 为空，AI 功能仍不可用。${C.reset}\r\n`);
      }
    }
  } else {
    write(`  ${C.dim}已跳过（保持 ${cfg.llm.name} / ${cfg.llm.chatModel}）。${C.reset}\r\n`);
  }

  // ── 第 2 段：远程主机 ──────────────────────────────────────────
  write(`\r\n${C.bold}第 2 段 / 4 · 远程主机${C.reset}\r\n`);
  if (cfg.ssh.hosts.length) {
    cfg.ssh.hosts.forEach((h, i) => {
      const auth = h.privateKeyPath ? '私钥' : h.password ? '密码' : '登录时输入';
      write(
        `  [${i + 1}] ${C.green}${h.name}${C.reset}  ${h.username}@${h.host}:${h.port ?? 22}  ${C.dim}${auth}${
          h.comment ? ` # ${h.comment}` : ''
        }${C.reset}\r\n`,
      );
    });
  } else {
    write(`  ${C.dim}还没有远程主机。${C.reset}\r\n`);
  }
  for (;;) {
    const a = (await ask(`  主机管理：${C.bold}a${C.reset} 新增一台   ${C.bold}d${C.reset} 删除   ${C.bold}回车${C.reset} 完成这一段: `)).trim().toLowerCase();
    if (a === '') break;
    if (a === 'a' || a === 'add' || a === 'new') {
      await addHostInteractive(cfg);
      continue;
    }
    if (a === 'd' || a === 'del' || a === 'rm') {
      const t = (await ask('    删除哪一台（序号或别名，回车取消）: ')).trim();
      if (!t) continue;
      const target = /^\d+$/.test(t)
        ? cfg.ssh.hosts[Number(t) - 1]
        : cfg.ssh.hosts.find((h) => h.name === t);
      if (!target) {
        write(`    ${C.yellow}没有找到 ${t}${C.reset}\r\n`);
        continue;
      }
      const ok = (await ask(`    确认删除 ${target.name}? [y/N]: `)).trim().toLowerCase();
      if (ok === 'y') {
        cfg.ssh.hosts = cfg.ssh.hosts.filter((h) => h.name !== target.name);
        write(`    ${C.green}已删除 ${target.name}${C.reset}\r\n`);
      } else {
        write(`    ${C.dim}已取消。${C.reset}\r\n`);
      }
      continue;
    }
    write(`  ${C.dim}未识别的操作，输入 a / d，或回车完成。${C.reset}\r\n`);
  }

  // ── 第 3 段：启动方式 ──────────────────────────────────────────
  write(`\r\n${C.bold}第 3 段 / 4 · 启动方式${C.reset}\r\n`);
  write(`  [1] 启动后先选连接（本地 / 远程主机）  ${C.dim}← 当前${cfg.startup.mode === 'picker' ? '' : '（未选）'}${C.reset}\r\n`);
  write(`  [2] 启动后直接进本地内置 shell\r\n`);
  const sm = (await ask(`  选择 [1-2，回车保留 ${cfg.startup.mode === 'picker' ? '1' : '2'}]: `)).trim();
  if (sm === '1') cfg.startup.mode = 'picker';
  else if (sm === '2') cfg.startup.mode = 'local';

  const ret = (await ask(`  某次会话结束后是否回到连接列表? [Y/n，回车保留当前 ${cfg.startup.returnToPicker ? '是' : '否'}]: `))
    .trim()
    .toLowerCase();
  if (ret === 'y') cfg.startup.returnToPicker = true;
  else if (ret === 'n') cfg.startup.returnToPicker = false;

  // ── 第 4 段：AI 执行策略 ───────────────────────────────────────
  write(`\r\n${C.bold}第 4 段 / 4 · AI 执行策略${C.reset}\r\n`);
  write(`  ${C.dim}迭代轮数 = AI 反复「规划→执行→看输出」的次数上限；轮数越多越能自己排完，也越费 token。${C.reset}\r\n`);
  const roundsAns = (await ask(`  最多迭代轮数 [1-20，回车保留 ${cfg.agent.maxRounds}]: `)).trim();
  if (/^\d+$/.test(roundsAns)) {
    const v = Math.min(20, Math.max(1, Number(roundsAns)));
    cfg.agent.maxRounds = v;
  } else if (roundsAns) {
    write(`  ${C.yellow}不是有效数字，保留 ${cfg.agent.maxRounds}。${C.reset}\r\n`);
  }

  write(`  ${C.dim}重试 = 单轮模型调用失败（网络抖动 / 限流）后自动再试几次。${C.reset}\r\n`);
  const retryAns = (await ask(`  模型调用重试次数 [0-10，回车保留 ${cfg.agent.retries}]: `)).trim();
  if (/^\d+$/.test(retryAns)) {
    cfg.agent.retries = Math.min(10, Number(retryAns));
  } else if (retryAns) {
    write(`  ${C.yellow}不是有效数字，保留 ${cfg.agent.retries}。${C.reset}\r\n`);
  }

  const manualAns = (
    await ask(`  手敲的危险命令也要确认吗? [y/N，回车保留当前 ${cfg.safety.confirmManual ? '要' : '不要'}]: `)
  )
    .trim()
    .toLowerCase();
  if (manualAns === 'y') cfg.safety.confirmManual = true;
  else if (manualAns === 'n') cfg.safety.confirmManual = false;

  // ── 落盘 ──────────────────────────────────────────────────────
  const changed = diffList(before, cfg);
  persist(cfg);

  write(`\r\n${C.cyan}${C.bold}完成${C.reset}\r\n`);
  if (changed.length) {
    write(`  ${C.dim}写回 ${configPath()}（原文件已备份为 config.json.bak）${C.reset}\r\n`);
    for (const c of changed) write(`  ${C.green}·${C.reset} ${c}\r\n`);
  } else {
    write(`  ${C.dim}没有改动，未写盘。${C.reset}\r\n`);
  }
  if (!cfg.llm.apiKey) {
    write(`  ${C.yellow}提醒：大模型仍未配置，AI 功能不可用。随时运行 ai setup 补上。${C.reset}\r\n`);
  }

  return { cfg, changed };
}

/**
 * 生成一份「可直接替换」的完整配置模板，方便用户手改或在别的机器上重新填。
 * 写到 ~/.ai-shell/config.example.json。
 */
export function writeConfigExample(): string {
  const p = path.join(path.dirname(configPath()), 'config.example.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const cfg = loadConfig();
  // 敏感字段不落明文示例，用占位符
  const example: AppConfig = {
    ...cfg,
    llm: { ...cfg.llm, apiKey: cfg.llm.apiKey ? 'sk-在这里填你的-key' : '' },
    ssh: {
      hosts: cfg.ssh.hosts.map((h) => ({
        ...h,
        password: h.password ? '在这里填你的密码' : undefined,
      })),
    },
  };
  fs.writeFileSync(p, JSON.stringify(example, null, 2), 'utf8');
  return p;
}
