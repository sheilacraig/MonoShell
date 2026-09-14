import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { chat, makeClient, withTimeout, type ChatMsg } from './llm.js';

export type Verdict = 'CMD' | 'NL';
export type ClassifySource = 'heuristic' | 'llm' | 'cache' | 'timeout' | 'prefix';

export type ClassifyResult = { verdict: Verdict; source: ClassifySource };

const NL_HINTS = [
  '帮我',
  '请问',
  '怎么',
  '如何',
  '为什么',
  '查一下',
  '看一下',
  '看看',
  '告诉我',
  '有没有',
  '能不能',
  '我想',
  '帮我看',
  '分析',
  '排查',
  '原因',
  'how do i',
  'how to',
  'why is',
  'what is',
  'show me',
  'find out',
  'please',
  'can you',
];

const BUILTINS = new Set([
  'cd', 'ls', 'll', 'la', 'pwd', 'echo', 'cat', 'head', 'tail', 'less', 'more', 'cp', 'mv',
  'rm', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'ln', 'find', 'grep', 'egrep', 'rg', 'ag',
  'sed', 'awk', 'sort', 'uniq', 'wc', 'cut', 'tr', 'xargs', 'tar', 'zip', 'unzip', 'gzip',
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'git', 'svn', 'docker', 'docker-compose', 'kubectl',
  'helm', 'terraform', 'ansible', 'npm', 'pnpm', 'yarn', 'npx', 'node', 'deno', 'bun', 'python',
  'python3', 'pip', 'pip3', 'go', 'java', 'mvn', 'gradle', 'cargo', 'ruby', 'gem', 'php',
  'apt', 'apt-get', 'yum', 'dnf', 'brew', 'pacman', 'systemctl', 'service', 'journalctl',
  'ps', 'top', 'htop', 'kill', 'jobs', 'fg', 'bg', 'df', 'du', 'free', 'uptime', 'uname',
  'which', 'whereis', 'man', 'env', 'export', 'source', 'alias', 'unalias', 'history', 'clear',
  'exit', 'sudo', 'su', 'crontab', 'date', 'whoami', 'hostname', 'id', 'stat', 'file', 'diff',
  'vim', 'vi', 'nano', 'code', 'make', 'cmake', 'gcc', 'g++', 'tcpdump', 'netstat', 'ss', 'ip',
  'ping', 'traceroute', 'dig', 'nslookup', 'openssl', 'base64', 'jq', 'yq', 'watch', 'tree',
  'dir', 'type', 'copy', 'move', 'del', 'cls', 'set', 'ipconfig', 'tasklist', 'taskkill',
  'powershell', 'pwsh', 'where', 'findstr', 'choco', 'winget', 'wsl', 'bash', 'zsh', 'sh',
]);

let pathCache: Set<string> | null = null;
let pathCachePromise: Promise<Set<string>> | null = null;

/** 后台扫描 PATH 下的可执行文件，供启发式快判使用（只扫一次） */
function ensurePathCache(): Promise<Set<string>> {
  if (pathCache) return Promise.resolve(pathCache);
  if (pathCachePromise) return pathCachePromise;
  pathCachePromise = (async () => {
    const s = new Set<string>();
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1'] : [''];
    for (const dir of dirs) {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile()) continue;
          const lower = e.name.toLowerCase();
          for (const ext of exts) {
            if (ext === '') {
              s.add(e.name);
            } else if (lower.endsWith(ext)) {
              s.add(e.name.slice(0, -ext.length).toLowerCase());
            }
          }
        }
      } catch {
        /* 目录不可读，跳过 */
      }
    }
    pathCache = s;
    return s;
  })();
  return pathCachePromise;
}

const CJK = /[\u4e00-\u9fa5]/;

/**
 * 本地启发式快判：毫秒级、零网络。
 * 返回 null 表示「拿不准」，需要交给 LLM。
 */
/** ai 程序自身的 CLI 子命令/参数白名单（这些作为命令直接透传给 shell，不交给 AI） */
export const AI_CLI_SUBCOMMANDS: readonly string[] = [
  'ssh',
  'init',
  'config',
  'setup',
  'wizard',
  '--local',
  '--ssh',
  '--help',
  '-h',
  'help',
  'local',
];

