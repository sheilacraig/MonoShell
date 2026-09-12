import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type LlmProvider = {
  name: string;
  apiKey: string;
  baseURL: string;
  /** 分类用小模型，追求快；生成用大模型，追求准。可以填同一个。 */
  classifyModel: string;
  chatModel: string;
};

export type SshHost = {
  /** 连接别名，ai ssh <name> 直接用 */
  name: string;
  host: string;
  port?: number;
  username: string;
  /** 明文保存在配置里（文件权限 600）。更推荐用私钥 */
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /** 登录后自动执行的命令，比如 sudo su - 或 cd /data */
  startup?: string[];
  /** 备注，比如「生产 web-01」 */
  comment?: string;
};

/**
 * 触发方式：
 * - prefix（默认）：只有以指定前缀开头才交给 AI，其余全部透传给 shell，零延迟零误判
 * - smart：每条输入都判定（本地启发式优先，拿不准才问 LLM）
 * - hybrid：前缀也认，非前缀也做智能判定
 */
export type TriggerMode = 'prefix' | 'smart' | 'hybrid';

/** AI 执行策略：迭代轮数 / 失败重试 / 单次调用超时 */
export type AgentConfig = {
  /** 单次任务最多迭代轮数：AI「规划 → 执行 → 看输出 → 再规划」的上限，默认 5 */
  maxRounds: number;
  /** 单轮模型调用失败后的额外重试次数（0 = 不重试），网络抖动靠它兜 */
  retries: number;
  /** 单轮模型调用超时（毫秒） */
  timeoutMs: number;
};

export type AppConfig = {
  /** AI 执行策略（迭代轮数 / 重试 / 超时） */
  agent: AgentConfig;
  /**
   * 启动行为。
   * - picker（默认）：先进入连接选择（内置的「本地」+ 已保存的远程主机），
   *   选中并确认后才打开 shell。日常运维面向的是远程主机，本地只是其中一个选项。
   * - local：跳过选择，直接进入本地内置 shell（旧行为）。
   */
  startup: {
    mode: 'picker' | 'local';
    /** picker 模式下，某次会话结束后是否回到连接选择界面 */
    returnToPicker: boolean;
  };
  llm: LlmProvider;
  shell: {
    /** local 模式使用的 shell，留空则自动探测 */
    program: string;
    args: string[];
    env: Record<string, string>;
  };
  ssh: {
    hosts: SshHost[];
  };
  trigger: {
    mode: TriggerMode;
    /** 可自定义，默认 ai / ? / ？。匹配时对整行去左空白后判断 */
    prefixes: string[];
    /** 命令报 command not found 时自动交 AI 接管 */
    fallbackOnNotFound: boolean;
  };
  safety: {
    /** 命中即拦截并二次确认的正则，注意 Windows 下 cmd/pwsh 也覆盖 */
    dangerous: string[];
    /** 命中则永不询问，直接放行 */
    allowlist: string[];
    /** 分类判定超时后乐观放行的毫秒数 */
    classifyTimeoutMs: number;
    /** 输入停顿多久后投机预取分类结果 */
    prefetchDebounceMs: number;
    /**
     * @deprecated 已迁移到 agent.maxRounds。
     * 仅为兼容老配置保留：若 agent.maxRounds 未显式配置，会读这里的值。
     */
    maxRounds?: number;
    /**
     * 用户**手敲**的危险命令是否也要二次确认。
     * AI 生成的命令无论如何都会确认；这一项只管手动输入。
     * 手敲时只按高危黑名单判定（rm -rf / mkfs / systemctl stop 等），
     * 不会因为 `echo x > f` 这类日常写文件而反复打扰。
     */
    confirmManual: boolean;
  };
  ui: {
    /** AI 说明行的前缀，用注释风格保持单窗口观感 */
    notePrefix: string;
    /** AI 生成的命令是否打字机式回显（0 表示瞬间填入） */
    typeSpeedMs: number;
  };
};

const DEFAULT_DANGEROUS: string[] = [
  '\\brm\\s+(-[a-zA-Z]*f[a-zA-Z]*|-rf)\\b',
  '\\brm\\s+-[a-zA-Z]*r[a-zA-Z]*\\s+/\\s*$',
  '\\bmkfs\\b',
  '\\bdd\\s+if=',
  ':\\(\\)\\{',
  '\\bshutdown\\b',
  '\\breboot\\b',
  '\\bpoweroff\\b',
  '\\binit\\s+[06]\\b',
  '\\bchmod\\s+(-R\\s+)?777\\b',
  '\\bchown\\s+-R\\b',
  '\\bgit\\s+push\\s+.*(-f|--force)\\b',
  '\\bgit\\s+reset\\s+--hard\\b',
  '\\bgit\\s+clean\\s+-[a-zA-Z]*f',
  '\\bkill\\s+-9\\s+1\\b',
  '\\bpkill\\b',
  '\\bsystemctl\\s+(stop|disable|restart)\\b',
  '\\bservice\\s+\\S+\\s+(stop|restart)\\b',
  '>\\s*/dev/sd',
  '\\bcurl\\b[^|]*\\|\\s*(ba)?sh\\b',
  '\\bwget\\b[^|]*\\|\\s*(ba)?sh\\b',
  '\\b(format|del|rd)\\s+/[sq]\\b',
  '\\bRemove-Item\\b.*-(Recurse|Force)',
  '\\bStop-Computer\\b',
  '\\bRestart-Computer\\b',
  '\\bClear-Disk\\b',
  '\\bSet-ExecutionPolicy\\b',
  '\\bdrop\\s+(database|table)\\b',
  '\\btruncate\\s+table\\b',
  '\\bdelete\\s+from\\b.*\\bwhere\\b',
];

