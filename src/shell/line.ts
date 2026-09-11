import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Completer = (line: string, cursor: number) => string[];

/**
 * 自带的行编辑器：回显、历史、光标、补全全部自己实现。
 * 不再依赖宿主 shell 的 readline，因此不受 PowerShell / bash 各自怪癖影响。
 */
function strWidth(str: string): number {
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

export class LineEditor {
  private buf = '';
  private cursor = 0;
  private histIndex = -1;
  private saved = '';
  private escBuf = '';
  /** 上次 read 未消费完的输入，留给下一行 */
  private pending = '';
  /** 当前正在等待的那一次 read 的收尾函数，供外部强制结束（如远端连接断开） */
  private finishCurrent: ((line: string | null) => void) | null = null;

  constructor(
    private promptFn: () => string,
    private history: string[],
    private completer: Completer,
    private getCwd?: () => string,
    /**
     * 输入流，默认标准输入。
     * 做成可注入的：process.stdin 是只读 getter，没法在测试里替换，
     * 而「按 Tab 会怎样」这种一按键就改写输入的行为必须能直接测。
     */
    private stdin: NodeJS.ReadStream = process.stdin,
  ) {}

  private render(): void {
    // 非交互（管道输入）时不做行重绘，否则转义序列会混进输出
    if (!process.stdout.isTTY) return;
    const prompt = this.promptFn();
    const plain = stripAnsi(prompt);
    process.stdout.write('\r\x1b[2K' + prompt + this.buf + '\x1b[K');
    const back = strWidth(this.buf.slice(this.cursor));
    if (back > 0) process.stdout.write(`\x1b[${back}D`);
    void plain;
  }

  /** 返回一行；Ctrl+D 或 EOF 时返回 null */
  read(): Promise<string | null> {
    this.buf = '';
    this.cursor = 0;
    this.histIndex = -1;
    // 上一次 read 没消费完的输入（例如管道一次性灌入多行）先继续处理
    this.escBuf = this.pending;
    this.pending = '';

    return new Promise((resolve) => {
      let settled = false;
      const finish = (line: string | null) => {
        if (settled) return;
        settled = true;
        this.finishCurrent = null;
        // 未消费完的字符留给下一次 read，避免吞掉后续命令
        this.pending = this.escBuf;
        this.escBuf = '';
        this.stdin.removeListener('data', onData);
        this.stdin.removeListener('end', onEnd);
        this.stdin.pause();
        resolve(line);
      };
      this.finishCurrent = finish;
      const onEnd = () => finish(null);

      const process = () => {
        while (this.escBuf.length) {
          if (this.escBuf[0] === '\x1b') {
            const seq = matchSeq(this.escBuf);
            if (seq === null) {
              // 序列还没收全，等下一个 chunk
              if (this.escBuf.length >= 12) {
                this.escBuf = '';
              }
              return;
            }
            this.handleSeq(seq);
            this.escBuf = this.escBuf.slice(seq.length);
            continue;
          }
          const ch = this.escBuf[0];
          this.escBuf = this.escBuf.slice(1);
          if (this.handleChar(ch, finish)) return;
        }
      };

      const onData = (d: Buffer | string) => {
        this.escBuf += typeof d === 'string' ? d : d.toString('utf8');
        process();
      };

      this.stdin.resume();
      this.stdin.on('data', onData);
      this.stdin.once('end', onEnd);
      this.render();
      // 先把上一次遗留的输入消化掉（管道场景下一行里可能有多条命令）
      process();
    });
  }

  /**
   * 外部（远端）输出要落到屏幕上时走这里。
   *
   * 远端消息是异步到的：本地提示符可能已经画出去、用户也可能正敲到一半。直接
   * write 会把提示符和输入糊在一起——远端 readline 那句 `\x1b[?2004l\r` 尤其狠，
   * 一个裸 \r 就把整行提示符顶掉。正确做法跟真终端一样：清掉当前行 → 吐输出 →
   * 重画提示符 + 用户已敲的内容（render 负责）。
   *
   * 不在 read 中时（AI 在跑命令、命令正在收尾）没有输入行要保护，原样写即可。
   */
  writeExternal(s: string): void {
    // 非交互（管道）不做行重绘，转义序列只会污染输出
    if (!process.stdout.isTTY || !this.finishCurrent) {
      process.stdout.write(s);
      return;
    }
    const bytes = externalOutputBytes(s, true);
    if (!bytes) return;
    process.stdout.write(bytes);
    this.render();
  }

  /**
   * 外部强制结束当前这一行的读取（返回 null，等同于 Ctrl+D）。
   * 用于远端连接被关闭时把控制权交回上层，而不是一直干等输入。
   */
  interrupt(): void {
    if (this.finishCurrent) {
      process.stdout.write('\r\n');
      this.finishCurrent(null);
    }
  }

  /** 返回 true 表示本次读取结束 */
  private handleChar(ch: string, finish: (l: string | null) => void): boolean {
    switch (ch) {
      case '\r':
      case '\n': {
        const line = this.buf;
        this.buf = '';
        this.cursor = 0;
        process.stdout.write('\r\n');
        finish(line);
        return true;
      }
      case '\x04': // Ctrl+D
        if (!this.buf) {
          process.stdout.write('\r\n');
          finish(null);
          return true;
        }
        return false;
      case '\x03': // Ctrl+C
        this.buf = '';
        this.cursor = 0;
        process.stdout.write('^C\r\n');
        this.render();
        return false;
      case '\x7f':
      case '\b': {
        if (this.cursor > 0) {
          this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
          this.cursor--;
          this.render();
        }
        return false;
      }
      case '\x15': // Ctrl+U 清空
        this.buf = this.buf.slice(this.cursor);
        this.cursor = 0;
        this.render();
        return false;
      case '\x0b': // Ctrl+K 删到行尾
        this.buf = this.buf.slice(0, this.cursor);
        this.render();
        return false;
      case '\x17': { // Ctrl+W 删一个词
        const left = this.buf.slice(0, this.cursor).replace(/\s*\S+\s*$/, '');
        this.buf = left + this.buf.slice(this.cursor);
        this.cursor = left.length;
        this.render();
        return false;
      }
      case '\x01': // Ctrl+A
        this.cursor = 0;
        this.render();
        return false;
      case '\x05': // Ctrl+E
        this.cursor = this.buf.length;
        this.render();
        return false;
      case '\x0c': // Ctrl+L 清屏
        process.stdout.write('\x1b[2J\x1b[H');
        this.render();
        return false;
      case '\t':
        this.complete();
        return false;
      default:
        if (ch >= ' ' || ch === '\t') {
          this.buf = this.buf.slice(0, this.cursor) + ch + this.buf.slice(this.cursor);
          this.cursor += ch.length;
          this.render();
        }
        return false;
    }
  }

  private handleSeq(seq: string): void {
    if (seq === '\x1b[A') return this.historyPrev();
    if (seq === '\x1b[B') return this.historyNext();
    if (seq === '\x1b[C') {
      if (this.cursor < this.buf.length) {
        this.cursor++;
        this.render();
      }
      return;
    }
    if (seq === '\x1b[D') {
      if (this.cursor > 0) {
        this.cursor--;
        this.render();
      }
      return;
    }
    if (seq === '\x1b[H' || seq === '\x1b[1~' || seq === '\x1bOH') {
      this.cursor = 0;
      this.render();
      return;
    }
    if (seq === '\x1b[F' || seq === '\x1b[4~' || seq === '\x1bOF') {
      this.cursor = this.buf.length;
      this.render();
      return;
    }
    if (seq === '\x1b[3~') {
      this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1);
      this.render();
    }
  }

  private historyPrev(): void {
    if (!this.history.length) return;
    if (this.histIndex === -1) {
      this.saved = this.buf;
      this.histIndex = this.history.length - 1;
    } else if (this.histIndex > 0) {
      this.histIndex--;
    }
    this.buf = this.history[this.histIndex];
    this.cursor = this.buf.length;
    this.render();
  }

  private historyNext(): void {
    if (this.histIndex === -1) return;
    if (this.histIndex < this.history.length - 1) {
      this.histIndex++;
      this.buf = this.history[this.histIndex];
    } else {
      this.histIndex = -1;
      this.buf = this.saved;
    }
    this.cursor = this.buf.length;
    this.render();
  }

  private complete(): void {
    const cwd = this.getCwd ? this.getCwd() : process.cwd();
    const isDir = (candidate: string): boolean => {
      try {
        const full = path.resolve(cwd, candidate.replace(/^~/, os.homedir()));
        return fs.existsSync(full) && fs.statSync(full).isDirectory();
      } catch {
        return false;
      }
    };

    const out = resolveCompletion(this.buf, this.cursor, this.completer(this.buf, this.cursor), isDir);
    if (!out) return;

    this.buf = out.buf;
    this.cursor = out.cursor;
    if (out.list) process.stdout.write('\r\n' + out.list.join('  ') + '\r\n');
    this.render();
  }
}

