import type { Session, ShellType } from '../session/types.js';

export type ExecResult = {
  output: string;
  exitCode: number;
  timedOut: boolean;
};

// 退出码可能为空（例如 PowerShell 里 $LASTEXITCODE 未赋值），所以允许 \d*
const MARKER_RE_TAIL = /__AIX_[a-z0-9]{6}__:\d*/g;

function randId(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** 拼装带输出捕获标记的命令；返回标记本体与需要回显剔除的片段 */
export function buildWrapped(
  command: string,
  id: string,
  shell: ShellType,
): { full: string; markerPart: string } {
  const m = `__AIX_${id}__`;
  if (shell === 'cmd') {
    const markerPart = ` & if errorlevel 1 (echo ${m}:1) else (echo ${m}:0)`;
    return { full: `${command}${markerPart}`, markerPart };
  }
  if (shell === 'powershell') {
    // 用 $? 而不是 $LASTEXITCODE：后者只对原生进程赋值，cmdlet 执行后为 $null
    const markerPart = `; if ($?) { echo "${m}:0" } else { echo "${m}:1" }`;
    return { full: `${command}${markerPart}`, markerPart };
  }
  const markerPart = `; echo "${m}:$?"`;
  return { full: `${command}${markerPart}`, markerPart };
}

/**
 * 回显里标记片段的起始特征 —— 从这里一直到行尾都是我们要删的。
 * 不能按整串匹配：PowerShell 有语法高亮，回显的标记中间会被 ANSI 序列打断，
 * 整串匹配必然失败。「起始特征 + 吃到行尾」对有无高亮都成立。
 */
function echoTailPattern(shell: ShellType, m: string): RegExp {
  if (shell === 'powershell') {
    return new RegExp(`;\\s*if\\s*\\(\\$\\?\\)\\s*\\{[^\\r\\n]*`, 'g');
  }
  if (shell === 'cmd') {
    return new RegExp(`\\s*&\\s*if\\s+errorlevel[^\\r\\n]*`, 'g');
  }
  return new RegExp(`;\\s*echo\\s+"?${m}[^\\r\\n]*`, 'g');
}

/**
 * 流式擦除器：把回显里的标记片段、以及标记输出行从流中剔除，
 * 让用户看到的终端输出和「自己手敲这条命令」基本一致。
 */
class Scrubber {
  private pending = '';
  private markerLine: RegExp;

  constructor(
    private echoTail: RegExp,
    private marker: string,
    private keepLen: number,
  ) {
    this.markerLine = new RegExp(`[^\\r\\n]*${marker}:\\d*[^\\r\\n]*\\r?\\n?`, 'g');
  }

  private clean(s: string): string {
    return s.replace(this.echoTail, '').replace(this.markerLine, '');
  }

  push(chunk: string): string {
    const buf = this.pending + chunk;
    const out = this.clean(buf);
    // 块边界可能切断标记，尾部留一小段下回合拼
    const keep = Math.min(out.length, this.keepLen);
    this.pending = out.slice(out.length - keep);
    return out.slice(0, out.length - keep);
  }

  flush(): string {
    const out = this.clean(this.pending);
    this.pending = '';
    return out;
  }
}

export type CaptureHandle = {
  /** 实际发给 shell 的完整命令（原始命令 + 标记），便于日志与排错 */
  full: string;
  /** 把一块输出交给捕获器处理，返回应当显示给用户的部分 */
  feed(chunk: string): string;
  result: Promise<ExecResult>;
  abort(): void;
};

/**
 * 执行一次命令并捕获其输出。
 * 关键点：只有 AI 发起的命令才走这里，用户手敲的命令完全透传、零开销。
 */
export function captureExec(
  session: Session,
  command: string,
  shell: ShellType,
  timeoutMs = 30000,
  opts: {
    /** 擦除后该显示给用户的内容走这个回调，保证尾部缓冲结束时也会吐出来 */
    emit?: (s: string) => void;
    /** 远端已关闭回显时不要跳过第一行，否则会吞掉真实输出 */
    skipEcho?: boolean;
  } = {},
): CaptureHandle {
  const id = randId();
  const { full, markerPart } = buildWrapped(command, id, shell);
  const marker = `__AIX_${id}__`;
  const scrubber = new Scrubber(
    echoTailPattern(shell, marker),
    marker,
    markerPart.length + 16,
  );

  let collected = '';
  let done = false;
  let echoSkipped = false;
  let timer: NodeJS.Timeout | null = null;

  let resolveFn!: (r: ExecResult) => void;
  const result = new Promise<ExecResult>((res) => {
    resolveFn = res;
  });

  const finish = (exitCode: number, timedOut: boolean) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    const tail = scrubber.flush();
    if (tail) {
      collected += tail;
      opts.emit?.(tail);
    }
    resolveFn({ output: cleanOutput(collected), exitCode, timedOut });
  };

  timer = setTimeout(() => {
    // 超时：发送 Ctrl+C 尽量中断卡住的命令
    try {
      session.write('\x03');
    } catch {
      /* noop */
    }
    finish(-1, true);
  }, timeoutMs);

  const handle: CaptureHandle = {
    full,
    feed(chunk) {
      if (done) return chunk;

      // 可选跳过命令回显：回显里的 marker 字面量会被误当成真实输出，
      // 导致命令还没跑完就判定完成。仅在远端确实会回显时开启。
      if (opts.skipEcho && !echoSkipped) {
        const i = chunk.search(/\r|\n/);
        if (i < 0) return '';
        echoSkipped = true;
        chunk = chunk.slice(i + 1);
        if (!chunk) return '';
      }

      collected += chunk;
      const m = new RegExp(`${marker}:(-?\\d*)`).exec(collected);
      if (m) {
        // 输出已完整，交给 finish 做最终清理；退出码为空按 0 处理
        finish(m[1] === '' || m[1] === '-' ? 0 : Number(m[1]), false);
      }
      return scrubber.push(chunk);
    },
    result,
    abort() {
      finish(-1, false);
    },
  };

  // 由捕获器自己发送，避免调用方漏发标记导致永远等不到结果
  session.write(full + session.eol);

  return handle;
}

/** 去掉 ANSI 转义序列，得到喂给 LLM 的干净文本 */
export function cleanOutput(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(MARKER_RE_TAIL, '')
    .trim();
}