const DEFAULT_ALLOWLIST: string[] = [
  '^\\s*(ls|ll|la|pwd|cd|cat|head|tail|less|more|echo|which|whoami|date|uname|hostname)\\b',
  '^\\s*(df|du|free|uptime|top|htop|ps|netstat|ss|ip|ifconfig|ping|curl|wget)\\b',
  '^\\s*(git\\s+(status|log|diff|branch|show|remote)\\b)',
  '^\\s*(docker\\s+(ps|images|logs|stats|inspect)\\b)',
  '^\\s*(kubectl\\s+(get|describe|logs)\\b)',
  '^\\s*(systemctl\\s+status\\b)',
  '^\\s*(journalctl|dmesg)\\b',
  '^\\s*(find|grep|rg|awk|sed\\s+-n)\\b',
  '^\\s*(npm|pnpm|yarn|go|mvn|gradle)\\s+(run\\s+)?(test|build|--version|-v)\\b',
];

function detectShell(): { program: string; args: string[] } {
  if (process.platform === 'win32') {
    // 优先 pwsh（支持 OSC 133 注入），退回 powershell，再退回 cmd
    const candidates = ['pwsh.exe', 'powershell.exe', 'cmd.exe'];
    for (const c of candidates) {
      if (hasOnPath(c)) return { program: c, args: c === 'cmd.exe' ? [] : ['-NoLogo'] };
    }
    return { program: 'cmd.exe', args: [] };
  }
  const shell = process.env.SHELL || '/bin/bash';
  return { program: shell, args: [] };
}

function hasOnPath(bin: string): boolean {
  const paths = (process.env.PATH || '').split(path.delimiter);
  for (const p of paths) {
    try {
      if (fs.existsSync(path.join(p, bin))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export function defaultConfig(): AppConfig {
  const s = detectShell();
  return {
    agent: { maxRounds: 5, retries: 2, timeoutMs: 50_000 },
    startup: { mode: 'picker', returnToPicker: true },
    llm: {
      name: 'openai',
      apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '',
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      classifyModel: process.env.LLM_CLASSIFY_MODEL || 'gpt-4o-mini',
      chatModel: process.env.LLM_CHAT_MODEL || 'gpt-4o',
    },
    shell: { program: s.program, args: s.args, env: {} },
    ssh: { hosts: [] },
    trigger: {
      mode: 'prefix',
      prefixes: ['ai ', 'ai:', '?', '？'],
      fallbackOnNotFound: true,
    },
    safety: {
      dangerous: DEFAULT_DANGEROUS,
      allowlist: DEFAULT_ALLOWLIST,
      classifyTimeoutMs: 800,
      prefetchDebounceMs: 400,
      confirmManual: true,
    },
    // notePrefix 用中点，不要用组合字符（U+20F0 会叠在前一个字符上，显示成乱码）
    ui: { notePrefix: '· ', typeSpeedMs: 18 },
  };
}

export function configPath(): string {
  return path.join(os.homedir(), '.ai-shell', 'config.json');
}

/**
 * 把磁盘上的原始配置合并到默认配置之上（纯函数，便于单测）。
 * 老配置里 AI 轮数写在 safety.maxRounds，这里做一次平滑迁移。
 */
export function mergeConfig(raw: Partial<AppConfig>, base: AppConfig = defaultConfig()): AppConfig {
  const rawAgent = (raw.agent || {}) as Partial<AgentConfig>;
  const legacyRounds = raw.safety?.maxRounds;
  const agent: AgentConfig = {
    ...base.agent,
    ...rawAgent,
    ...(rawAgent.maxRounds === undefined && typeof legacyRounds === 'number'
      ? { maxRounds: legacyRounds }
      : {}),
  };
  return {
    agent,
    startup: { ...base.startup, ...(raw.startup || {}) },
    llm: { ...base.llm, ...(raw.llm || {}) },
    shell: { ...base.shell, ...(raw.shell || {}) },
    ssh: { hosts: raw.ssh?.hosts ?? base.ssh.hosts },
    trigger: { ...base.trigger, ...(raw.trigger || {}) },
    safety: { ...base.safety, ...(raw.safety || {}) },
    ui: { ...base.ui, ...(raw.ui || {}) },
  };
}

export function loadConfig(): AppConfig {
  const p = configPath();
  const cfg = defaultConfig();
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<AppConfig>;
      return mergeConfig(raw, cfg);
    } catch (e) {
      process.stderr.write(`配置文件解析失败，使用默认配置: ${(e as Error).message}\n`);
    }
  }
  return cfg;
}

/**
 * 写出默认配置（已存在则原样不动）。
 *
 * 必须把「这次是不是真的创建了」带回去：函数内部一定会保证文件存在，
 * 调用方再拿 fs.existsSync 判断，全新安装也会被判成「配置已存在」。
 */
export function writeDefaultConfig(): { path: string; created: boolean } {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const created = !fs.existsSync(p);
  if (created) {
    fs.writeFileSync(p, JSON.stringify(defaultConfig(), null, 2), 'utf8');
  }
  return { path: p, created };
}

/** 写回配置。落盘前先备份一份 .bak，避免手改/向导改错后无法回退 */
export function saveConfig(cfg: AppConfig): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) {
    try {
      fs.copyFileSync(p, p + '.bak');
    } catch {
      /* 备份失败不阻塞写入 */
    }
  }
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* Windows 无 chmod，忽略 */
  }
}
