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

// ---- 场景 6：输出侧字节保真（第三层：远端字节 → stdout）----
//
// 这层测试的由来：输入侧 e2e 全绿时，输出侧仍有两个缺陷漏网——
//   a) detach 被 TCP 分包时，含 1049l 的纯控制块在「先切状态后写屏」的
//      顺序下被 externalOutputBytes 整块丢弃，本地终端永远卡在备用屏；
//   b) 退出提示写在 1049l 落屏之前 = 写在备用屏上，切回主屏后消失。
// 断言必须打在**实际写到 stdout 的字节**上，而不是状态值上。
//
// 注意：探针环境 stdout 可能被重定向（isTTY=false），那会走「原样写」分支
// 掩盖问题。强制 isTTY=true 复现真实终端判定。
console.log('--- 输出侧字节保真 ---');
{
  const isTTYDesc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  const captured: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    captured.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const { stdin, editor } = makeEditor();
    const sent: string[] = [];
    const sniffer = new PassthroughSniffer();
    // 与 repl.ts 的接线语义一致：进入先切、写屏、退出后切 + note
    const remoteWriter = (s: string) => {
      const { changed, active } = sniffer.feed(s);
      if (changed && active) editor.setPassthrough(true, (d) => sent.push(d));
      editor.writeExternal(s);
      if (changed && !active) {
        editor.setPassthrough(false);
        captured.push('\r\n[note] 已退出全屏程序\r\n');
      }
    };

    const p = editor.read();

    // 分包场景：控制段与提示符段分开到达
    remoteWriter('\x1b[?1049h\x1b[22;0;0t');
    captured.length = 0;
    remoteWriter('\x1b[?1049l\x1b[23;0;0t');   // 分包 1：纯控制序列
    remoteWriter('user@host:~$ ');              // 分包 2：提示符
    const all = captured.join('');
    t('分包 detach：1049l 到达本地终端（P1 回归）', all.includes('\x1b[?1049l'));
    const notePos = all.indexOf('[note]');
    const exitPos = all.indexOf('\x1b[?1049l');
    t('分包 detach：note 在 1049l 之后（不被切屏吃掉）',
      notePos >= 0 && exitPos >= 0 && notePos > exitPos);
    t('分包后已退出直通', editor.isPassthrough === false);

    // 整包场景（对照）
    captured.length = 0;
    remoteWriter('\x1b[?1049h');
    remoteWriter('\x1b[?1049luser@host:~$ ');
    const all2 = captured.join('');
    t('整包 detach：1049l 到达本地终端', all2.includes('\x1b[?1049l'));
    const notePos2 = all2.indexOf('[note]');
    const exitPos2 = all2.indexOf('\x1b[?1049l');
    t('整包 detach：note 在 1049l 之后',
      notePos2 >= 0 && exitPos2 >= 0 && notePos2 > exitPos2);

    // 进入侧：首帧原样落屏（无清行前缀 \r\x1b[2K 污染）
    captured.length = 0;
    remoteWriter('\x1b[?1049h\x1b[H\x1b[2J');
    const first = captured.join('');
    t('进入首帧原样落屏（无 \\r\\x1b[2K 前缀）', first.startsWith('\x1b[?1049h'));
    remoteWriter('\x1b[?1049l');
    stdin.writeKeys('\r');
    await p;
  } finally {
    process.stdout.write = orig;
    if (isTTYDesc) Object.defineProperty(process.stdout, 'isTTY', isTTYDesc);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
}

// ---- 场景 7：逃生键 chunk 中间不丢前半段 ----
console.log('--- 逃生键数据保真 ---');
{
  const { stdin, editor } = makeEditor();
  const sent: string[] = [];
  let escaped = 0;
  editor.onPassthroughEscape = () => {
    escaped++;
  };
  const p = editor.read();
  editor.setPassthrough(true, (d) => sent.push(d));
  // 快速按键合并成一个 chunk：'hhh' + Ctrl+] —— hhh 必须先发给远端
  stdin.writeKeys('hhh\x1d');
  t('逃生键前半段（hhh）已发远端', sent.join('') === 'hhh');
  t('逃生键本身不转发', !sent.join('').includes('\x1d'));
  t('逃生回调触发且状态归位', escaped === 1 && editor.isPassthrough === false);
  stdin.writeKeys('ok\r');
  const line = await p;
  t('退出后行编辑可用', line === 'ok');
}

console.log('');
console.log(`共 ${pass + fail} 项：PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
