/**
 * 远端 shell 握手标记的判定工具。
 *
 * 登录握手与退出探活都靠「标记独占一行」来判断远端是否执行到了我们发的命令。
 * 这里集中处理两个实测踩出来的坑：
 *
 * 1. 远端的 readline / zle 在跑命令前会重画行，典型的是关掉 bracketed paste 时
 *    吐出的 `\x1b[?2004l\r`：一个 ANSI 序列 + **裸 \r**（没有 \n）。标记紧跟在
 *    它后面，于是「行首」锚定就判不到标记了。Ubuntu 22.04 + bash 实测就是这样，
 *    标记 0.5 秒就到了却被判成永远没来，白吞 25 秒输出。
 * 2. 标记字面量必须不能被「命令回显」误触发，所以命令里把它拆成
 *    `__mssh_rea'dy'__`，并且判定时要求标记独占一行。
 */

/** 判定前的规范化：剥掉 ANSI 序列 + 把裸 \r 也当换行，让标记重新落回行首 */
export function normalizeForMatch(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r\n?/g, '\n');
}

/** 只用来判断「这段输出里除了控制序列还有没有真东西」 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

/** 标记必须独占一行（回显里跟着 echo 的残缺版不算） */
export function markerRe(marker: string): RegExp {
  return new RegExp('(?:^|\\n)' + marker + '(?=\\n|$)');
}

/**
 * 取「标记之后」的内容：可能是用户提前敲的命令的输出。
 * 匹配用规范化副本，切片必须回到原始流，否则 ANSI 颜色会被抹掉、索引也会错位，
 * 所以这里按标记字面量在原串里定位（回显里是拆过引号的残缺版，不会先命中）。
 */
export function tailAfterMarker(seen: string, marker: string): string {
  const i = seen.lastIndexOf(marker);
  return i >= 0 ? seen.slice(i + marker.length) : '';
}
