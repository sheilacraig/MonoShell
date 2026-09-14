/**
 * 直通模式端到端测试。
 *
 * 和 test/passthrough.ts 的分工：
 *   - passthrough.ts 测「嗅探器」单点逻辑（纯函数，无副作用）
 *   - 本文件测「接线」：远端输出 -> 嗅探器 -> LineEditor 让位 -> 按键真正送到 sink，
 *     全流程走 LineEditor 的真实公开入口（read() + 可控 stdin），不打桩内部方法。
 *
 * 这层测试存在的理由：嗅探器全绿、编辑器也全绿，接线错了照样废。
 * （初版就是把 sniffer.feed 的返回值接给了 editor.setPassthrough，
 *   少一层 changed 判断，重复喂入会反复复位行编辑状态。）
 */
import { EventEmitter } from 'node:events';
import { PassthroughSniffer } from '../src/term/passthrough.js';
import { LineEditor } from '../src/shell/line.js';

let pass = 0;
let fail = 0;
const t = (name: string, cond: boolean) => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
};

console.log('=== 直通模式端到端 ===');

/** 够像 NodeJS.ReadStream，能让 LineEditor 正常挂监听 */
class FakeStdin extends EventEmitter {
  isTTY = true;
  resume(): void {}
  pause(): void {}
  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  writeKeys(s: string): void {
    this.emit('data', Buffer.from(s, 'utf8'));
  }
}

const makeEditor = () => {
  const stdin = new FakeStdin();
  const editor = new LineEditor(
    () => 'mono> ',
    [],
    () => null,
    () => '/',
    stdin as unknown as NodeJS.ReadStream,
  );
  return { stdin, editor };
};

// ---- 场景 1：tmux Ctrl+b d ----
console.log('--- tmux Ctrl+b d ---');
{
  const { stdin, editor } = makeEditor();
  const sent: string[] = [];
  const sniffer = new PassthroughSniffer();
  const remoteFeed = (s: string) => {
    const { changed, active } = sniffer.feed(s);
    if (changed) editor.setPassthrough(active, (d) => sent.push(d));
  };

  const p1 = editor.read();
  remoteFeed('\x1b[?1049h\x1b[22;0;0t\x1b[?1h\x1b=');
  t('tmux 进备用屏后进入直通', editor.isPassthrough === true);

  stdin.writeKeys('\x02');
  t('Ctrl+b 转发到远端（关键修复点）', sent.join('') === '\x02');

  stdin.writeKeys('d');
  t('d 转发到远端', sent.join('') === '\x02d');

  remoteFeed('\x1b[?1049l\x1b[23;0;0t');
  t('detach 出备用屏后自动退出直通', editor.isPassthrough === false);

  sent.length = 0;
  stdin.writeKeys('hi\r');
  const line = await p1;
  t('退出直通后行编辑恢复（收到 hi）', line === 'hi');
  t('退出直通后按键不再裸转发', sent.join('') === '');
}

// ---- 场景 2：vim / less / top 按键透传 ----
console.log('--- vim / less / top ---');
{
  const { stdin, editor } = makeEditor();
  const sent: string[] = [];
  const sniffer = new PassthroughSniffer();
  const remoteFeed = (s: string) => {
    const { changed, active } = sniffer.feed(s);
    if (changed) editor.setPassthrough(active, (d) => sent.push(d));
  };

  const p2 = editor.read();
  remoteFeed('\x1b[?1049h');
  t('vim 进备用屏后进入直通', editor.isPassthrough === true);

  sent.length = 0;
  stdin.writeKeys('\x1b[A\x1b[B');
  t('vim 方向键 ESC 序列完整透传', sent.join('') === '\x1b[A\x1b[B');

  sent.length = 0;
  stdin.writeKeys('\x02 \x03');
  t('Ctrl+b / 空格 / Ctrl+C 全透传', sent.join('') === '\x02 \x03');

  sent.length = 0;
  stdin.writeKeys('q');
  t('q 透传', sent.join('') === 'q');

  remoteFeed('\x1b[?1049l');
  t('全屏程序退出后自动恢复', editor.isPassthrough === false);
  stdin.writeKeys('\r');
  await p2;
}

// ---- 场景 3：逃生键 Ctrl+] ----
console.log('--- 逃生键 Ctrl+] ---');
{
  const { stdin, editor } = makeEditor();
  const sent: string[] = [];
  let escapeFired = 0;
  editor.onPassthroughEscape = () => {
    escapeFired++;
  };

  const p3 = editor.read();
  editor.setPassthrough(true, (d) => sent.push(d));
  t('手动进入直通（等价 /raw）', editor.isPassthrough === true);

  sent.length = 0;
  stdin.writeKeys('\x1d');
  t('Ctrl+] 触发逃生回调', escapeFired === 1);
  t('逃生键本身不转发给远端', sent.join('') === '');
  t('逃生后状态归位', editor.isPassthrough === false);

  stdin.writeKeys('ok\r');
  const line = await p3;
  t('逃生后行编辑可用（收到 ok）', line === 'ok');
}

// ---- 场景 4：直通中 writeExternal 原样透传 ----
console.log('--- writeExternal 不插手 ---');
{
  const { editor } = makeEditor();
  editor.setPassthrough(true, () => {});
  let captured: string | null = null;
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    captured = String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    editor.writeExternal('\x1b[2Jfullscreen-paint');
  } finally {
    process.stdout.write = orig;
  }
  t('直通中 writeExternal 原样透传（不重画提示符）', captured === '\x1b[2Jfullscreen-paint');
  editor.setPassthrough(false);
}

// ---- 场景 5：跨 chunk 分片 ----
console.log('--- 分片 ---');
{
  const s = new PassthroughSniffer();
  const r1 = s.feed('\x1b[?10');
  t('半截序列不触发', r1.changed === false);
  const r2 = s.feed('49h');
  t('补齐后触发进入', r2.changed === true && r2.active === true);
  const r3 = s.feed('\x1b[?1049l');
  t('完整退出序列触发退出', r3.changed === true && r3.active === false);
}

console.log('');
console.log(`共 ${pass + fail} 项：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