export function heuristic(line: string, pathSet: Set<string> | null): Verdict | null {
  const t = line.trim();
  if (!t) return 'CMD';
  const lower = t.toLowerCase();

  // 显式前缀：一定走 AI。但 `ai ssh ...` / `ai --local` 等是 ai 自己的子命令，
  // 用户是想调用 ai 这个程序，不是让它当 AI 干活，必须放行为 CMD 交给 shell。
  const aiMatch = /^(ai|AI|Ai)\s+(.*)$/.exec(t);
  if (aiMatch) {
    const first = aiMatch[2].trim().split(/\s+/)[0].toLowerCase();
    if (!AI_CLI_SUBCOMMANDS.includes(first)) return 'NL';
  } else {
    if (t.startsWith('?') || t.startsWith('？') || t.startsWith('/ai ')) return 'NL';
  }

  const first = t.split(/\s+/)[0];
  const firstLower = first.toLowerCase();

  // 中文 + 不像命令 = 自然语言；但允许 `cd 桌面` 这类
  if (CJK.test(t)) {
    const looksLikeCmd = BUILTINS.has(firstLower) || (pathSet ? pathSet.has(firstLower) : false);
    if (!looksLikeCmd) return 'NL';
    // 首个词是命令，但整句明显是提问
    if (/[？?]/.test(t) || NL_HINTS.some((h) => t.includes(h))) return 'NL';
    return 'CMD';
  }

  // 明显的自然语言信号
  if (/[？?]\s*$/.test(t) && !/^[^\s]*[?*]/.test(t)) return 'NL';
  if (NL_HINTS.some((h) => lower.startsWith(h))) return 'NL';

  // 首 token 是已知命令 / PATH 可执行 → 命令
  if (BUILTINS.has(firstLower)) return 'CMD';
  if (pathSet && pathSet.has(firstLower)) return 'CMD';
  if (pathSet && pathSet.has(first)) return 'CMD';

  // 形如 ./xxx、/usr/bin/xxx、~/xxx
  if (/^[./~\\]/.test(first) || first.includes('/') || first.includes('\\')) return 'CMD';

  // 含典型 shell 语法
  if (/[|&;><$`]/.test(t) || /\$\(/.test(t) || /--?[a-zA-Z]/.test(t)) return 'CMD';

  return null;
}

const CLASSIFY_SYS: ChatMsg = {
  role: 'system',
  content:
    '判断用户输入的一行文本是「shell 命令」还是「自然语言请求」。' +
    '只回答一个英文单词：CMD 表示它是可直接执行的 shell 命令或命令片段，NL 表示它是给人看的自然语言。' +
    '不要解释，不要标点。',
};

export class Classifier {
  private cache = new Map<string, Verdict>();
  private inflight = new Map<string, Promise<Verdict>>();
  private pathSet: Set<string> | null = null;
  private client: ReturnType<typeof makeClient>;

  constructor(
    private cfg: AppConfig,
    private sessionLabel: string,
  ) {
    this.client = makeClient(cfg);
    void ensurePathCache().then((s) => {
      this.pathSet = s;
    });
  }

  /** 投机预取：用户打字停顿时就偷偷分类好，回车时直接命中缓存 */
  prefetch(line: string): void {
    const t = line.trim();
    if (!t || this.cache.has(t) || this.inflight.has(t)) return;
    const h = heuristic(t, this.pathSet);
    if (h) {
      this.cache.set(t, h);
      return;
    }
    const p = this.askLlm(t).then((v) => {
      this.cache.set(t, v);
      this.inflight.delete(t);
      return v;
    }).catch(() => {
      this.inflight.delete(t);
      return 'CMD' as Verdict;
    });
    this.inflight.set(t, p);
  }

  private async askLlm(line: string): Promise<Verdict> {
    const out = await withTimeout(
      chat(
        this.client,
        this.cfg.llm.classifyModel,
        [
          CLASSIFY_SYS,
          { role: 'user', content: `当前 shell 环境：${this.sessionLabel}\n输入：${line}` },
        ],
        { temperature: 0, maxTokens: 4 },
      ),
      this.cfg.safety.classifyTimeoutMs,
    );
    return /NL/i.test(out) ? 'NL' : 'CMD';
  }

  /**
   * 判定一行输入。策略：
   * 1) 启发式能定就直接定（零延迟）
   * 2) 查预取缓存
   * 3) 真要等也只等 classifyTimeoutMs，超时乐观放行（后面若 command not found 会兜底接管）
   */
  async classify(line: string): Promise<ClassifyResult> {
    const t = line.trim();
    if (!t) return { verdict: 'CMD', source: 'heuristic' };

    const h = heuristic(t, this.pathSet);
    if (h) return { verdict: h, source: /^(ai|AI)\s/.test(t) || t.startsWith('?') ? 'prefix' : 'heuristic' };

    if (this.cache.has(t)) return { verdict: this.cache.get(t)!, source: 'cache' };
    if (this.inflight.has(t)) {
      try {
        const v = await withTimeout(this.inflight.get(t)!, this.cfg.safety.classifyTimeoutMs);
        return { verdict: v, source: 'cache' };
      } catch {
        return { verdict: 'CMD', source: 'timeout' };
      }
    }

    try {
      const v = await this.askLlm(t);
      this.cache.set(t, v);
      return { verdict: v, source: 'llm' };
    } catch {
      return { verdict: 'CMD', source: 'timeout' };
    }
  }
}

/** 命令执行失败时的兜底接管判定：这几种报错说明用户其实在说人话 */
export function looksLikeNotFound(output: string, line: string): boolean {
  const o = output.toLowerCase();
  return (
    /未找到命令/.test(output) ||
    /不是内置命令/.test(output) ||
    /command not found/.test(o) ||
    /unknown command/.test(o) ||
    /is not recognized as an internal or external command/.test(o) ||
    /不是内部或外部命令/.test(o) ||
    /无法将“.+”项识别为/.test(o) ||
    /commandnotfoundexception/.test(o) ||
    /the term .+ is not recognized/.test(o) ||
    (/no such file or directory/.test(o) && !/^\s*[./~]/.test(line))
  );
}
