/**
 * 全屏交互程序（tmux / vim / less / top / htop / nano …）的进出嗅探。
 *
 * 背景：MonoShell 自带行编辑器，它需要「知道一行输完了没有」才能做补全、历史和
 * AI 触发判定。所以它必须主动消费控制字符 —— 这就导致 `Ctrl+b`（\x02）这类
 * **不属于编辑器快捷键的控制字符会被丢弃**，压根发不到远端。
 *
 * 对普通命令这没问题，但 tmux / vim 这类全屏程序要求字节级透传。解决方案不是
 * 换掉行编辑器（那会丢掉补全和 AI 入口），而是在识别到全屏程序接管屏幕时
 * **临时让位**，把按键原样转给远端，退出后自动收回。
 *
 * 判据：备用屏幕（alternate screen）切换序列。
 *
 *   \x1b[?1049h  进入备用屏幕 —— tmux / vim / less / top / htop / nano 都会发
 *   \x1b[?1049l  退出备用屏幕
 *
 * 为什么不用别的信号：
 * - `\x1b[?25l`（隐藏光标）太常见，进度条也发，误判率高；
 * - 判断输入里有没有控制字符是本末倒置 —— 正是控制字符发不出去才有这个问题；
 * - 1049 是 xterm 引入的标准做法，主流终端程序都用它，误判率最低。
 *
 * 备选覆盖：少数程序用 smcup/rmcup 但不带 1049 参数（老的 `\x1b[?47h` 一对），
 * 一并认掉，成本为零。
 */

/** 进入备用屏幕的序列变体 */
const ENTER_SEQS = ['\x1b[?1049h', '\x1b[?47h'];
/** 退出备用屏幕的序列变体 */
const EXIT_SEQS = ['\x1b[?1049l', '\x1b[?47l'];

/** 最长序列长度，用于决定缓冲区保留多少字节做跨 chunk 匹配 */
const MAX_SEQ = 10;

/**
 * 跨 chunk 匹配器。
 *
 * 关键点：这些序列可能被网络分片截断，例如：
 *   chunk1 = '\x1b[?10'   chunk2 = '49h'
 * 所以必须保留尾部若干字节，和下一个 chunk 拼起来再判。
 * 直接对每个 chunk 单独做 includes() 会漏掉这种情况。
 */
export class PassthroughSniffer {
  /** 上一轮遗留的、可能是半个序列的尾巴 */
  private tail = '';
  private active = false;

  /**
   * 喂入一段远端输出，返回本次是否发生了状态翻转。
   * 调用方据此决定要不要切换直通模式。
   */
  feed(chunk: string): { changed: boolean; active: boolean } {
    const buf = this.tail + chunk;

    // 同一段里可能既有进入又有退出（例如 vim 秒开秒关）。
    // 取「最后一次出现」的那个为准，才符合终端的真实状态。
    let lastEnter = -1;
    let lastExit = -1;
    for (const s of ENTER_SEQS) {
      const i = buf.lastIndexOf(s);
      if (i > lastEnter) lastEnter = i;
    }
    for (const s of EXIT_SEQS) {
      const i = buf.lastIndexOf(s);
      if (i > lastExit) lastExit = i;
    }

    const before = this.active;
    if (lastEnter >= 0 || lastExit >= 0) {
      // 谁在后面谁生效；相等时不可能（同一位置不可能同时是 enter 和 exit）
      this.active = lastEnter > lastExit;
    }

    // 保留尾部，够拼一个完整序列即可。别留太多，否则跨行的旧内容会造成误判。
    this.tail = buf.slice(-MAX_SEQ);

    return { changed: before !== this.active, active: this.active };
  }

  get isActive(): boolean {
    return this.active;
  }

  /** 强制复位（会话重建 / 断开时用），避免状态残留到下个连接 */
  reset(): void {
    this.tail = '';
    this.active = false;
  }
}

/**
 * 单个字符串里是否含进入/退出序列（不跨 chunk 的简单场景，供测试与快速判定）。
 * 返回 'enter' | 'exit' | null。
 */
export function detectAlternateScreen(s: string): 'enter' | 'exit' | null {
  let lastEnter = -1;
  let lastExit = -1;
  for (const q of ENTER_SEQS) {
    const i = s.lastIndexOf(q);
    if (i > lastEnter) lastEnter = i;
  }
  for (const q of EXIT_SEQS) {
    const i = s.lastIndexOf(q);
    if (i > lastExit) lastExit = i;
  }
  if (lastEnter < 0 && lastExit < 0) return null;
  return lastEnter > lastExit ? 'enter' : 'exit';
}
