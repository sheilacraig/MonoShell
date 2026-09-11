/**
 * AI 执行策略 + 危险命令确认 的冒烟测试。
 * 覆盖：agent 配置项与老配置迁移、重试次数、超时、危险命令分级判定、
 *       系统提示词不再让模型自我审查、以及「配错 baseURL 也不会无限卡死」。
 */
import fs from 'node:fs';
import { defaultConfig, mergeConfig, type AppConfig } from '../src/config.js';
import { withRetry } from '../src/core/llm.js';
import { checkRisk, detectInteractiveAuth, sniffPasswordPrompt } from '../src/core/safety.js';
import { systemPrompt } from '../src/core/prompt.js';
import { Agent, type AgentHost } from '../src/core/agent.js';
import { captureExec } from '../src/term/capture.js';
import type { Session } from '../src/session/types.js';

function out(s: string): void {
  fs.writeSync(1, s);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) out(`  PASS  ${name}\n`);
  else {
    failures++;
    out(`  FAIL  ${name}${detail ? `  <- ${detail}` : ''}\n`);
  }
}

function describe(t: unknown): string {
  return JSON.stringify(t);
}

/** 造一个 AgentHost，可按用例覆盖任意钩子 */
function makeHost(
  cfg: AppConfig,
  notes: string[],
  over: Partial<AgentHost> = {},
): AgentHost {
  const base: AgentHost = {
    session: {
      kind: 'local',
      label: 'local',
      osFamily: 'windows',
      shellType: 'unix',
      eol: '\r',
    } as unknown as Session,
    cfg,
    note: (t: string) => notes.push(t),
    confirm: async () => 'no' as const,
    needAuth: async () => 'no' as const,
    editCommand: async () => null,
    runCaptured: async () => ({ output: '', exitCode: 0, timedOut: false }),
    isAborted: () => false,
  };
  return { ...base, ...over };
}

