/**
 * 连接选择器冒烟测试：不需要真终端，用脚本化的「假输入」驱动 chooseTarget。
 * 覆盖：本地默认项、确认/取消、按序号选主机、按别名/前缀选主机、非法输入、退出。
 */
import fs from 'node:fs';
import { defaultConfig, type AppConfig, type SshHost } from '../src/config.js';
import { chooseTarget, type Asker, type Target } from '../src/cli/launcher.js';

/** 同步直写 fd 1，绕开被劫持的 process.stdout.write，也避免 process.exit 截断缓冲 */
function out(s: string): void {
  fs.writeSync(1, s);
}

const realWrite = process.stdout.write.bind(process.stdout) as (s: string) => boolean;

const hosts: SshHost[] = [
  { name: 'prod-web-01', host: '172.16.1.86', port: 22, username: 'ubuntu', privateKeyPath: '~/.ssh/id_rsa', comment: '生产 web-01' },
  { name: 'node2', host: '172.16.1.82', port: 22, username: 'root', password: 'x' },
  { name: 'node3', host: '172.16.1.92', port: 22, username: 'root' },
];

function makeCfg(list: SshHost[] = hosts): AppConfig {
  const cfg = defaultConfig();
  cfg.ssh.hosts = [...list];
  return cfg;
}

/** 把一系列预设答案包成 Asker，并记录所有提问 */
function scripted(answers: string[]): { ask: Asker; asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  const ask: Asker = async (q) => {
    asked.push(q);
    return answers[i++] ?? '';
  };
  return { ask, asked };
}

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) out(`  PASS  ${name}\n`);
  else {
    failures++;
    out(`  FAIL  ${name}${detail ? `  <- ${detail}` : ''}\n`);
  }
}

function describe(t: Target | null): string {
  if (!t) return 'null(退出)';
  return t.kind === 'local' ? 'local' : `ssh:${t.host.name}`;
}

const CJK_RE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += CJK_RE.test(ch) ? 2 : 1;
  return w;
}

/**
 * 取列表里每条连接行的「认证列起始显示宽度」。
 * 中文列宽是 2，直接按字符数比较会误判，所以这里真按显示宽度算。
 */
function authColumns(rendered: string): number[] {
  return rendered
    .split(/\r?\n/)
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
    .filter((l) => /^\s*\[\d\]\s/.test(l))
    .map((l) => {
      const m = l.match(/(—|私钥|密码\(已保存\)|连接时输入密码)/);
      return dispWidth(l.slice(0, m ? l.indexOf(m[0]) : l.length));
    });
}

/** 测试期间把选择界面的输出收进 sink，避免刷屏 */
function capture(): () => string {
  let sink = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    sink += s;
    return true;
  };
  return () => sink;
}

function release(): void {
  (process.stdout as unknown as { write: (s: string) => boolean }).write = realWrite;
}

async function main(): Promise<void> {
  out('连接选择器冒烟测试\n');

  // 1) 空回车 = 本地，确认 y
  {
    const sink = capture();
    const { ask, asked } = scripted(['', 'y']);
    const t = await chooseTarget(makeCfg(), ask);
    check('空回车选本地并确认', t?.kind === 'local', describe(t));
    check('确认卡片展示本地连接详情', /本地终端/.test(sink()) && /工作目录/.test(sink()));
    check('提问序列 = 选择 + 确认', asked.length === 2 && /选择/.test(asked[0]), asked.join(' | '));
    release();
  }

  // 2) 选本地但取消 -> 回到列表 -> 退出
  {
    const sink = capture();
    const { ask, asked } = scripted(['0', 'n', 'q']);
    const t = await chooseTarget(makeCfg(), ask);
    check('取消本地后回到列表再退出', t === null, describe(t));
    check('取消一次后共提问 3 次（列表重绘）', asked.length === 3, asked.join(' | '));
    check('取消有提示', /已取消/.test(sink()));
    release();
  }

  // 3) 按序号选第一台远程主机
  {
    const sink = capture();
    const { ask } = scripted(['1', 'Y']);
    const t = await chooseTarget(makeCfg(), ask);
    check('按序号选远程主机', t?.kind === 'ssh' && t.host.name === 'prod-web-01', describe(t));
    check(
      '确认卡片展示地址/认证/备注',
      /172\.16\.1\.86:22/.test(sink()) && /私钥/.test(sink()) && /生产 web-01/.test(sink()),
    );
    const cols = authColumns(sink());
    check(
      '列表各列按显示宽度对齐（中文按 2 列）',
      cols.length === 4 && new Set(cols).size === 1,
      `认证列起始宽度 = ${cols.join(', ')}`,
    );
    release();
  }

  // 4) 按别名精确匹配
  {
    capture();
    const { ask } = scripted(['node2', 'y']);
    const t = await chooseTarget(makeCfg(), ask);
    check('按别名精确选主机', t?.kind === 'ssh' && t.host.name === 'node2', describe(t));
    release();
  }

  // 5) 按唯一前缀匹配（prod -> prod-web-01）
  {
    capture();
    const { ask } = scripted(['prod', 'y']);
    const t = await chooseTarget(makeCfg(), ask);
    check('按唯一前缀选主机', t?.kind === 'ssh' && t.host.name === 'prod-web-01', describe(t));
    release();
  }

  // 6) 前缀有歧义（node -> node2/node3）必须拒绝，而不是随便挑一台
  {
    const sink = capture();
    const { ask } = scripted(['node']);
    await chooseTarget(makeCfg(), ask);
    check('歧义前缀不误选', /无法识别/.test(sink()), sink().slice(-120));
    release();
  }

  // 7) 非法输入 -> 报错 -> 重新选择
  {
    const sink = capture();
    const { ask, asked } = scripted(['99', '1', 'y']);
    const t = await chooseTarget(makeCfg(), ask);
    check('非法输入后仍能继续选择', t?.kind === 'ssh' && t.host.name === 'prod-web-01', describe(t));
    check('非法输入有提示', /无法识别/.test(sink()));
    check('非法 -> 合法 -> 确认，共 3 次提问', asked.length === 3, asked.join(' | '));
    release();
  }

  // 8) 没有远程主机时列表仍可用（本地兜底）
  {
    const sink = capture();
    const { ask } = scripted(['', 'y']);
    const t = await chooseTarget(makeCfg([]), ask);
    check('无远程主机时仍可选本地', t?.kind === 'local', describe(t));
    check('无远程主机时给出添加提示', /按 a 添加/.test(sink()));
    release();
  }

  // 9) 序号越界不误判成本地
  {
    const sink = capture();
    const { ask } = scripted(['9', 'q']);
    const t = await chooseTarget(makeCfg(), ask);
    check('序号越界不选本地', t === null, describe(t));
    check('越界提示无法识别', /无法识别/.test(sink()));
    release();
  }

  // 展示一次真实界面
  out('\n=== 界面示例（脚本化输入：1 -> y）===\n');
  const { ask: demoAsk } = scripted(['1', 'y']);
  await chooseTarget(makeCfg(), demoAsk);

  out(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  fs.writeSync(2, String(e?.stack || e));
  process.exit(1);
});
