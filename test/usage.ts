/**
 * 「常用命令按使用度补全」相关回归测试。
 *
 * 覆盖三块：
 * - commandNameOf：从一整行输入里正确取出要计数的命令名
 * - UsageStats：计数、排序、推荐、持久化、脏数据与膨胀保护
 * - resolveCompletion：Tab 按下后输入行该变成什么样（含最长公共前缀）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { commandNameOf, UsageStats } from '../src/shell/usage.js';
import { LineEditor, longestCommonPrefix, resolveCompletion } from '../src/shell/line.js';
import { makeLocalCompleter, makeRemoteCompleter } from '../src/shell/complete.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    fail++;
    process.stdout.write(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}\n`);
  }
}

function tmpFile(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-shell-usage-${tag}-`));
  return path.join(dir, 'usage.json');
}

/** 造一个能手动喂按键的假输入流 */
function makeFakeStdin(): {
  stream: NodeJS.ReadStream;
  send: (s: string) => void;
} {
  const em = new EventEmitter() as unknown as NodeJS.ReadStream;
  (em as unknown as Record<string, unknown>).resume = () => {};
  (em as unknown as Record<string, unknown>).pause = () => {};
  (em as unknown as Record<string, unknown>).isTTY = false;
  return {
    stream: em,
    send: (s) => (em as unknown as { emit: (evt: string, data: string) => void }).emit('data', s),
  };
}

