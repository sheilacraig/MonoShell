/**
 * 远端握手标记判定回归测试。
 *
 * 守的是「登录握手 / 退出探活的标记，该认的必须认出来，不该认的不能误触发」：
 * - 远端 readline 重画行后标记仍要认得出（裸 \r、ANSI 清行序列）
 * - 命令回显里的残缺标记（引号拆分）不能提前触发握手
 * - 标记必须独占一行
 * - tailAfterMarker 按原始流切片，颜色不能被抹掉
 *
 * 背景：Ubuntu 22.04 + bash 实测，标记 0.5 秒就回来了，但前面顶着
 * `\x1b[?2004l\r`（关 bracketed paste + 裸 \r），只认 \r?\n 的锚定判不到，
 * 结果被当成「远端没就绪」白吞 25 秒输出。
 */
import { markerRe, normalizeForMatch, stripAnsi, tailAfterMarker } from '../src/session/handshake.js';
import { externalOutputBytes } from '../src/shell/line.js';

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

const SETUP = markerRe('__mssh_ready__');
/** 判定口径：规范化后判断标记是否独占一行 */
const hit = (s: string) => SETUP.test(normalizeForMatch(s));

// 1) 实测原始字节流（206，Ubuntu 22.04 + bash）
check('裸 \\r 重画后仍认得出标记', hit('\x1b[?2004l\r__mssh_ready__\r\n\x1b[?2004h'));
check('zsh 式重画（\\r + 清行）后仍认得出', hit('\r\x1b[K__mssh_ready__\r\n'));
check('纯输出行', hit('__mssh_ready__\r\n'));

// 2) 分包：标记已到、结尾换行还没到
check('分包：标记后换行未到也算到', hit('junk\r\n__mssh_ready__'));
check('标记后紧跟用户提前敲的命令输出', hit('__mssh_ready__\r\nls out\r\n'));

// 3) 不误触发：命令回显里是 __mssh_rea'dy'__，且不独占一行
check('引号拆分的回显不触发', !hit("echo __mssh_rea'dy'__\r\n"));
check('回显里带 echo 前缀的完整标记不触发', !hit('echo __mssh_ready__\r\n'));
check('嵌在单词中间不触发', !hit('foox__mssh_ready__x\r\n'));
check('标记行中间夹内容不触发', !hit('__mssh_ready__x\r\n'));

// 4) 尾部切片：回到原始流，ANSI 颜色要保住
{
  const seen = '\x1b[?2004l\r__mssh_ready__\r\n\x1b[32mok\x1b[0m\r\n';
  const after = tailAfterMarker(seen, '__mssh_ready__');
  check('tailAfterMarker 保留颜色', after.includes('\x1b[32m'), JSON.stringify(after));
  check('tailAfterMarker 内容正确', stripAnsi(after).trim() === 'ok', JSON.stringify(stripAnsi(after)));
  check('tailAfterMarker 无标记时返回空串', tailAfterMarker('nothing\r\n', '__mssh_ready__') === '');
}

// 5) stripAnsi 只用来判断「有没有真东西」
check('纯控制序列视为空', stripAnsi('\x1b[?2004h\x1b[?2004l\r').trim() === '');
check('OSC 标题也剥掉', stripAnsi('\x1b]0;root@host: ~\x07hi').trim() === 'hi');

// 6) 远端输出插屏：本地提示符已经画出去之后，远端消息才到时的落屏姿势
{
  const CLEAR = '\r\x1b[2K';
  // 不保护输入行（AI 在跑命令、命令正在收尾）→ 一个字节都不动
  check('无输入行要保护：原样写', externalOutputBytes('out\r\n', false) === 'out\r\n');
  // 纯控制序列：远端 readline 的 bracketed paste 开关，留着只会挪光标顶掉提示符
  check('纯控制序列被丢掉', externalOutputBytes('\x1b[?2004l\r', true) === '');
  check('bracketed paste 开也被丢掉', externalOutputBytes('\x1b[?2004h', true) === '');
  // 正常输出：清行 + 输出，然后交给 render 重画提示符
  check('正常输出：清行后原样写', externalOutputBytes('hi\r\n', true) === CLEAR + 'hi\r\n');
  // 不以换行收尾：必须补 \r\n，否则重绘会把这半行一起清掉
  check('半行输出补换行', externalOutputBytes('Password: ', true) === CLEAR + 'Password: \r\n');
  // 裸 \r 只是回到行首，内容还在那一行，也得补
  check('裸 \\r 收尾也算半行', externalOutputBytes('tail...\r', true) === CLEAR + 'tail...\r' + '\r\n');
  check(
    '多行输出尾部有换行不补',
    externalOutputBytes('a\r\nb\r\n', true) === CLEAR + 'a\r\nb\r\n',
  );
  // 整块恰好只有一个换行：它承载的是「一个空行」这个真实输出。
  // 远端程序自己打的空行、或被 TCP 分包单独切出来的换行都会长这样，
  // 按 trim 判空会把它当控制序列吞掉。
  check('单独的空行要保留', externalOutputBytes('\n', true) === CLEAR + '\n');
  check('CRLF 空行要保留', externalOutputBytes('\r\n', true) === CLEAR + '\r\n');
  check('空白加裸 \\r 仍算控制序列', externalOutputBytes('  \r', true) === '');
}

process.stdout.write(`\n  ${pass} 项通过，${fail} 项失败\n`);
if (fail) process.exitCode = 1;
