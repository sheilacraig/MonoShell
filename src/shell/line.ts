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
  private stdin = process.stdin;

  constructor(
    private promptFn: () => string,
    private history: string[],
    private completer: Completer,
    private getCwd?: () => string,
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
    const candidates = this.completer(this.buf, this.cursor);
    if (!candidates.length) return;
    if (candidates.length === 1) {
      const before = this.buf.slice(0, this.cursor);
      const after = this.buf.slice(this.cursor);
      const wordStart = Math.max(before.lastIndexOf(' ') + 1, 0);
      const base = before.slice(0, wordStart);
      let add = candidates[0];
      // 目录补 '/' 结尾
      const cwd = this.getCwd ? this.getCwd() : process.cwd();
      const full = path.resolve(cwd, add.replace(/^~/, os.homedir()));
      try {
        if (fs.existsSync(full) && fs.statSync(full).isDirectory() && !add.endsWith('/')) add += '/';
      } catch {
        /* noop */
      }
      this.buf = base + add + after;
      this.cursor = (base + add).length;
      this.render();
      return;
    }
    // 多个候选：列出
    process.stdout.write('\r\n' + candidates.slice(0, 40).join('  ') + '\r\n');
    this.render();
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
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