export type CompletionOutcome = {
  /** 补完之后缓冲区的内容 */
  buf: string;
  /** 补完之后光标的位置 */
  cursor: number;
  /** 补不动了、需要摊开给用户看的候选；不需要列时为 null */
  list: string[] | null;
};

/**
 * 补全决策：算出「按一下 Tab 之后，输入行该变成什么样」。
 *
 * 刻意拆成不做 IO 的纯函数 —— 补全一按键就改写用户输入，回归成本高，
 * 必须能直接对它写单测。目录判断通过 isDir 注进来。
 */
export function resolveCompletion(
  buf: string,
  cursor: number,
  candidates: string[],
  isDir: (candidate: string) => boolean = () => false,
): CompletionOutcome | null {
  if (!candidates.length) return null;

  const before = buf.slice(0, cursor);
  const after = buf.slice(cursor);
  const wordStart = Math.max(before.lastIndexOf(' ') + 1, 0);
  const base = before.slice(0, wordStart);
  const word = before.slice(wordStart);
  const isCommand = wordStart === 0;

  if (candidates.length === 1) {
    let add = candidates[0];
    if (isDir(add)) {
      // 目录补 '/' 结尾，接着就能补下一层
      if (!add.endsWith('/')) add += '/';
    } else if (isCommand && !add.endsWith(' ')) {
      // 命令名已经补到唯一解，跟一个空格，方便接着敲参数
      add += ' ';
    }
    return { buf: base + add + after, cursor: (base + add).length, list: null };
  }

  // 多个候选：先补到「最长公共前缀」。候选按常用度排序，但补全只认共同部分，
  // 不替用户做选择 —— 只有敲到能唯一定位时才落定。
  const lcp = longestCommonPrefix(candidates);
  if (lcp.length > word.length) {
    return { buf: base + lcp + after, cursor: (base + lcp).length, list: null };
  }

  // 已经补不动了：把候选摊开，顺序即常用度顺序（最常用的在最前）
  return { buf, cursor, list: candidates.slice(0, 40) };
}

