/**
 * 输出捕获通道回归测试。
 *
 * 这里守的是「屏幕上不该出现什么」：
 * - 回显里的标记片段（`; __m="__AIX_xxx__"; echo "$__m:$?"`）不能漏到终端
 * - 回显被终端折行拦腰截断后的碎片（`$?"`）不能漏到终端
 * - 标记输出行（`__AIX_xxx__:0`）不能漏到终端
 * - 远端提示符不该混进回喂给模型的内容
 * - 回喂给模型的内容里，命令的真实输出不能重复、不能被截断
 */
import { captureExec } from '../src/term/capture.js';
import type { Session } from '../src/session/types.js';

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

const DF_OUT =
  'Filesystem      Size  Used Avail Use% Mounted on\n' +
  '/dev/sda1        40G   25G   13G  67% /\n' +
  'tmpfs           3.9G   24K  3.9G   1% /dev/shm';

type RunResult = { visible: string; toModel: string; exitCode: number };

/** 起一次捕获，喂进模拟的远端回包，返回「用户可见」与「回喂模型」两份文本 */
async function runCapture(chunksFn: (marker: string) => string[]): Promise<RunResult> {
  const written: string[] = [];
  const session: Session = {
    kind: 'ssh',
    label: 'ssh:demo',
    osFamily: 'unix',
    shellType: 'unix',
    eol: '\n',
    write: (d) => written.push(d),
    onData: () => {},
    resize: () => {},
    close: () => {},
    onExit: () => {},
  };

  let visible = '';
  const handle = captureExec(session, 'df -h', 'unix', 3000, {
    skipEcho: false,
    abortOnPrompt: true,
    emit: (c) => (visible += c),
  });

  const full = written[0].replace(/\n$/, '');
  const marker = /__AIX_[a-z0-9]+__/.exec(full)![0];
  for (const c of chunksFn(marker)) {
    // 必须先用临时变量接住返回值：`visible += handle.feed(c)` 会把 feed 期间
    // emit 出来的尾巴覆盖掉（先读 visible，再求值右侧，最后赋回去）。
    const ret = handle.feed(c);
    visible += ret;
  }

  const r = await handle.result;
  return { visible, toModel: r.output, exitCode: r.exitCode };
}