async function main(): Promise<void> {
  out('AI 执行策略 / 危险命令确认 冒烟测试\n');

  // ── 1. agent 配置 ──────────────────────────────────────────────
  {
    const d = defaultConfig();
    check('默认迭代轮数为 5', d.agent.maxRounds === 5, String(d.agent.maxRounds));
    check('默认重试次数为 2', d.agent.retries === 2, String(d.agent.retries));
    check('默认单轮超时为 50s', d.agent.timeoutMs === 50_000, String(d.agent.timeoutMs));
    check('默认手敲危险命令要确认', d.safety.confirmManual === true, String(d.safety.confirmManual));
  }

  // ── 2. 配置合并 / 老配置迁移 ───────────────────────────────────
  {
    const cfg = mergeConfig({ agent: { maxRounds: 9, retries: 0, timeoutMs: 8000 } } as Partial<AppConfig>);
    check('agent.maxRounds 可配置', cfg.agent.maxRounds === 9, String(cfg.agent.maxRounds));
    check('agent.retries 可配 0（不重试）', cfg.agent.retries === 0, String(cfg.agent.retries));

    // 老配置只有 safety.maxRounds -> 平滑迁移
    const legacy = mergeConfig({ safety: { maxRounds: 7 } } as Partial<AppConfig>);
    check('老配置 safety.maxRounds=7 迁移到 agent.maxRounds', legacy.agent.maxRounds === 7, String(legacy.agent.maxRounds));

    // 两者都配了 -> agent 优先
    const both = mergeConfig({ agent: { maxRounds: 3 } , safety: { maxRounds: 7 } } as Partial<AppConfig>);
    check('同时存在时 agent.maxRounds 优先', both.agent.maxRounds === 3, String(both.agent.maxRounds));

    const untouched = mergeConfig({} as Partial<AppConfig>);
    check('空配置保持默认 5 轮', untouched.agent.maxRounds === 5, String(untouched.agent.maxRounds));
  }

  // ── 3. 重试封装 ────────────────────────────────────────────────
  {
    let calls = 0;
    const v = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('boom');
        return 'ok';
      },
      { retries: 2, backoffMs: 1 },
    );
    check('失败 2 次后第 3 次成功', v === 'ok' && calls === 3, `calls=${calls}`);

    let calls0 = 0;
    let threw = '';
    try {
      await withRetry(
        async () => {
          calls0++;
          throw new Error('always');
        },
        { retries: 0, backoffMs: 1 },
      );
    } catch (e) {
      threw = (e as Error).message;
    }
    check('retries=0 时只尝试一次', calls0 === 1 && threw === 'always', `calls=${calls0} err=${threw}`);

    let attempts = 0;
    const retryNotified: number[] = [];
    let timeoutErr = '';
    try {
      await withRetry(
        () => {
          attempts++;
          return new Promise<string>(() => {
            /* 永不 resolve，只能靠超时打断 */
          });
        },
        {
          retries: 2,
          timeoutMs: 60,
          backoffMs: 1,
          onRetry: (n) => retryNotified.push(n),
        },
      );
    } catch (e) {
      timeoutErr = (e as Error).message;
    }
    check('超时会打断并触发重试（共 3 次尝试）', attempts === 3, `attempts=${attempts}`);
    check('超时抛 LLM_TIMEOUT', timeoutErr === 'LLM_TIMEOUT', timeoutErr);
    check('每次重试都通知了调用方', retryNotified.join(',') === '1,2', retryNotified.join(','));
  }

  // ── 4. 危险命令分级判定 ────────────────────────────────────────
  {
    const cfg = defaultConfig();
    const full = (c: string) => checkRisk(c, cfg, 'full').risky;
    const danger = (c: string) => checkRisk(c, cfg, 'dangerous').risky;

    check('AI 档：rm -rf 命中', full('rm -rf ./dist') === true);
    check('手敲档：rm -rf 也命中（必须让用户确认）', danger('rm -rf ./dist') === true, String(danger('rm -rf ./dist')));
    check('手敲档：systemctl stop 命中', danger('systemctl stop nginx') === true);
    check('手敲档：写文件重定向不打扰', danger('echo hi > out.txt') === false, String(danger('echo hi > out.txt')));
    check('AI 档：写文件重定向仍拦截', full('echo hi > out.txt') === true, String(full('echo hi > out.txt')));
    check('手敲档：只读命令放行', danger('ls -la') === false && full('ls -la') === false);
    check('手敲档：du/grep 等常规命令放行', danger('du -h --max-depth=1 | sort -hr') === false);
  }

  // ── 5. 系统提示词：不再让模型自我审查 ──────────────────────────
  {
    const session = {
      kind: 'local',
      label: 'local',
      osFamily: 'windows',
      shellType: 'unix',
      eol: '\r',
    } as unknown as Session;
    const p = systemPrompt(session, 'C:\\tmp');
    check('提示词不再写「不要 rm -rf」式自我审查', !/不要\s*rm\s*-rf/.test(p));
    check('提示词明确要求交出命令而非绕道', /不要自己审查命令的风险/.test(p));
    check('提示词说明外层有确认环节', /确认环节/.test(p) && /用户/.test(p));
    check('提示词仍要求讲清破坏性后果', /破坏性/.test(p));
    check('提示词要求确认无法免密后收尾而不是堆变体', /手动输入密码/.test(p) && /变体/.test(p), 'sudo 规则');
    check('提示词给出 sudo 场景的示例', /sudo ufw status verbose/.test(p));
  }

  // ── 6. 交互式密码识别 ─────────────────────────────────────────
  {
    const needs = (c: string) => detectInteractiveAuth(c).needs;
    check('sudo 识别为需要密码', needs('sudo ufw status verbose') === true);
    check('sudo -n（免密）不识别', needs('sudo -n ufw status') === false, 'sudo -n');
    check('su 识别', needs('su - deploy') === true);
    check('passwd 识别', needs('passwd wyzd') === true);
    check('mysql -p 识别', needs('mysql -u root -p') === true);
    check('ssh-add 识别', needs('ssh-add ~/.ssh/id_rsa') === true);
    check('普通命令不识别', needs('cat /etc/ufw/user.rules') === false);
    check('只读命令不识别', needs('du -h --max-depth=1 | sort -hr') === false);
    const info = detectInteractiveAuth('sudo systemctl restart nginx');
    check('给出提示与免密思路', Boolean(info.hint) && Boolean(info.fix), `${info.hint} / ${info.fix}`);
  }

  // ── 6. 端到端：baseURL 配错时不会无限卡死 ──────────────────────
  {
    const cfg = defaultConfig();
    cfg.llm.apiKey = 'sk-test';
    cfg.llm.baseURL = 'http://127.0.0.1:9/v1'; // 必然连不上
    cfg.agent.retries = 0;
    cfg.agent.timeoutMs = 3000;

    const notes: string[] = [];
    const host = makeHost(cfg, notes);

    const agent = new Agent(cfg, host);
    const done = await Promise.race([
      agent.run('看看磁盘').then(() => 'done'),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 15_000)),
    ]);
    check('调用失败时能正常返回（不会卡住）', done === 'done', done);
    check('失败信息里带上重试次数', notes.some((n) => /已重试 0 次|重试/.test(n)), notes.join(' | '));
  }

  // 未配 key 时立刻提示，不发起任何请求
  {
    const cfg = defaultConfig();
    cfg.llm.apiKey = '';
    const notes: string[] = [];
    await new Agent(cfg, makeHost(cfg, notes)).run('看看磁盘');
    check('未配 key 时提示去 ai setup', notes.some((n) => /ai setup/.test(n)), notes.join(' | '));
  }

  // ── 7. 需要手动输密码的命令必须「主动提示」，而不是硬跑 + 烧完轮数 ──
  {
    const cfg = defaultConfig();
    cfg.llm.apiKey = 'sk-test';
    const notes: string[] = [];
    let ran = 0;
    let chatCalls = 0;
    // 记录真实 UI 层的 needAuth 被怎么调用（真 UI 会把提示框画出来）
    const authAsked: { cmd: string; hint: string; fix?: string }[] = [];
    const host = makeHost(cfg, notes, {
      needAuth: async (cmd, hint, fix) => {
        authAsked.push({ cmd, hint, fix });
        return 'no';
      },
      runCaptured: async () => {
        ran++;
        return { output: '', exitCode: 0, timedOut: false };
      },
    });
    const fakeChat = async () => {
      chatCalls++;
      return '{"note":"查看 ufw 状态","command":"sudo ufw status verbose","done":false}';
    };
    await new Agent(cfg, host, { chat: fakeChat as never }).run('告诉我防火墙 ufw 开放了哪些端口');

    check('识别出 sudo 需要密码并主动提示', authAsked.length === 1, `asked=${authAsked.length}`);
    check('提示的是那条 sudo 命令本身', authAsked[0]?.cmd === 'sudo ufw status verbose', authAsked[0]?.cmd);
    check('提示里点明了「需要密码」', /密码/.test(authAsked[0]?.hint ?? ''), authAsked[0]?.hint);
    check('提示里给了改进办法（配 NOPASSWD）', Boolean(authAsked[0]?.fix), String(authAsked[0]?.fix));
    check('用户选择跳过后没有真的执行', ran === 0, `ran=${ran}`);
    check('跳过后立刻停止，不再反复试 sudo（只调用模型 1 次）', chatCalls === 1, `chat=${chatCalls}`);
    check('不会走到「已达最大迭代轮数」', !notes.some((n) => /已达最大迭代轮数/.test(n)), notes.join(' | '));
    check('提示语不再重复打印两遍', !notes.some((n) => /需要输入密码/.test(n)), notes.join(' | '));
  }

  // 用户坚持要试 -> 用短超时，并在嗅到密码提示时中断
  {
    const cfg = defaultConfig();
    cfg.llm.apiKey = 'sk-test';
    const notes: string[] = [];
    let usedTimeout: number | undefined;
    let chatCalls = 0;
    const host = makeHost(cfg, notes, {
      needAuth: async () => 'yes',
      runCaptured: async (_cmd, timeoutMs) => {
        usedTimeout = timeoutMs;
        return { output: '', exitCode: -1, timedOut: false, needsInput: true, promptText: '[sudo] password for wyzd:' };
      },
    });
    const fakeChat = async () => {
      chatCalls++;
      return '{"note":"查看 ufw 状态","command":"sudo ufw status verbose","done":false}';
    };
    await new Agent(cfg, host, { chat: fakeChat as never }).run('看看 ufw 端口');

    check('坚持执行时用短超时（不是 30s）', usedTimeout !== undefined && usedTimeout <= 10000, String(usedTimeout));
    check('卡在密码提示时明确告知并中断', notes.some((n) => /卡在密码提示/.test(n)), notes.join(' | '));
    check('中断后不再继续下一轮', chatCalls === 1, `chat=${chatCalls}`);
  }

  // 模型没写 sudo、但命令照样弹了密码提示 -> 同样要停
  {
    const cfg = defaultConfig();
    cfg.llm.apiKey = 'sk-test';
    const notes: string[] = [];
    const host = makeHost(cfg, notes, {
      runCaptured: async () => ({ output: '', exitCode: -1, timedOut: false, needsInput: true, promptText: 'Password:' }),
    });
    const fakeChat = async () => '{"note":"读一下配置","command":"cat /etc/shadow","done":false}';
    await new Agent(cfg, host, { chat: fakeChat as never }).run('读配置');

    check('未预判到但实际卡在密码时也会中断', notes.some((n) => /卡在密码提示/.test(n)), notes.join(' | '));
    check('中断后把命令回显出来，方便用户照着手敲', notes.some((n) => /cat \/etc\/shadow/.test(n)), notes.join(' | '));
    check('中断后明确告知不再往下试', notes.some((n) => /不再往下试/.test(n)), notes.join(' | '));
  }

  // ── 7b. done:true + 命令（模型按规则 10 交出的 sudo 命令）不能默默收工 ──
  // 翻车现场：note 打了「需要你手动输入密码」，命令本身却从没出现。
  {
    const cfg = defaultConfig();
    cfg.llm.apiKey = 'sk-test';
    const notes: string[] = [];
    let ran = 0;
    const host = makeHost(cfg, notes, {
      runCaptured: async () => {
        ran++;
        return { output: '', exitCode: 0, timedOut: false };
      },
    });
    const fakeChat = async () =>
      '{"note":"关闭 ufw 3906 端口（需要你手动输入密码）","command":"sudo ufw deny 3906","done":true}';
    await new Agent(cfg, host, { chat: fakeChat as never }).run('帮我关闭 ufw 3906 端口');

    check('done:true 带命令时也会把命令打出来（不再静默收工）', notes.some((n) => /sudo ufw deny 3906/.test(n)), notes.join(' | '));
    check('done:true 的命令不走捕获通道代跑', ran === 0, `ran=${ran}`);
  }

  // 有交互通道（SSH）时：done:true 的命令应询问后交回用户终端执行
  {
    const cfg = defaultConfig();
    cfg.llm.apiKey = 'sk-test';
    const notes: string[] = [];
    let ran = 0;
    const handed: string[] = [];
    const host = makeHost(cfg, notes, {
      needAuth: async () => 'yes',
      runInteractive: async (c) => {
        handed.push(c);
      },
      runCaptured: async () => {
        ran++;
        return { output: '', exitCode: 0, timedOut: false };
      },
    });
    const fakeChat = async () =>
      '{"note":"关闭 ufw 3906 端口（需要你手动输入密码）","command":"sudo ufw deny 3906","done":true}';
    await new Agent(cfg, host, { chat: fakeChat as never }).run('帮我关闭 ufw 3906 端口');

    check('done:true 的命令交回用户终端执行', handed.length === 1 && handed[0] === 'sudo ufw deny 3906', handed.join(' | '));
    check('交回终端时不走捕获通道', ran === 0, `ran=${ran}`);
    check('交回终端时有明确提示', notes.some((n) => /已交到你的终端执行/.test(n)), notes.join(' | '));
  }

  // needAuth 选 y 且有交互通道：交回终端，而不是 AI 短超时硬试
  {
    const cfg = defaultConfig();
    cfg.llm.apiKey = 'sk-test';
    const notes: string[] = [];
    let ran = 0;
    const handed: string[] = [];
    const host = makeHost(cfg, notes, {
      needAuth: async () => 'yes',
      runInteractive: async (c) => {
        handed.push(c);
      },
      runCaptured: async () => {
        ran++;
        return { output: '', exitCode: 0, timedOut: false };
      },
    });
    const fakeChat = async () => '{"note":"查看 ufw 状态","command":"sudo ufw status verbose","done":false}';
    await new Agent(cfg, host, { chat: fakeChat as never }).run('看看 ufw 端口');

    check('needAuth 选 y 后交回用户终端执行', handed.length === 1 && handed[0] === 'sudo ufw status verbose', handed.join(' | '));
    check('有交互通道时 AI 不再短超时硬试', ran === 0, `ran=${ran}`);
  }

  // 中途卡密码 + 有交互通道：中断后提供交回终端的选择
  {
    const cfg = defaultConfig();
    cfg.llm.apiKey = 'sk-test';
    const notes: string[] = [];
    const handed: string[] = [];
    const host = makeHost(cfg, notes, {
      needAuth: async () => 'yes',
      runInteractive: async (c) => {
        handed.push(c);
      },
      runCaptured: async () => ({ output: '', exitCode: -1, timedOut: false, needsInput: true, promptText: 'Password:' }),
    });
    const fakeChat = async () => '{"note":"读一下配置","command":"cat /etc/shadow","done":false}';
    await new Agent(cfg, host, { chat: fakeChat as never }).run('读配置');

    check('卡密码中断后可交回用户终端执行', handed.length === 1 && handed[0] === 'cat /etc/shadow', handed.join(' | '));
  }

  // ── 8. 密码提示嗅探 + 捕获器早退 + 回显残渣擦除 ─────────────────
  {
    check('[sudo] password 提示可嗅出', sniffPasswordPrompt('[sudo] password for wyzd: ') !== null);
    check('sudo: a password is required 可嗅出', sniffPasswordPrompt('sudo: a password is required') !== null);
    check('Enter passphrase for key 可嗅出', sniffPasswordPrompt('Enter passphrase for key "/home/w/.ssh/id_rsa":') !== null);
    check('普通输出不会被误判', sniffPasswordPrompt('total 12\ndrwxr-xr-x 2 root root 4096 a') === null);
  }

  // 用假 session 驱动捕获器：验证早退 + 残渣擦除（复现用户那次翻车）
  {
    const written: string[] = [];
    let dataCb: ((d: string) => void) | null = null;
    const fakeSession = {
      kind: 'ssh',
      label: 'ssh:fake',
      osFamily: 'unix',
      shellType: 'unix',
      eol: '\n',
      write: (d: string) => written.push(d),
      onData: (cb: (d: string) => void) => {
        dataCb = cb;
      },
      resize: () => {},
      close: () => {},
      onExit: () => {},
    } as unknown as Session;

    const visible: string[] = [];
    const handle = captureExec(fakeSession, 'sudo ufw status verbose', 'unix', 30_000, {
      skipEcho: false,
      abortOnPrompt: true,
      emit: (s) => visible.push(s),
    });
    handle.feed('\r\n');
    handle.feed('[sudo] password for wyzd: ');
    const res = await handle.result;

    check('嗅到密码提示即中断（不用等超时）', res.needsInput === true && res.timedOut === false, JSON.stringify(res));
    check('中断时带上提示原文', /\[sudo\] password/.test(res.promptText ?? ''), String(res.promptText));
    check('中断时向远端发了 Ctrl+C', written.some((w) => w.includes('\x03')), JSON.stringify(written));

    // 回显被终端折行时留下的残渣要擦干净
    const written2: string[] = [];
    let cb2: ((d: string) => void) | null = null;
    const fake2 = {
      ...fakeSession,
      write: (d: string) => written2.push(d),
      onData: (cb: (d: string) => void) => {
        cb2 = cb;
      },
    } as unknown as Session;
    const vis2: string[] = [];
    const h2 = captureExec(fake2, 'ufw status verbose', 'unix', 30_000, {
      skipEcho: false,
      emit: (s) => vis2.push(s),
    });
    const marker = /__AIX_[a-z0-9]{6}__/.exec(written2[0])?.[0] ?? '';
    // 模拟折行：标记前半段与折行后的 `"; echo "$__m:$?` 残渣
    h2.feed(`ubuntu@h:~$ ufw status verbose; __m="${marker}"\r\n"; echo "$__m:$?\r\n`);
    h2.feed(`Status: active\r\n${marker}:0\r\n`);
    await h2.result;
    const shown = vis2.join('');
    check('回显残渣（折行后的 echo "$__m:$?）被擦除', !/\$__m/.test(shown), JSON.stringify(shown));
    check('真实输出保留', /Status: active/.test(shown), JSON.stringify(shown));
    void cb2;
    void dataCb;
  }

  out(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  fs.writeSync(2, String(e?.stack || e));
  process.exit(1);
});
