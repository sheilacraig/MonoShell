export type SessionKind = 'local' | 'ssh';

/** 命令拼接语义差异：cmd 用 & 且没有 $?，powershell / unix 用 ; */
export type ShellType = 'cmd' | 'powershell' | 'unix';

/**
 * 会话的描述性信息（没有 IO 能力）。
 * Agent / systemPrompt 这类「只需要知道自己在哪种环境里」的消费者收这个，
 * 不必硬塞一个全是 noop 的完整 Session。
 */
export interface SessionContext {
  readonly kind: SessionKind;
  /** 展示用的标识，例如 local:pwsh 或 ssh:prod */
  readonly label: string;
  /** 目标系统类型，决定注入哪种 shell integration 脚本 */
  readonly osFamily: 'windows' | 'unix';
  /** 决定命令拼接与退出码取法 */
  readonly shellType: ShellType;
  /**
   * 提交一行用的行结束符。
   * Windows 控制台下 \n 会被 PowerShell 当成续行（出现 >> 提示符），必须发 \r。
   */
  readonly eol: string;
}

/**
 * 统一的会话抽象。本地 PTY 和 SSH shell 通道对外表现一致，
 * 上层（分类器 / Agent / UI）完全不需要知道自己连的是哪一边。
 */
export interface Session extends SessionContext {
  write(data: string): void;
  onData(cb: (data: string) => void): void;
  resize(cols: number, rows: number): void;
  close(): void;
  /** 会话结束（shell 退出 / 连接断开）时触发 */
  onExit(cb: (code: number | null, signal: number | null) => void): void;
}

export function termSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 120,
    rows: process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 30,
  };
}
