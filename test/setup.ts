/**
 * 配置引导冒烟测试：不需要真终端，用脚本化的「假输入」驱动 runSetupWizard。
 * 全部以 dryRun 运行，绝不碰真实的 ~/.ai-shell/config.json（末尾会校验 mtime 未变）。
 */
import fs from 'node:fs';
import { configPath, defaultConfig, type AppConfig } from '../src/config.js';
import { runSetupWizard, setupHint } from '../src/cli/setup.js';
import type { Asker } from '../src/cli/hosts.js';

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

function scripted(answers: string[]): { ask: Asker; asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  const ask: Asker = async (q) => {
    asked.push(q);
    return answers[i++] ?? '';
  };
  return { ask, asked };
}

/** 每个用例都用全新配置跑，并收集输出与提问 */
async function run(cfg: AppConfig, answers: string[]) {
  const { ask, asked } = scripted(answers);
  let sink = '';
  const r = await runSetupWizard({
    cfg,
    ask,
    dryRun: true,
    out: (s) => {
      sink += s;
    },
  });
  return { ...r, sink: () => sink, asked: () => asked };
}

async function main(): Promise<void> {
  const cfgPath = configPath();
  const mtimeBefore = fs.existsSync(cfgPath) ? fs.statSync(cfgPath).mtimeMs : null;

  out('配置引导冒烟测试（dryRun，不动真实配置）\n');

  // 1) 全新配置 -> 选 DeepSeek，填 key，回车保留其余默认
  {
    const cfg = defaultConfig();
    cfg.llm.apiKey = '';
    const { cfg: after, changed, sink } = await run(cfg, ['1', '', 'sk-test-key', '', '', 'n', '', '', '']);
    check('选 DeepSeek 后 name 正确', after.llm.name === 'deepseek', after.llm.name);
    check('baseURL 用 DeepSeek 预设', after.llm.baseURL === 'https://api.deepseek.com/v1', after.llm.baseURL);
    check('apiKey 写入', after.llm.apiKey === 'sk-test-key', after.llm.apiKey);
    check('chatModel 用预设 deepseek-chat', after.llm.chatModel === 'deepseek-chat', after.llm.chatModel);
    check('changed 里报告了 apiKey 与 chatModel', changed.some((c) => c.startsWith('llm.apiKey')) && changed.some((c) => c.startsWith('llm.chatModel')), changed.join(' | '));
    check('回显里对 key 打了码', /sk-te\*+key/.test(sink()) || /\*{6}/.test(sink()), sink().slice(-200));
  }

  // 2) 已有 key：回车保留，不被清空
  {
    const cfg = defaultConfig();
    cfg.llm.name = 'deepseek';
    cfg.llm.apiKey = 'sk-old-key-1234';
    cfg.llm.baseURL = 'https://api.deepseek.com/v1';
    cfg.llm.chatModel = 'deepseek-chat';
    cfg.llm.classifyModel = 'deepseek-chat';
    const { cfg: after, changed } = await run(cfg, ['1', '', '', '', '', 'n', '', '', '']);
    check('回车保留原有 apiKey', after.llm.apiKey === 'sk-old-key-1234', after.llm.apiKey);
    check('无改动项时 changed 不含 apiKey', !changed.some((c) => c.startsWith('llm.apiKey')), changed.join(' | '));
  }

  // 3) 输入 `-` 清空 key，且不再问连通性测试
  {
    const cfg = defaultConfig();
    cfg.llm.name = 'deepseek';
    cfg.llm.apiKey = 'sk-old-key-1234';
    const { cfg: after, changed, sink } = await run(cfg, ['1', '', '-', '', '', '', '', '']);
    check('输入 - 清空 apiKey', after.llm.apiKey === '', JSON.stringify(after.llm.apiKey));
    check('changed 显示变为 (空)', changed.some((c) => /\(空\)$/.test(c)), changed.join(' | '));
    check('apiKey 为空时提示 AI 仍不可用', /AI 功能仍不可用/.test(sink()), sink().slice(-160));
  }

  // 4) 全部回车 = 跳过，配置完全不变
  {
    const cfg = defaultConfig();
    cfg.llm.apiKey = 'keep-me';
    const origName = cfg.llm.name;
    const { cfg: after, changed } = await run(cfg, ['', '', '', '']);
    check('全部回车不产生改动', changed.length === 0, changed.join(' | '));
    check('全部回车不丢原有配置', after.llm.apiKey === 'keep-me' && after.llm.name === origName, `${after.llm.name}/${after.llm.apiKey}`);
  }

  // 5) 自定义服务商：自己填 baseURL 与模型名
  {
    const cfg = defaultConfig();
    const { cfg: after } = await run(cfg, ['5', 'https://my.api/v1', 'sk-custom', 'my-small', 'my-big', 'n', '', '', '']);
    check('自定义 baseURL 生效', after.llm.baseURL === 'https://my.api/v1', after.llm.baseURL);
    check('自定义模型名生效', after.llm.chatModel === 'my-big' && after.llm.classifyModel === 'my-small', `${after.llm.classifyModel}/${after.llm.chatModel}`);
    check('自定义服务商 name = custom', after.llm.name === 'custom', after.llm.name);
  }

  // 6) 启动方式：改为直接本地 shell + 会话结束即退出
  {
    const cfg = defaultConfig();
    const { cfg: after, changed } = await run(cfg, ['', '', '2', 'n']);
    check('startup.mode 改为 local', after.startup.mode === 'local', after.startup.mode);
    check('returnToPicker 改为 false', after.startup.returnToPicker === false, String(after.startup.returnToPicker));
    check('changed 报告两项启动改动', changed.filter((c) => c.startsWith('startup.')).length === 2, changed.join(' | '));
  }

  // 7) 非法服务商编号 -> 该段跳过，不炸
  {
    const cfg = defaultConfig();
    const origName = cfg.llm.name;
    const { cfg: after, sink } = await run(cfg, ['9', '', '', '']);
    check('非法编号不修改 llm', after.llm.name === origName, after.llm.name);
    check('非法编号有提示', /没看懂/.test(sink()), sink().slice(-160));
  }

  // 8) AI 执行策略：迭代轮数 / 重试次数 / 手敲危险命令确认
  {
    const cfg = defaultConfig();
    const { cfg: after, changed, asked } = await run(cfg, ['', '', '', '', '8', '0', 'n']);
    check('迭代轮数可配置为 8', after.agent.maxRounds === 8, String(after.agent.maxRounds));
    check('重试次数可配置为 0', after.agent.retries === 0, String(after.agent.retries));
    check('手敲危险命令确认可关闭', after.safety.confirmManual === false, String(after.safety.confirmManual));
    check(
      'changed 报告三项 AI 策略改动',
      changed.some((c) => c.startsWith('agent.maxRounds')) &&
        changed.some((c) => c.startsWith('agent.retries')) &&
        changed.some((c) => c.startsWith('safety.confirmManual')),
      changed.join(' | '),
    );
    check(
      '提问里带出当前值（回车保留 5 / 2）',
      asked().some((q) => /回车保留 5/.test(q)) && asked().some((q) => /回车保留 2/.test(q)),
      asked().join(' | '),
    );
  }

  // 9) 轮数越界被夹紧，非法输入保留原值
  {
    const cfg = defaultConfig();
    const { cfg: clamped } = await run(cfg, ['', '', '', '', '999', '', '']);
    check('轮数超上限被夹到 20', clamped.agent.maxRounds === 20, String(clamped.agent.maxRounds));

    const cfg2 = defaultConfig();
    const { cfg: kept, sink } = await run(cfg2, ['', '', '', '', 'abc', '', '']);
    check('非法轮数保留默认 5', kept.agent.maxRounds === 5, String(kept.agent.maxRounds));
    check('非法轮数有提示', /不是有效数字/.test(sink()), sink().slice(-160));
  }

  // 10) setupHint：未配置时给引导，配置齐全后不再打扰
  {
    const empty = defaultConfig();
    empty.llm.apiKey = '';
    empty.ssh.hosts = [];
    const h1 = setupHint(empty);
    check('未配置时给引导提示', Boolean(h1) && /ai setup/.test(h1!), String(h1));

    const full = defaultConfig();
    full.llm.apiKey = 'sk-x';
    full.ssh.hosts = [{ name: 'n56', host: '172.18.201.56', username: 'wyzd' }];
    check('配置齐全后不再提示', setupHint(full) === null, String(setupHint(full)));
  }

  // 安全兜底：确认整个过程没有动真实配置文件
  const mtimeAfter = fs.existsSync(cfgPath) ? fs.statSync(cfgPath).mtimeMs : null;
  check('dryRun 未改动真实 config.json', mtimeBefore === mtimeAfter, `${mtimeBefore} -> ${mtimeAfter}`);

  out(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  fs.writeSync(2, String(e?.stack || e));
  process.exit(1);
});
