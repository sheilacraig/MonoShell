/**
 * Ctrl+C 中断链路测试。
 *
 * 覆盖三件事：
 * 1. 正在跑的子进程能被真杀掉，并且整条命令行以 130 收尾；
 * 2. 被中断的命令不会拖着后面的语句一起跑（`;` 和 `&&` 都要断）；
 * 3. 行编辑器把 \x03 翻译成 onCtrlC，但**不**结束本次 read
 *    （结束了主循环就会 break，等于按一下 Ctrl+C 直接退出 shell）。
 */
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShellEngine, INTERRUPT_CODE } from '../src/shell/engine.js';
import { LineEditor } from '../src/shell/line.js';
import { watchInterrupt } from '../src/term/interrupt.js';

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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 用当前 node 的绝对路径，避免依赖 PATH 里恰好有个 node */
const NODE = `"${process.execPath.replace(/\\/g, '/')}"`;
/** 一个不会自己退出的子进程，用来冒充「长时间运行的命令」 */
const LONG_CMD = `${NODE} -e "setInterval(function(){},1000)"`;

class FakeStdin extends EventEmitter {
  resume() {
    return this;
  }
  pause() {
    return this;
  }
}

async function main() {
  process.stdout.write('\n[子进程中断]\n');

  {
    const engine = new ShellEngine(process.cwd());
    const p = engine.exec(LONG_CMD);
    await delay(500); // 等子进程真的起来
    const t0 = Date.now();
    engine.interrupt();
    const r = await p;
    const cost = Date.now() - t0;
    check('中断正在运行的子进程返回 130', r.code === INTERRUPT_CODE, `code=${r.code}`);
    check('中断后立刻收尾，不等命令自然结束', cost < 1400, `${cost}ms`);
  }

  process.stdout.write('\n[多语句短路]\n');

  {
    const engine = new ShellEngine(process.cwd());
    const p = engine.exec(`${LONG_CMD} ; echo SHOULD_NOT_RUN`);
    await delay(500);
    engine.interrupt();
    const r = await p;
    check('中断后 `;` 后面的语句不执行', !r.output.includes('SHOULD_NOT_RUN'), JSON.stringify(r.output));
    check('中断整条命令行报 130', r.code === INTERRUPT_CODE, `code=${r.code}`);
  }

  {
    const engine = new ShellEngine(process.cwd());
    const p = engine.exec(`${LONG_CMD} && echo SHOULD_NOT_RUN`);
    await delay(500);
    engine.interrupt();
    const r = await p;
    check('中断后 `&&` 后面的语句不执行', !r.output.includes('SHOULD_NOT_RUN'), JSON.stringify(r.output));
  }

  {
    // 中断标志必须按轮次复位：否则一次 Ctrl+C 会让之后每条命令一进来就短路
    const engine = new ShellEngine(process.cwd());
    const p = engine.exec(LONG_CMD);
    await delay(500);
    engine.interrupt();
    await p;
    const r = await engine.exec('echo RECOVERED');
    check('中断后的下一条命令正常执行', r.code === 0 && r.output.includes('RECOVERED'), `${r.code} ${JSON.stringify(r.output)}`);
  }

  process.stdout.write('\n[内置命令中断]\n');

  {
    // sleep 是纯 JS 的 setTimeout，没有子进程可以被外部杀掉，只能靠信号通知
    const engine = new ShellEngine(process.cwd());
    const t0 = Date.now();
    const p = engine.exec('sleep 20');
    await delay(150);
    engine.interrupt();
    const r = await p;
    const cost = Date.now() - t0;
    check('内置 sleep 能被中断', cost < 3000, `${cost}ms`);
    check('内置 sleep 中断返回 130', r.code === INTERRUPT_CODE, `code=${r.code}`);
  }

  process.stdout.write('\n[行编辑器 Ctrl+C]\n');

  {
    const stdin = new FakeStdin();
    const editor = new LineEditor(
      () => '$ ',
      [],
      () => [],
      undefined,
      stdin as unknown as NodeJS.ReadStream,
    );
    let hits = 0;
    editor.onCtrlC = () => {
      hits++;
    };
    const p = editor.read();
    stdin.emit('data', '\x03');
    check('收到 \\x03 触发 onCtrlC', hits === 1, `hits=${hits}`);
    stdin.emit('data', 'ls\r');
    const line = await p;
    check('Ctrl+C 不结束本次 read（否则会直接退出 shell）', line === 'ls', JSON.stringify(line));
  }

  {
    // 未绑定回调时不能崩：Ctrl+C 只清行
    const stdin = new FakeStdin();
    const editor = new LineEditor(() => '$ ', [], () => [], undefined, stdin as unknown as NodeJS.ReadStream);
    const p = editor.read();
    stdin.emit('data', '\x03');
    stdin.emit('data', 'pwd\r');
    const line = await p;
    check('未绑定 onCtrlC 时仅清行', line === 'pwd', JSON.stringify(line));
  }

  process.stdout.write('\n[执行期间的输入接管]\n');

  {
    const stdin = new FakeStdin();
    let hits = 0;
    const dispose = watchInterrupt(() => {
      hits++;
    }, stdin as unknown as NodeJS.ReadStream);
    stdin.emit('data', 'abc');
    check('普通字符不触发中断', hits === 0, `hits=${hits}`);
    stdin.emit('data', 'ab\x03cd');
    check('同一块里夹着 \\x03 也触发', hits === 1, `hits=${hits}`);
    dispose();
    stdin.emit('data', '\x03');
    check('dispose 之后不再触发（否则会和行编辑器双消费）', hits === 1, `hits=${hits}`);
  }

  {
    // 连按 Ctrl+C 是常态：第一下之后 signal 就 aborted 了，早期版本在
    // repl 里直接 return，把后面几下全吞掉
    const stdin = new FakeStdin();
    let hits = 0;
    const dispose = watchInterrupt(() => {
      hits++;
    }, stdin as unknown as NodeJS.ReadStream);
    stdin.emit('data', '\x03');
    stdin.emit('data', '\x03');
    stdin.emit('data', '\x03');
    check('连按 Ctrl+C 每一次都要转发（不能被第一下吞掉）', hits === 3, `hits=${hits}`);
    dispose();
  }

  process.stdout.write('\n[流式输出不该外泄]\n');

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-int-'));
    const engine = new ShellEngine(dir);
    const chunks: string[] = [];
    const sink = (c: string) => chunks.push(c);
    const outFile = path.join(dir, 'out.txt').replace(/\\/g, '/');
    // 注意必须用**外部命令**（node）来测：内置 echo 的输出走返回值、根本不经过
    // onData，拿它去测这条路径等于什么也没测到。
    const say = (word: string) => `${NODE} -e "console.log('${word}')"`;

    await engine.exec(`${say('LEAKED')} > ${outFile}`, undefined, { onData: sink });
    check('重定向命令不触发流式输出', chunks.length === 0, JSON.stringify(chunks.join('')));
    check('重定向内容确实落盘', fs.readFileSync(path.join(dir, 'out.txt'), 'utf8').trim() === 'LEAKED');

    chunks.length = 0;
    await engine.exec(`${say('MIDDLE')} | grep NOMATCH`, undefined, { onData: sink });
    check('管道中间段不流式输出', !chunks.join('').includes('MIDDLE'), JSON.stringify(chunks.join('')));

    chunks.length = 0;
    const r = await engine.exec(say('VISIBLE'), undefined, { onData: sink });
    check('最后一段照常流式输出', chunks.join('').includes('VISIBLE'), JSON.stringify(chunks.join('')));
    check('流式之后 output 依然完整（兜底判定要用）', r.output.includes('VISIBLE'), JSON.stringify(r.output));

    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (process.platform === 'win32') {
    process.stdout.write('\n[Windows 孤儿进程]\n');
    // taskkill 必须抢在 child.kill 之前跑。顺序反了的话，父进程 cmd.exe 当场
    // 注销，/t 再也枚举不出子孙，ping.exe 会脱离进程树继续挂满 30 秒。
    const countPing = () => {
      try {
        const listing = execFileSync('tasklist', ['/fi', 'imagename eq ping.exe', '/nh'], {
          encoding: 'utf8',
        });
        return (listing.match(/ping\.exe/gi) || []).length;
      } catch {
        return 0;
      }
    };
    const before = countPing();
    const engine = new ShellEngine(process.cwd());
    const p = engine.exec('cmd /c "ping -n 30 127.0.0.1"');
    await delay(1800); // 等 cmd 与 ping 都真正起来
    const during = countPing();
    engine.interrupt();
    await p;
    await delay(1200); // 给 taskkill 留出收尾时间
    const after = countPing();
    if (during > before) {
      check('中断后不留孤儿子孙进程', after <= before, `before=${before} during=${during} after=${after}`);
    } else {
      process.stdout.write('  SKIP  孤儿进程检测（本次没抓到 ping 子进程）\n');
    }
  }

  process.stdout.write(`\n结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e));
  process.exit(1);
});
