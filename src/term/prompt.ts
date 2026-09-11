/**
 * 通用终端提问：问一行，hidden=true 时不回显（用于密码）。
 * 从 cli/hosts.ts 挪来 —— 它是终端 IO 原语，不是 SSH 主机管理的职责。
 */

/** 提问函数签名：便于向导 / 选择器在测试时注入假输入 */
export type Asker = (question: string, hidden?: boolean) => Promise<string>;

export function promptLine(q: string, hidden = false): Promise<string> {
  process.stdout.write(q);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    } else {
      stdin.setEncoding('utf8');
    }
    stdin.resume();
    let buf = '';
    const onData = (d: Buffer | string) => {
      const s = typeof d === 'string' ? d : d.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\r\n');
          resolve(buf);
          return;
        }
        if (ch === '\x03') {
          cleanup();
          process.stdout.write('^C\r\n');
          process.exit(130);
        }
        if (ch === '\x7f' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            if (!hidden) process.stdout.write('\b \b');
          }
          continue;
        }
        buf += ch;
        if (!hidden) process.stdout.write(ch);
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.pause();
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
    };
    stdin.on('data', onData);
  });
}