async function main() {
  process.stdout.write('\n[捕获通道：擦除与回喂]\n');

  // 1) 理想情况：远端已 stty -echo，无回显
  {
    const { visible, toModel, exitCode } = await runCapture((m) => [
      `\r\n${DF_OUT}\r\n`,
      `${m}:0\r\n`,
    ]);
    check('无回显：可见输出含完整 df 结果', visible.includes('67% /') && visible.includes('/dev/shm'), JSON.stringify(visible));
    check('无回显：可见输出不含标记', !visible.includes('__AIX_'), JSON.stringify(visible));
    check('无回显：回喂模型内容含完整 df 结果', toModel.includes('Filesystem') && toModel.includes('/dev/shm'), JSON.stringify(toModel));
    check('无回显：回喂模型内容不含标记片段', !toModel.includes('__m=') && !toModel.includes('__AIX_'), JSON.stringify(toModel));
    check(
      '无回显：回喂模型内容不重复尾部',
      toModel === DF_OUT,
      JSON.stringify(toModel),
    );
    check('无回显：退出码取自标记', exitCode === 0, String(exitCode));
  }

  // 2) 回显完整（未 stty -echo），且不折行
  {
    const { visible, toModel } = await runCapture((m) => [
      `df -h; __m="${m}"; echo "$__m:$?"\r\n`,
      `${DF_OUT}\r\n`,
      `${m}:0\r\n`,
    ]);
    check('回显不折行：可见输出不含标记片段', !visible.includes('__m=') && !visible.includes('$?'), JSON.stringify(visible));
    check('回显不折行：可见输出保留完整 df 结果', visible.includes('67% /'), JSON.stringify(visible));
    check('回显不折行：回喂模型内容不含标记片段', !toModel.includes('__m='), JSON.stringify(toModel));
  }

  // 3) 回显被折行拦腰截断 —— 就是屏幕上冒出 `$?"` 的那种情况
  {
    const { visible, toModel } = await runCapture((m) => [
      `df -h; __m="${m}"\r\n`,
      `; echo "$__m:$?"\r\n`,
      `${DF_OUT}\r\n`,
      `${m}:0\r\n`,
    ]);
    check('回显折行：可见输出不含 `$?"` 碎片', !/\$\?"/.test(visible), JSON.stringify(visible));
    check('回显折行：可见输出不含 `$__m`', !visible.includes('$__m'), JSON.stringify(visible));
    check('回显折行：可见输出不含标记行', !visible.includes('__AIX_'), JSON.stringify(visible));
    check('回显折行：可见输出保留完整 df 结果', visible.includes('67% /') && visible.includes('/dev/shm'), JSON.stringify(visible));
    check('回显折行：回喂模型内容不含标记片段', !toModel.includes('__m') && !toModel.includes('__AIX_'), JSON.stringify(toModel));
  }

  // 4) 折行点正好落在 `$__m` 中间，残渣只剩 `$?"`
  {
    const { visible } = await runCapture((m) => [
      `df -h; __m="${m}"; echo "$__m:`,
      `$?"\r\n`,
      `${DF_OUT}\r\n`,
      `${m}:0\r\n`,
    ]);
    check('残渣 `$?"` 被清掉', !/\$\?"/.test(visible), JSON.stringify(visible));
    check('残渣场景仍保留 df 结果', visible.includes('67% /'), JSON.stringify(visible));
  }

  // 5) 擦除后不该留下多余空行（旧实现在删标记行时不吃换行，屏幕上会多出空行）
  {
    const { visible } = await runCapture((m) => [
      `df -h; __m="${m}"; echo "$__m:$?"\r\n`,
      `${DF_OUT}\r\n`,
      `${m}:0\r\n`,
    ]);
    check('回显整行被删干净，不留空行', !/\n[ \t]*\n/.test(visible) && visible.trim().startsWith('Filesystem'), JSON.stringify(visible));
    check('可见输出不以空行开头', !visible.startsWith('\n'), JSON.stringify(visible));
  }

  // 6) 命令很长、回显被折成多段时仍能擦干净
  {
    const longCmd = 'du -h --max-depth=1 | sort -hr | head -n 20';
    const written: string[] = [];
    const session: Session = {
      kind: 'ssh',
      label: 'ssh:demo',
      osFamily: 'unix',
      shellType: 'unix',
      eol: '\n',
      write: (d) => written.push(d),
      onData: () => {},
      resize: () => {},
      close: () => {},
      onExit: () => {},
    };
    let visible = '';
    const handle = captureExec(session, longCmd, 'unix', 3000, {
      skipEcho: false,
      abortOnPrompt: true,
      emit: (c) => (visible += c),
    });
    const full = written[0].replace(/\n$/, '');
    const marker = /__AIX_[a-z0-9]+__/.exec(full)![0];
    const echo = `${longCmd}; __m="${marker}"; echo "$__m:$?"`;
    // 模拟终端折行：每 40 个字符插一个 CRLF
    for (let i = 0; i < echo.length; i += 40) {
      visible += handle.feed(echo.slice(i, i + 40) + '\r\n');
    }
    visible += handle.feed(`${DF_OUT}\r\n${marker}:0\r\n`);
    const r = await handle.result;
    check('长命令多段折行：可见输出不含标记碎片', !/__m|\$__m|\$\?"|__AIX_/.test(visible), JSON.stringify(visible));
    check('长命令多段折行：保留真实输出', r.output.includes('Filesystem'), JSON.stringify(r.output));
  }

  // 7) 不误伤：真实输出里的分隔线 / 含符号的行不该被当成回显残渣删掉
  {
    const { visible } = await runCapture((m) => [
      `--------------------------------\r\n`,
      `================================\r\n`,
      `total: 42, ratio: 67%\r\n`,
      `${m}:0\r\n`,
    ]);
    check('不误伤分隔线 `---`', visible.includes('----'), JSON.stringify(visible));
    check('不误伤分隔线 `===`', visible.includes('===='), JSON.stringify(visible));
    check('不误伤含符号的正常行', visible.includes('total: 42, ratio: 67%'), JSON.stringify(visible));
  }

  // 8) 退出码解析：负数不能被吞成 0
  // Windows / PowerShell 下 $LASTEXITCODE 可能是 -1 或 HRESULT 负数，
  // 旧正则 `(\d*)` 只认数字，匹配出空串后按 0 处理 —— 失败命令会被判成成功。
  {
    const neg = await runCapture((m) => [`\r\n${DF_OUT}\r\n`, `${m}:-1\r\n`]);
    check('负数退出码原样带出', neg.exitCode === -1, String(neg.exitCode));
    check('负数退出码不留在文本里', !neg.toModel.includes('-1'), JSON.stringify(neg.toModel));

    const empty = await runCapture((m) => [`\r\n${m}:\r\n`]);
    check('退出码为空按 0 处理', empty.exitCode === 0, String(empty.exitCode));

    const nonzero = await runCapture((m) => [`\r\n${m}:127\r\n`]);
    check('普通非零退出码不受影响', nonzero.exitCode === 127, String(nonzero.exitCode));
  }

  process.stdout.write(`\n  ${pass} 项通过，${fail} 项失败\n`);
  if (fail) process.exitCode = 1;
}

void main();
