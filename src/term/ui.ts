import type { AppConfig } from '../config.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

/**
 * 输入总线：终端输入在「透传给 shell」和「被 UI 接管」之间切换。
 * AI 提问时 shell 仍在等待输入，但字符不会转发过去，避免串味。
 */
export class InputHub {
  private reader: ((data: string) => void) | null = null;
  private stdin: NodeJS.ReadStream;
  private listening = false;
  private onData = (d: Buffer | string) => {
    const s = typeof d === 'string' ? d : d.toString('utf8');
    this.reader?.(s);
  };

  constructor(stdin: NodeJS.ReadStream = process.stdin) {
    this.stdin = stdin;
  }

  take(cb: (data: string) => void): void {
    this.reader = cb;
    if (!this.listening) {
      this.stdin.on('data', this.onData);
      this.listening = true;
    }
    this.stdin.resume();
  }

  release(): void {
    this.reader = null;
    if (this.listening) {
      this.stdin.removeListener('data', this.onData);
      this.listening = false;
    }
    this.stdin.pause();
  }

  /** 返回 true 表示数据已被 UI 消费，不应再转发给 shell */
  push(data: string): boolean {
    if (!this.reader) return false;
    this.reader(data);
    return true;
  }

  get busy(): boolean {
    return this.reader !== null;
  }
}

export class TerminalUI {
  constructor(
    private cfg: AppConfig,
    private hub: InputHub,
  ) {}

  /**
   * AI 的说明行。刻意做成注释风格而不是聊天气泡，
   * 保证整个界面始终是一个终端，不出现分栏。
   */
  note(text: string): void {
    const p = this.cfg.ui.notePrefix || '· ';
    process.stdout.write(`\r\n${DIM}${p}${text}${RESET}\r\n`);
  }

  warn(text: string): void {
    process.stdout.write(`\r\n${YELLOW}${this.cfg.ui.notePrefix || '· '}${text}${RESET}\r\n`);
  }

  error(text: string): void {
    process.stdout.write(`\r\n${RED}${this.cfg.ui.notePrefix || '· '}${text}${RESET}\r\n`);
  }

  private readKeys(onChar: (ch: string) => void, onCancel: () => void): void {
    this.hub.take((data) => {
      for (const ch of data) {
        if (ch === '\x03') {
          this.hub.release();
          onCancel();
          return;
        }
        onChar(ch);
      }
    });
  }

  /** 高危命令二次确认：y 执行 / N 取消 / e 编辑 */
  confirm(command: string, reason: string): Promise<'yes' | 'no' | 'edit'> {
    return new Promise((resolve) => {
      process.stdout.write(
        `\r\n${YELLOW}${BOLD}危险命令确认${RESET} ${DIM}(${reason})${RESET}\r\n` +
          `  ${CYAN}${command}${RESET}\r\n` +
          `  ${DIM}这条命令会真的执行，由你决定：${RESET}${BOLD}y${RESET} 执行   ${BOLD}N${RESET} 取消(默认)   ${BOLD}e${RESET} 改成别的   `,
      );

      this.readKeys(
        (ch) => {
          if (ch === 'y' || ch === 'Y') {
            this.hub.release();
            process.stdout.write('y\r\n');
            resolve('yes');
          } else if (ch === 'e' || ch === 'E') {
            this.hub.release();
            process.stdout.write('e\r\n');
            resolve('edit');
          } else if (ch === '\r' || ch === '\n' || ch === 'n' || ch === 'N' || ch === 'q') {
            this.hub.release();
            process.stdout.write('n\r\n');
            resolve('no');
          }
        },
        () => {
          this.hub.release();
          process.stdout.write('^C\r\n');
          resolve('no');
        },
      );
    });
  }

  /**
   * 需要用户手动输入密码时的提示。
   * 与「危险命令确认」刻意分开：这不是风险问题，而是「AI 的捕获通道拿不到 TTY」
   * 的能力边界。首选是把命令交回用户自己的终端执行——密码提示出来自己输。
   */
  needAuth(command: string, hint: string, fix?: string): Promise<'yes' | 'no' | 'edit'> {
    return new Promise((resolve) => {
      process.stdout.write(
        `\r\n${YELLOW}${BOLD}这条命令需要你在终端里输密码${RESET} ${DIM}(${hint})${RESET}\r\n` +
          `  ${CYAN}${command}${RESET}\r\n` +
          `  ${DIM}AI 的捕获通道拿不到 TTY，代跑只会卡在密码提示上。交回你的终端执行，密码提示出来自己输即可。${RESET}\r\n` +
          (fix ? `  ${DIM}${fix}${RESET}\r\n` : '') +
          `  ${BOLD}y${RESET} 在本终端执行   ${BOLD}N${RESET} 跳过(默认)   ${BOLD}e${RESET} 改成别的命令   `,
      );

      this.readKeys(
        (ch) => {
          if (ch === 'y' || ch === 'Y') {
            this.hub.release();
            process.stdout.write('y\r\n');
            resolve('yes');
          } else if (ch === 'e' || ch === 'E') {
            this.hub.release();
            process.stdout.write('e\r\n');
            resolve('edit');
          } else if (ch === '\r' || ch === '\n' || ch === 'n' || ch === 'N' || ch === 'q') {
            this.hub.release();
            process.stdout.write('n\r\n');
            resolve('no');
          }
        },
        () => {
          this.hub.release();
          process.stdout.write('^C\r\n');
          resolve('no');
        },
      );
    });
  }

  /** 让用户在预填的命令基础上改，回车提交，Esc / Ctrl+C 取消 */
  editCommand(initial: string): Promise<string | null> {
    return new Promise((resolve) => {
      process.stdout.write(`  改成: `);
      let buf = initial;
      process.stdout.write(buf);

      // 不走 readKeys：方向键等功能键是 \x1b[... 多字节序列，
      // 逐字符处理时第一个 \x1b 就会被误判成「按了 Esc」而取消编辑。
      // 只有整块数据恰好是一个 \x1b 才算真按了 Esc，其余序列整体剥掉。
      this.hub.take((data) => {
        if (data === '\x1b') {
          this.hub.release();
          process.stdout.write('\r\n');
          resolve(null);
          return;
        }
        const cleaned = data.replace(/\x1b(\[[0-9;?]*[a-zA-Z~]|O[A-Za-z])/g, '');
        for (const ch of cleaned) {
          if (ch === '\x03') {
            this.hub.release();
            process.stdout.write('\r\n');
            resolve(null);
            return;
          }
          if (ch === '\r' || ch === '\n') {
            this.hub.release();
            process.stdout.write('\r\n');
            resolve(buf.trim() || null);
            return;
          }
          if (ch === '\x7f' || ch === '\b') {
            if (buf.length) {
              buf = buf.slice(0, -1);
              process.stdout.write('\b \b');
            }
            continue;
          }
          if (ch === '\x15') {
            // Ctrl+U 清空
            for (let i = 0; i < buf.length; i++) process.stdout.write('\b \b');
            buf = '';
            continue;
          }
          if (ch >= ' ' || ch === '\t') {
            buf += ch;
            process.stdout.write(ch);
          }
        }
      });
    });
  }
}