/** 一组候选的最长公共前缀；空数组返回空串 */
export function longestCommonPrefix(items: string[]): string {
  if (!items.length) return '';
  let prefix = items[0];
  for (let i = 1; i < items.length && prefix; i++) {
    let j = 0;
    while (j < prefix.length && j < items[i].length && prefix[j] === items[i][j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

/**
 * 远端输出插屏方案（纯函数，便于单测）：算出这次该往终端写哪些字节。
 *
 * - `protect=false`（没有输入行要保护）→ 原样写，一个字节都不动；
 * - 纯控制序列（远端 readline 的 bracketed paste 开关 `\x1b[?2004h/l` 之类）
 *   → 返回空串，直接丢掉。留着它们只会挪动光标、把提示符顶掉；
 * - 其余内容：先 `\r\x1b[2K` 清掉当前行再写输出。输出不以**换行**收尾时要补
 *   `\r\n`，否则后面的重绘会把这半行内容一起清掉（比如 `Password: ` 这种等输入
 *   的提示）。裸 `\r` 不算收尾——它只是回到行首，内容还在那一行上。
 *
 * 注意：这里**不含**重画提示符，那一步由 LineEditor.render() 负责。
 */
export function externalOutputBytes(chunk: string, protect: boolean): string {
  if (!protect) return chunk;
  if (!stripAnsi(chunk).trim()) return '';
  const tail = /\r?\n$/.test(chunk) ? '' : '\r\n';
  return '\r\x1b[2K' + chunk + tail;
}

const SEQ_RE = /^\x1b(\[[0-9;?]*[a-zA-Z~]|O[A-Za-z]|[A-Za-z])/;

function matchSeq(buf: string): string | null {
  // 单独的 \x1b 需要再等等
  if (buf.length === 1) return null;
  const m = SEQ_RE.exec(buf);
  if (m) return m[0];
  // 可能是 \x1b[ 后面数字还没收全
  if (/^\x1b\[[0-9;?]*$/.test(buf)) return null;
  return buf.slice(0, 1);
}
