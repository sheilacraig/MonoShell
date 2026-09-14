import fs from 'node:fs';
import os from 'node:os';
import { Client } from 'ssh2';
import type { SshHost } from '../config.js';
import type { Session } from './types.js';
import { termSize } from './types.js';

export function createSshSession(host: SshHost): Promise<Session> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const { cols, rows } = termSize();

    const connectCfg: Record<string, unknown> = {
      host: host.host,
      port: host.port ?? 22,
      username: host.username,
      tryKeyboard: true,
    };
    if (host.privateKeyPath) {
      try {
        connectCfg.privateKey = fs.readFileSync(
          host.privateKeyPath.replace(/^~/, os.homedir()),
          'utf8',
        );
        if (host.passphrase) connectCfg.passphrase = host.passphrase;
      } catch {
        /* 回退到密码 */
      }
    }
    if (host.password) connectCfg.password = host.password;

    let settled = false;

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          settled = true;
          conn.end();
          reject(err);
          return;
        }
        const listeners: ((data: string) => void)[] = [];
        const exitListeners: ((code: number | null, signal: number | null) => void)[] = [];

        stream.on('data', (d: Buffer) => {
          for (const l of listeners) l(d.toString('utf8'));
        });
        stream.on('close', () => {
          for (const l of exitListeners) l(0, null);
        });

        const session: Session = {
          kind: 'ssh',
          label: `ssh:${host.name}`,
          osFamily: 'unix',
          shellType: 'unix',
          // 目标固定为 Ubuntu / Linux，行结束符用 \n
          eol: '\n',
          write: (d) => stream.write(d),
          onData: (cb) => listeners.push(cb),
          resize: (c, r) => {
            try {
              stream.setWindow(r, c, 0, 0);
            } catch {
              /* noop */
            }
          },
          close: () => {
            try {
              stream.end();
            } catch {
              /* noop */
            }
            conn.end();
          },
          onExit: (cb) => exitListeners.push(cb),
          execQuery: (cmd: string, timeoutMs = 2000) =>
            new Promise<string>((resolve) => {
              let timer: NodeJS.Timeout | null = null;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let streamRef: any = null;
              const done = (out: string) => {
                if (timer) {
                  clearTimeout(timer);
                  timer = null;
                }
                resolve(out);
              };
              timer = setTimeout(() => {
                try {
                  streamRef?.close();
                } catch {
                  /* noop */
                }
                done('');
              }, timeoutMs);

              try {
                conn.exec(cmd, (err, s) => {
                  if (err) return done('');
                  streamRef = s;
                  let out = '';
                  s.on('data', (d: Buffer) => {
                    out += d.toString('utf8');
                  });
                  s.on('close', () => done(out));
                  s.on('error', () => done(''));
                });
              } catch {
                done('');
              }
            }),
        };

        settled = true;
        // 登录后执行 startup 命令（如 sudo su - / cd /data）
        if (host.startup?.length) {
          setTimeout(() => {
            for (const c of host.startup!) session.write(c + '\n');
          }, 400);
        }
        resolve(session);
      });
    });

    conn.on('keyboard-interactive', (_n, _i, _l, _p, finish) => {
      if (host.password) finish([host.password]);
      else finish([]);
    });

    conn.on('error', (e: Error) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });

    conn.connect(connectCfg as never);
  });
}