async function main() {
  process.stdout.write('\n[命令名提取]\n');
  check('普通命令', commandNameOf('ls -la') === 'ls', String(commandNameOf('ls -la')));
  check('前后空白', commandNameOf('   df -h  ') === 'df', String(commandNameOf('   df -h  ')));
  check('空行返回 null', commandNameOf('   ') === null, String(commandNameOf('   ')));
  check('管道只取首个命令', commandNameOf('du -h | sort -hr') === 'du', String(commandNameOf('du -h | sort -hr')));
  check('绝对路径去前缀', commandNameOf('/usr/bin/grep foo') === 'grep', String(commandNameOf('/usr/bin/grep foo')));
  check(
    '跳过前置环境变量赋值',
    commandNameOf('LC_ALL=C sort file') === 'sort',
    String(commandNameOf('LC_ALL=C sort file')),
  );
  check(
    '跳过带引号的赋值',
    commandNameOf('MSG="a b" echo hi') === 'echo',
    String(commandNameOf('MSG="a b" echo hi')),
  );
  check('纯赋值不算命令', commandNameOf('FOO=1') === null, String(commandNameOf('FOO=1')));
  check(
    '带变量/相对路径的命令取 basename',
    commandNameOf('$HOME/bin/run') === 'run' && commandNameOf('./configure --prefix=/opt') === 'configure',
    `${commandNameOf('$HOME/bin/run')} / ${commandNameOf('./configure --prefix=/opt')}`,
  );

  process.stdout.write('\n[使用统计]\n');
  {
    const f = tmpFile('basic');
    const u = new UsageStats(f);
    check('初始为空', u.score('ls') === 0, String(u.score('ls')));

    for (let i = 0; i < 5; i++) u.record('ls -la');
    u.record('df -h');
    u.record('df -h');
    u.record('grep foo bar');

    check('按命令名计数，忽略参数差异', u.score('ls') === 5, String(u.score('ls')));
    check('次数少的排在后面', u.rank(['grep', 'df', 'ls']).join(',') === 'ls,df,grep', u.rank(['grep', 'df', 'ls']).join(','));

    check('推荐列表按常用度排序', u.suggest(3).join(',') === 'ls,df,grep', u.suggest(3).join(','));
    check('推荐可以截断', u.suggest(2).join(',') === 'ls,df', u.suggest(2).join(','));

    check('未记录的命令不参与排序但不报错', u.rank(['zzz', 'ls']).join(',') === 'ls,zzz', u.rank(['zzz', 'ls']).join(','));

    process.stdout.write('\n[忽略名单]\n');
    u.record('cd /tmp');
    u.record('exit');
    u.record('clear');
    check('cd / exit / clear 不入榜', u.score('cd') === 0 && u.score('exit') === 0 && u.score('clear') === 0,
      `cd=${u.score('cd')} exit=${u.score('exit')} clear=${u.score('clear')}`);

    process.stdout.write('\n[持久化]\n');
    u.flush();
    check('落盘后文件存在', fs.existsSync(f));
    const u2 = new UsageStats(f);
    check('重载后计数保持', u2.score('ls') === 5, String(u2.score('ls')));
    check('重载后排序保持', u2.suggest(3).join(',') === 'ls,df,grep', u2.suggest(3).join(','));

    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    check('文件结构为 commands/lastUsed', Boolean(raw.commands) && Boolean(raw.lastUsed), JSON.stringify(Object.keys(raw)));

    u2.record('unzip a.zip');
    u2.flush();
    check('增量写入不影响已有计数', new UsageStats(f).score('ls') === 5, String(new UsageStats(f).score('ls')));
  }

  process.stdout.write('\n[脏数据与膨胀保护]\n');
  {
    const f = tmpFile('dirty');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{ this is not json', 'utf8');
    const u = new UsageStats(f);
    check('坏文件不抛异常，按空统计处理', u.suggest(5).length === 0);

    const f2 = tmpFile('dirty2');
    fs.writeFileSync(
      f2,
      JSON.stringify({
        commands: { ls: 3, bad: -1, worse: 'x' as unknown as number, nan: Number.NaN },
        lastUsed: { ls: 123, other: 'nope' as unknown as number },
      }),
      'utf8',
    );
    const u2 = new UsageStats(f2);
    check('负数计数被丢弃', u2.score('bad') === 0, String(u2.score('bad')));
    check('非数字计数被丢弃', u2.score('worse') === 0, String(u2.score('worse')));
    check('合法计数保留', u2.score('ls') === 3, String(u2.score('ls')));

    const f3 = tmpFile('cap');
    const u3 = new UsageStats(f3);
    for (let i = 0; i < 600; i++) u3.record(`cmd${i}`);
    u3.flush();
    const kept = Object.keys(JSON.parse(fs.readFileSync(f3, 'utf8')).commands).length;
    check('条目数被压到上限内', kept <= 500, String(kept));
  }

  process.stdout.write('\n[最长公共前缀]\n');
  check('基本用例', longestCommonPrefix(['docker', 'doc', 'dog']) === 'do', longestCommonPrefix(['docker', 'doc', 'dog']));
  check('完全一致', longestCommonPrefix(['ls', 'ls']) === 'ls');
  check('空数组', longestCommonPrefix([]) === '');
  check('有一个为空则前缀为空', longestCommonPrefix(['abc', '']) === '');

  process.stdout.write('\n[Tab 补全决策]\n');
  {
    // 唯一候选：命令名补全后跟空格
    let r = resolveCompletion('df', 2, ['df']);
    check('唯一候选补全命令名', r?.buf === 'df ' && r.cursor === 3, JSON.stringify(r));

    // 唯一候选是目录：补 '/'
    r = resolveCompletion('src', 3, ['src'], (c) => c === 'src');
    check('唯一候选是目录补 /', r?.buf === 'src/' && r.cursor === 4, JSON.stringify(r));

    // 多候补到公共前缀
    r = resolveCompletion('doc', 3, ['docker', 'docker-compose']);
    check('多候选补到公共前缀', r?.buf === 'docker' && r.cursor === 6, JSON.stringify(r));

    // 已经到公共前缀，补不动：列出来
    r = resolveCompletion('docker', 6, ['docker', 'docker-compose']);
    check('补不动时列出候选', r?.list?.length === 2 && r.buf === 'docker', JSON.stringify(r));

    // 候选顺序即常用度顺序，摊开时不被重排
    r = resolveCompletion('g', 1, ['git', 'grep', 'go']);
    check('列出时保持传入的常用度顺序', r?.list?.join(',') === 'git,grep,go', JSON.stringify(r));

    // 光标在行中间：补全不该吃掉右边的字
    r = resolveCompletion('df -h', 2, ['df']);
    check('行中间补全不影响右侧', r?.buf === 'df  -h' && r.cursor === 3, JSON.stringify(r));

    // 参数位置补全（词不在行首）：不加空格
    r = resolveCompletion('cat re', 6, ['readme.md']);
    check('参数补全不加空格', r?.buf === 'cat readme.md', JSON.stringify(r));

    // 非命令位置多候选补前缀
    r = resolveCompletion('cat re', 6, ['readme.md', 'readme.txt']);
    check('参数多候选补前缀', r?.buf === 'cat readme.' && r.cursor === 11, JSON.stringify(r));

    // 空候选：什么都不做
    check('没有候选时返回 null', resolveCompletion('zzz', 3, []) === null);

    // 候选虽多但公共前缀不前进（等于已输入内容）：摊开
    r = resolveCompletion('', 0, ['ls', 'df']);
    check('空输入按 Tab 摊开推荐', r?.list?.join(',') === 'ls,df' && r.buf === '', JSON.stringify(r));
  }

  process.stdout.write('\n[补全器：候选来源与排序]\n');
  {
    const u = new UsageStats(tmpFile('completer'));
    const local = makeLocalCompleter(u, () => os.tmpdir());

    check('还没记录时，空输入也有兜底候选', local('', 0).length > 0, String(local('', 0).length));

    for (let i = 0; i < 10; i++) u.record('ls -la');
    u.record('du -sh .');

    check('空输入按 Tab 推荐最常用的命令', local('', 0)[0] === 'ls', JSON.stringify(local('', 0).slice(0, 5)));

    const d = local('d', 1);
    check(
      '前缀匹配只返回匹配项',
      d.length > 0 && d.every((x) => x.toLowerCase().startsWith('d')),
      JSON.stringify(d.slice(0, 8)),
    );
    check('匹配项里常用的排最前', d[0] === 'du', JSON.stringify(d.slice(0, 8)));
    check(
      '候选里不混入 PATH 下的目录名',
      !d.includes('drivers') && !d.includes('lib'),
      JSON.stringify(d.slice(0, 12)),
    );

    // 参数位置走路径补全，候选是文件名而不是命令名（用干净临时目录，避免受系统全局 TEMP 污染）
    const cleanArgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-arg-'));
    fs.writeFileSync(path.join(cleanArgDir, 'argfile.txt'), '');
    const localArg = makeLocalCompleter(u, () => cleanArgDir);
    const inArg = localArg('cat ', 4);
    check('参数位置不再返回命令名', !inArg.includes('cat') && inArg.includes('argfile.txt'), JSON.stringify(inArg.slice(0, 4)));

    // 目录补全：末尾带斜杠时必须列进那个目录，而不是把目录名自身当候选返回
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-cc-'));
    fs.mkdirSync(path.join(tree, 'src'));
    fs.writeFileSync(path.join(tree, 'src', 'engine.ts'), '');
    fs.writeFileSync(path.join(tree, 'src', 'line.ts'), '');
    // 放入同前缀的目录与文件，验证 cd 仅补全目录
    fs.mkdirSync(path.join(tree, 'bm_dir'));
    fs.writeFileSync(path.join(tree, 'bm_file.txt'), '');

    const withCwd = makeLocalCompleter(u, () => tree);

    const cdBm = withCwd('cd bm', 5);
    check('cd 命令只补全目录排除普通文件', cdBm.includes('bm_dir') && !cdBm.includes('bm_file.txt'), JSON.stringify(cdBm));
    const lsBm = withCwd('ls bm', 5);
    check('ls 命令同时补全目录与文件', lsBm.includes('bm_dir') && lsBm.includes('bm_file.txt'), JSON.stringify(lsBm));

    const slash = withCwd('ls src/', 7);
    check(
      'src/ 带末尾斜杠时列出子目录内容',
      slash.includes('src/engine.ts') && !slash.includes('src'),
      JSON.stringify(slash),
    );
    check('src/ 候选带上前缀，方便接着补下一层', slash.every((x) => x.startsWith('src/')), JSON.stringify(slash));
    check('ls src 仍能补出目录名', withCwd('ls src', 6)[0] === 'src', JSON.stringify(withCwd('ls src', 6)));
    const dotted = withCwd('ls ./src/', 9);
    check(
      './src/ 同样列出子目录内容',
      dotted.includes('./src/engine.ts') && !dotted.includes('./src'),
      JSON.stringify(dotted),
    );

    // 根目录下以 bm 开头的目录补全测试（创建测试目录并在验证后立即删除）
    const isWin = process.platform === 'win32';
    if (isWin) {
      const winRootCd = withCwd('cd /u', 5);
      check('Windows 根目录小写 /u 能不区分大小写匹配出 /Users', winRootCd.includes('/Users'), JSON.stringify(winRootCd));

      try {
        fs.mkdirSync('C:\\bm_test_spec', { recursive: true });
        const bmHits = withCwd('cd /bm', 6);
        check('cd /bm 成功补全根目录下以 bm 开头的目录', bmHits.includes('/bm_test_spec'), JSON.stringify(bmHits));
      } finally {
        try {
          fs.rmdirSync('C:\\bm_test_spec');
        } catch {
          /* noop */
        }
      }
    }

    const remote = makeRemoteCompleter(u);
    check('远端空输入给推荐', remote('', 0)[0] === 'ls', JSON.stringify(remote('', 0).slice(0, 5)));
    check('远端参数位置不猜', remote('ls -', 4).length === 0, JSON.stringify(remote('ls -', 4)));

    // 远端提供路径补全器时，参数位置返回远端路径
    const remoteWithPath = makeRemoteCompleter(u, async (w, onlyDirs) => {
      return onlyDirs ? ['/boot/', '/bin/'] : ['/boot', '/bin'];
    });
    const rCand = await remoteWithPath('cd /b', 5);
    check('远端路径补全器支持异步返回目录候选', Array.isArray(rCand) && rCand.includes('/boot/'), JSON.stringify(rCand));

    const freshRemote = makeRemoteCompleter(new UsageStats(tmpFile('fallback')));
    check(
      '远端无记录时退回基础命令表',
      freshRemote('gr', 2).includes('grep'),
      JSON.stringify(freshRemote('gr', 2)),
    );
    check('远端基础命令表去重', new Set(freshRemote('', 0)).size === freshRemote('', 0).length, JSON.stringify(freshRemote('', 0)));
  }

  process.stdout.write('\n[行编辑器：真实按键路径]\n');
  {
    const { stream, send } = makeFakeStdin();
    /** 喂一串按键，返回这一行最终提交的内容 —— 走的是真实的 Tab 处理分支 */
    const type = (keys: string[], cand: string[]): Promise<string | null> => {
      const p = new LineEditor(() => '$ ', [], () => cand, undefined, stream).read();
      for (const k of keys) send(k);
      return p;
    };

    let line: string | null;

    line = await type(['d', '\t', '\r'], ['df', 'du']);
    check('多候选只补到公共前缀，不替用户选', line === 'd', JSON.stringify(line));

    line = await type(['dock', '\t', '\r'], ['docker']);
    check('唯一候选补全后自动跟空格', line === 'docker ', JSON.stringify(line));

    line = await type(['lo', '\t', '\r'], ['loginctl', 'login', 'logs']);
    check('多候选补到最长公共前缀', line === 'log', JSON.stringify(line));

    line = await type(['zzz', '\t', '\r'], []);
    check('无候选时 Tab 不改变输入', line === 'zzz', JSON.stringify(line));

    line = await type(['df', '\t', '\r'], ['df']);
    check('命令名补全后回车的整行内容正确', line === 'df ', JSON.stringify(line));

    line = await type(['dock', '\t', '\x7f', '\r'], ['docker']);
    check('补完之后回退键能正常删掉补的空格', line === 'docker', JSON.stringify(line));
  }

  process.stdout.write(`\n  ${pass} 项通过，${fail} 项失败\n`);
  if (fail) process.exitCode = 1;
}

void main();
