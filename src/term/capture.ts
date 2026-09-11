import type { Session, ShellType } from '../session/types.js';
import { sniffPasswordPrompt } from '../core/safety.js';

export type ExecResult = {
  output: string;
  exitCode: number;
  timedOut: boolean;
  /** 命令卡在「等密码 / 等交互输入」上被提前中断 */
  needsInput?: boolean;
  /** 嗅到的提示文本，如 `[sudo] password for wyzd:` */
  promptText?: string;
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
    const markerPart = ` & set "__m=${m}" & if errorlevel 1 (call echo %__m%:1) else (call echo %__m%:0)`;
    return { full: `${command}${markerPart}`, markerPart };
  }
  if (shell === 'powershell') {
    const markerPart = `; $__m="${m}"; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { echo "$($__m):$LASTEXITCODE" } elseif ($?) { echo "$($__m):0" } else { echo "$($__m):1" }`;
    return { full: `${command}${markerPart}`, markerPart };
  }
  const markerPart = `; __m="${m}"; echo "$__m:$?"`;
  return { full: `${command}${markerPart}`, markerPart };
}

/**
 * 回显整行的擦除式样。
 *
 * 不能按整串匹配：PowerShell 有语法高亮，回显的标记中间会被 ANSI 序列打断，
 * 整串匹配必然失败。所以只锚定「行首 → 标记起点 → 行尾」这条骨架，
 * 对有无高亮都成立。
 */
function echoTailPattern(shell: ShellType, m: string): RegExp {
  // 两个要点：
  // 1) 从行首开删（`^` + `m` 标志）。回显是独占一行的整条命令，而 MonoShell
  //    自己已经打印过 `$ cmd` 了，留下半截反而更乱；而且只有整行一起删，
  //    被折行切开的另一半才不会跟残留内容粘成 `df -h$?"` 这种怪物。
  // 2) 末尾的 `\r?\n?` 必须吃掉。只删本行内容不删换行，屏幕上会多出一个空行。
  if (shell === 'powershell') {
    return new RegExp(`^[^\\r\\n]*?;\\s*\\$__m\\s*=[^\\r\\n]*\\r?\\n?`, 'gm');
  }
  if (shell === 'cmd') {
    return new RegExp(`^[^\\r\\n]*?\\s*&\\s*set\\s+"__m=[^\\r\\n]*\\r?\\n?`, 'gm');
  }
  return new RegExp(`^[^\\r\\n]*?;\\s*__m="?${m}[^\\r\\n]*\\r?\\n?`, 'gm');
}

/**
 * 流式擦除器：把回显里的标记片段、以及标记输出行从流中剔除，
 * 让用户看到的终端输出和「自己手敲这条命令」基本一致。
 */
/**
 * 兜底擦除：命令回显被终端折行（CR/LF）截断时，
 * `; __m="__AIX_xxx__` 那一段能匹配上，但折行之后的 `"; echo "$__m:$?` 会残留。
 * 这里再扫一遍含标记 / `$__m:` 的整行片段，把残渣清掉。
 * 真实命令输出几乎不可能包含 `__AIX_` 或 `$__m:`，误伤概率极低。
 */
const RESIDUE_RE = /[^\r\n]*(?:__AIX_[a-z0-9]{6}__|\$\{?__m\}?:)[^\r\n]*\r?\n?/g;

/**
 * 最后一道兜底：回显被折行拦腰截断后剩下的碎片。
 *
 * 折断点如果落在 `$__m` 中间（例如 `...echo "$__m:` | `$?"`），残渣里既不含
 * `__AIX_` 也不含完整的 `$__m:`，上面两条规则都够不着它，屏幕上就会留下
 * `$?"` 这种看不懂的东西。这类残渣有个共同点：**整行只由标记模板里出现过的
 * 符号组成**（`$ ? " ; : { } _ m \` 和空白）。正常的命令输出不会长这样，
 * 所以可以放心按整行清掉。
 *
 * 两个细节，错了就会误伤：
 * - 必须是整行（结尾用 `(?:\r?\n|$)` 收口）。只写「行首若干符号」会把
 *   `\u@\h:\w$ ...` 这类行开头的反斜杠啃掉一个字符。
 * - 字符集里不放 `=`，否则 `===` / `---` 这类分隔线会被当成残渣删掉。
 */
const ECHO_TAIL_RE = /^[ \t]*[$?";:{}_m\\]+[ \t]*(?:\r?\n|$)/gm;

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
    return s
      .replace(this.echoTail, '')
      .replace(this.markerLine, '')
      .replace(RESIDUE_RE, '')
      .replace(ECHO_TAIL_RE, '');
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
    /**
     * 嗅到「等密码 / 等交互输入」的提示就立刻中断，不干等 timeoutMs。
     * 默认开启：这类命令注定拿不到结果，早中断早告诉用户去手敲。
     */
    abortOnPrompt?: boolean;
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

  /** 原始流：只用来判定标记 / 嗅探密码提示，不直接展示 */
  let collected = '';
  /** 擦除后的流：用户看到的，同时也是回喂给模型的那一份 */
  let visible = '';
  let done = false;
  let echoSkipped = false;
  /** skipEcho 时攒回显行的缓冲：TCP 分包可能把回显行切开，没收到换行前不能丢 */
  let echoBuf = '';
  let timer: NodeJS.Timeout | null = null;

  let resolveFn!: (r: ExecResult) => void;
  const result = new Promise<ExecResult>((res) => {
    resolveFn = res;
  });

  const finish = (exitCode: number, timedOut: boolean, extra?: Partial<ExecResult>) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    const tail = scrubber.flush();
    if (tail) {
      // tail 是擦除器里最后一批未吐出的内容，只并入 visible。
      // （collected 是原始流，早已逐块累积过，这里再加一次会让喂给模型的
      //  输出尾部重复一遍。）
      visible += tail;
      opts.emit?.(tail);
    }
    resolveFn({ output: cleanOutput(visible), exitCode, timedOut, ...extra });
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
      if (done) return '';

      // 可选跳过命令回显：回显里的 marker 字面量会被误当成真实输出，
      // 导致命令还没跑完就判定完成。仅在远端确实会回显时开启。
      // 回显行可能被 TCP 分包切开：没收到行尾换行前攒着，直接丢会吞掉真实输出。
      if (opts.skipEcho && !echoSkipped) {
        echoBuf += chunk;
        const m = /\r\n|\r|\n/.exec(echoBuf);
        if (!m) return '';
        echoSkipped = true;
        chunk = echoBuf.slice(m.index + m[0].length);
        echoBuf = '';
        if (!chunk) return '';
      }

      collected += chunk;

      // 先过擦除器再判完成：否则最后一块里的真实输出只进了 collected（喂给模型），
      // 却没进用户可见的流 —— 用户会看不到最后一行。
      const visibleNow = scrubber.push(chunk);
      visible += visibleNow;
      const markerRe = new RegExp(`${marker}:(\\d*)`);

      // 等密码就立刻收手：发出 Ctrl+C 解除远端阻塞，把情况告诉上层
      if (opts.abortOnPrompt !== false && !markerRe.test(collected)) {
        const prompt = sniffPasswordPrompt(collected);
        if (prompt) {
          try {
            session.write('\x03');
          } catch {
            /* noop */
          }
          finish(-1, false, { needsInput: true, promptText: prompt });
          return visibleNow;
        }
      }

      const m = markerRe.exec(collected);
      if (m) {
        // 输出已完整，交给 finish 做最终清理；退出码为空按 0 处理
        finish(m[1] === '' || m[1] === '-' ? 0 : Number(m[1]), false);
      }
      return visibleNow;
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
