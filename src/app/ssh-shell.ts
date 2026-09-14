import type { AppConfig } from '../config.js';
import { createSshSession } from '../session/ssh.js';
import { markerRe, normalizeForMatch, stripAnsi, tailAfterMarker } from '../session/handshake.js';
import type { Session } from '../session/types.js';
import { captureExec, type ExecResult } from '../term/capture.js';
import { promptLine } from '../term/prompt.js';
import { makeRemoteCompleter } from '../shell/complete.js';
import { getUsage } from '../shell/usage.js';
import { repl } from './repl.js';

/** 独立调用（ai --ssh x / ai ssh use x）时 standalone=true，会直接结束进程；选择器里调用则为 false */
export async function runSshShell(cfg: AppConfig, name: string, standalone = true): Promise<boolean> {
  const host = cfg.ssh.hosts.find((h) => h.name === name);
  if (!host) {
    process.stderr.write(`没有保存的连接：${name}\n`);
    if (cfg.ssh.hosts.length) {
      process.stderr.write(`可选：${cfg.ssh.hosts.map((h) => h.name).join(', ')}\n`);
    } else {
      process.stderr.write('先用 ai ssh add 添加一个连接。\n');
    }
    if (standalone) process.exitCode = 1;
    return false;
  }
  if (!host.password && !host.privateKeyPath) {
    host.password = await promptLine(`${host.username}@${host.host} 密码 (不回显): `, true);
  }

  process.stdout.write(`\x1b[2m连接 ${host.username}@${host.host}:${host.port ?? 22} ...\x1b[0m\r\n`);
  let session: Session;
  try {
    session = await createSshSession(host);
  } catch (e) {
    process.stderr.write(`连接失败：${(e as Error).message}\n`);
    if (standalone) process.exitCode = 1;
    return false;
  }

  let activeCapture: ReturnType<typeof captureExec> | null = null;
  /** 正在等的那次 settle 的放行函数：Ctrl+C 时立刻放行，不让提示符白等 */
  let activeSettleResolve: (() => void) | null = null;
  let closedByRemote = false;
  const history: string[] = [];
  /** 远端最近一次来数据的时间，用来判断远端是否安静 */
  let lastDataAt = 0;
  /**
   * 远端输出落屏的出口：repl 起来之前直接写；repl 起来之后交给行编辑器，
   * 由它决定要不要先清掉本地提示符那一行（见 LineEditor.writeExternal）。
   */
  let writeRemote: ((s: string) => void) | null = null;
  const showRemote = (s: string) => {
    if (writeRemote) writeRemote(s);
    else process.stdout.write(s);
  };

  /**
   * 等远端安静下来再画下一个提示符：
   * - 连接已关闭 → 立刻返回
   * - 本窗口内来过数据、且已 60ms 没有新数据 → 视为安静，返回
   * - 超过 maxMs 兜底返回（持续输出的命令如 tail -f 不能一直等）
   *
   * 不等这一拍的话：提示符先画出去，命令的即时输出（logout 提示、后台日志）
   * 后到把它顶掉；敲 exit 时还会先闪一个假提示符、再隔一个网络往返才报
   * 「远端连接已关闭」，看起来像没反应。
   */
  const settle = (maxMs: number) =>
    new Promise<void>((resolve) => {
      const release = () => {
        if (activeSettleResolve === release) activeSettleResolve = null;
        resolve();
      };
      activeSettleResolve = release;
      const startAt = Date.now();
      const initial = lastDataAt;
      const tick = () => {
        const now = Date.now();
        if (closedByRemote || now - startAt >= maxMs) return release();
        const sawData = lastDataAt > initial || lastDataAt > startAt;
        if (sawData && now - lastDataAt >= 60) return release();
        setTimeout(tick, 20);
      };
      tick();
    });

  // ---- 登录握手：等远端 shell 初始化完，再画自己的提示符 ----
  //
  // 远端的登录横幅（Last login / MOTD）、配置命令的回显都是**后到**的，而且
  // 快慢完全取决于远端：固定睡多久都可能被它超过，提示符先画出去就会被顶出
  // 视野。所以改成标记握手：发出配置命令后，等远端真正执行到「回显标记」
  // 才算就绪，期间远端输出一律收着不打印。
  //
  // 两个坑，都是实测踩出来的：
  // 1. zsh 的 zle 会把**收到的输入**重新显示一遍（不受 stty -echo 控制），
  //    所以第二行命令的回显里就带着标记字面量。握手指若按 includes() 判，
  //    会在回显（永远早于执行）上提前触发。两个对策一起上：
  //    - 命令里把标记拆成 __mssh_rea'dy'__，回显里是带引号的残缺版，
  //      执行后才拼出完整标记；
  //    - 匹配要求标记独占一行（行首锚定），命令回显里它跟在 echo 后面，不匹配。
  // 2. 远端登录 shell 可能非常慢（如 conda 的 zsh hook 要好几秒），兜底放行
  //    不能太早，放行了也不能一直静默吞输出——远端 shell 一有差异（见
  //    session/handshake.ts：裸 \r 会把标记顶出行首），吞下去的就是用户敲的
  //    命令的回显和报错，屏幕上只剩黑屏。分两档：8 秒放行进提示符，同时吐出
  //    已收内容并恢复透传；25 秒停止等待标记，提示一句远端 shell 可能不标准。
  const SETUP_MARKER = '__mssh_ready__';
  // 只认「独占一行」的标记输出；回显里的 __mssh_rea'dy'__ 跟在 echo 后面，不匹配。
  // 判定前先规范化（见 session/handshake.ts）：远端 readline 执行命令前会关掉
  // bracketed paste，吐出的 `\x1b[?2004l\r` 是**裸 \r 收尾**，紧接着才是标记；
  // 若只认 \r?\n 作为行首，这个裸 \r 会把标记挡在「行首」之外，标记永远判不到。
  const SETUP_RE = markerRe(SETUP_MARKER);
  // 退出探活标记（同上：命令里拆引号防回显误报，输出行首锚定）
  const PROBE_MARKER = '__mssh_alive__';
  const PROBE_RE = markerRe(PROBE_MARKER);
  let probePhase = false;
  let probeSeen = '';
  let setupPhase = true;
  let setupSeen = '';
  /** 初始化输出是否已经吐出去过（兜底放行时吐的），标记后不再重复打印 */
  let initFlushed = false;
  let finishSetup: (() => void) | null = null;
  let giveUpTimer: NodeJS.Timeout | null = null;
  const setupReady = new Promise<void>((r) => (finishSetup = r));
  // 带 startup 命令（如 sudo su -）的会话不吞初始化输出：sudo 的密码提示必须可见
  let swallow = !host.startup?.length;

  /** 标记到达 / 彻底放弃：结束吞输出，收掉兜底定时器 */
  const endSetup = () => {
    setupPhase = false;
    swallow = false;
    if (giveUpTimer) {
      clearTimeout(giveUpTimer);
      giveUpTimer = null;
    }
    finishSetup?.();
  };

  /**
   * 兜底放行：把一直收着的初始化输出原样吐出来，并恢复透传。
   *
   * 只在远端迟迟不响应标记时才走到（正常情况标记 <1s 就回来）。这里以前有个坑：
   * 兜底只放行提示符、输出继续吞，标记一旦因远端差异判不到，用户敲的命令就
   * 石沉大海——没有回显、没有报错，直到 25 秒后才恢复透传。宁可把登录横幅和
   * 配置命令回显多打一遍，也不能让用户对着黑屏敲命令。
   */
  const flushInit = () => {
    if (initFlushed) return;
    initFlushed = true;
    swallow = false;
    const body = setupSeen
      // 标记行与我们的配置命令回显不展示给用户
      .replace(new RegExp('[^\\r\\n]*' + SETUP_MARKER + '[^\\r\\n]*(?:\\r?\\n)?', 'g'), '')
      .split(/\r?\n/)
      .filter((l) => !l.includes('stty -echo 2>/dev/null; PS1=;'))
      .join('\n');
    if (body.trim()) process.stdout.write(body.replace(/\n+$/, '') + '\n');
  };

  session.onData((d) => {
    lastDataAt = Date.now();
    if (setupPhase) {
      // 标记可能被 TCP 分包切开，所以积累后整体判断
      setupSeen += d;
      // 判定用规范化副本（裸 \r / ANSI 重画序列不破坏「行首」），标记本体仍要独占一行
      if (SETUP_RE.test(normalizeForMatch(setupSeen))) {
        endSetup();
        // 标记之后的内容（用户提前敲的命令的输出）照常显示；兜底已吐过就不重复
        if (!initFlushed) {
          const after = tailAfterMarker(setupSeen, SETUP_MARKER);
          if (stripAnsi(after).trim()) process.stdout.write(after);
        }
      } else if (!swallow) {
        showRemote(d);
      }
      return;
    }
    if (probePhase) {
      // 退出探活阶段：探针的回显与输出都吞掉，只等标记
      probeSeen += d;
      if (PROBE_RE.test(normalizeForMatch(probeSeen))) {
        probePhase = false;
        const after = tailAfterMarker(probeSeen, PROBE_MARKER);
        if (stripAnsi(after).trim()) process.stdout.write(after);
      }
      return;
    }
    const out = activeCapture ? activeCapture.feed(d) : d;
    showRemote(out);
  });

  // 远端主动断开（如敲了 exit / 网络掉线）：标记后交由 repl 收尾
  let closeCb: (() => void) | undefined;
  session.onExit(() => {
    // 握手没完成就断了，也要放行，否则会卡在等标记上
    if (setupPhase) endSetup();
    probePhase = false;
    if (closedByRemote) return;
    closedByRemote = true;
    process.stdout.write('\r\n\x1b[2m远端连接已关闭。\x1b[0m\r\n');
    closeCb?.();
  });

  /** 等远端关闭通知，最多 ms 毫秒；返回是否等到了 */
  const waitClose = (ms: number) =>
    new Promise<boolean>((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (closedByRemote) return resolve(true);
        if (Date.now() - start >= ms) return resolve(false);
        setTimeout(tick, 30);
      };
      tick();
    });

  /**
   * 敲 exit / logout 后的收尾。远端 shell 的 logout 钩子（conda 之类）可能拖
   * 近十秒才真正退出、才发通道关闭 —— 被动等就是让用户干瞪眼。这里本地做主：
   * 1) 先给远端 1.2s：快的主机直接收到关闭通知，最干脆；
   * 2) 没关就探活：发一条 echo 探针。嵌套 shell（bash / su）里 exit 只退一层，
   *    外层 shell 活着会把探针执行回来 → 回提示符继续用，会话不误杀；
   * 3) 探针无回音、连接也没关 → 顶层 shell 在慢慢退出，本地直接断开。
   */
  const exitHandshake = async (): Promise<void> => {
    if (setupPhase) return; // 远端还没就绪，exit 已在队列里，交给关闭事件收尾
    if (await waitClose(1200)) return;
    probePhase = true;
    probeSeen = '';
    session.write("echo __mssh_ali've'__\n");
    const deadline = Date.now() + 1500;
    while (probePhase && !closedByRemote && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (closedByRemote || !probePhase) return; // 关了 / 外层 shell 活着
    probePhase = false;
    // 顶层 shell 正在慢慢退出：不等它了，本地断开
    closedByRemote = true;
    process.stdout.write('\r\n\x1b[2m远端 shell 退出较慢，已直接断开连接。\x1b[0m\r\n');
    closeCb?.();
  };

  // 关掉远端回显，并把远端提示符清空：输入回显与提示符都由 MonoShell 自己的
  // 行编辑器负责（我们画的是 `wyzd@56 $ `），远端不必再打一份。
  //
  // 这里以前发的是 export PS1="\u@\h:\w\$ "。问题是 \u \h \w 属于 bash 专有转义，
  // 远端登录 shell 若是 sh / dash / ash，它们不会展开，只会把这个串原样印出来，
  // 屏幕上就出现一行 `\u@\h:\w$`；而这个提示符还会被捕获通道收进去、回喂给模型。
  // 直接置空最省事，也不再依赖远端是哪种 shell。
  process.stdout.write('\x1b[2m正在初始化远端 shell ...\x1b[0m\r\n');
  setTimeout(() => {
    session.write("stty -echo 2>/dev/null; PS1=; PS2=; export PS1 PS2\necho __mssh_rea'dy'__\n");
  }, 400);
  // 兜底第一档（8s）：放行进提示符，同时停止吞输出 —— 用户提前敲的命令排在
  // 初始化之后执行，输出本来就该原样显示；万一标记因为远端 shell 差异判不到，
  // 继续静默吞下去就会让用户敲什么都看不到反馈。
  const impatientTimer = setTimeout(() => {
    if (setupPhase) {
      flushInit();
      finishSetup?.();
    }
  }, 8000);
  // 兜底第二档（25s）：标记始终没来，停止等待。此时输出早已透传，只留一句
  // 说明，方便排查「远端不是 bash / sh」这类 shell 差异。
  giveUpTimer = setTimeout(() => {
    giveUpTimer = null;
    if (setupPhase) {
      setupPhase = false;
      flushInit();
      // 走 showRemote 而非裸 process.stdout.write：REPL 已经起来时它会先清掉
      // 当前输入行再写，不会把用户正在敲的内容糊掉、也不会顶乱提示符。
      showRemote(
        '\r\n\x1b[2m远端 shell 未响应初始化标记（可能不是 bash / sh），已按普通模式继续。\x1b[0m\r\n',
      );
    }
  }, 25000);

  const prompt = () => `\x1b[36m${host.username}@${host.name}\x1b[0m \x1b[35m$\x1b[0m `;

  await setupReady;
  clearTimeout(impatientTimer);
  // 等了很久才放行的，说明远端 shell 很慢，说一声免得用户以为卡死
  if (setupPhase) {
    process.stdout.write('\x1b[2m远端初始化较慢，已先进入提示符；远端输出将原样显示。\x1b[0m\r\n');
  }
  process.stdout.write(`\x1b[32m已连接 ${host.name}\x1b[0m \x1b[2m(${host.username}@${host.host})\x1b[0m\r\n`);

  await repl(cfg, {
    label: `ssh:${host.name}`,
    farewell: standalone,
    registerClose: (cb) => {
      closeCb = cb;
    },
    registerRemoteWriter: (write) => {
      writeRemote = write;
    },
    promptLine: prompt,
    completer: makeRemoteCompleter(getUsage(), async (word, onlyDirs) => {
      if (!session.execQuery) return [];
      /**
       * 远端补全查询。
       *
       * word 是用户（或 AI 建议的命令）敲到一半的片段，会被拼进远端 shell 命令行，
       * 必须当成不可信输入处理。
       *
       * 安全做法是**只用一层单引号**包裹 word：
       * - 单引号内除 `'` 本身外一切字符都是字面量，$ / ` / " / \ 都不会被展开；
       * - 历史写法 `bash -c "compgen -f '<word>'"` 是外层双引号 + 内层单引号，
       *   却只转义了单引号 —— 含 `"` 的 word 会提前闭合外层双引号，含 $ / 反引号
       *   的会在外层先被展开，等于把补全缓冲变成远端命令注入点。
       * 教训：不要让同一个值穿过两层不同的引号上下文。
       *
       * `'\''` 是 POSIX 标准转义：结束当前单引号、插入转义单引号、再重新开单引号。
       *
       * 这里不再套 `bash -c`：conn.exec 本来就在远端登录 shell 里执行，compgen 作为
       * builtin 可直接用；多套一层只会多一层引号上下文要照顾。
       */
      const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

      /*
       * compgen 的签名是 `compgen [-V varname] [option] [word]`，**没有 `--`
       * 选项终止符**，传 `--` 会被当成 word 本身、补全结果直接错掉。
       * 这里不给 word 加 ./ 前缀去防「前导 -」——那样补全结果会带着 ./ 回来，
       * 回填到输入行变成 `./-foo`，反而错得更明显。以 `-` 开头的文件名是极边缘
       * 场景，保持朴素即可。ls 是外部命令，`--` 是它的标准终止符，可以放心用。
       */
      const prefix = quote(word);
      // compgen 优先（bash builtin，不依赖 PATH）；远端登录 shell 不是 bash 时
      // 退回 ls。两条都失败只会静默返回空 —— 补不出来而已，不打断输入。
      // 结尾的 * 故意留在引号外，交给远端 shell 做 glob 展开。
      const cmd = onlyDirs
        ? `compgen -d -S / ${prefix} 2>/dev/null || ls -d -p -- ${prefix}* 2>/dev/null`
        : `compgen -f ${prefix} 2>/dev/null || ls -d -p -- ${prefix}* 2>/dev/null`;
      try {
        const out = await session.execQuery(cmd, 1500);
        const lines = out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        return onlyDirs ? lines.filter((l) => l.endsWith('/')) : lines;
      } catch {
        return [];
      }
    }),
    history,
    /**
     * Ctrl+C：把 \x03 交给远端 PTY，由它给前台进程组发 SIGINT —— 这也是真终端
     * 的做法，ping / tail -f / top 靠这一步才停得下来。
     *
     * 这里不需要「远端忙不忙」的启发式：初始化时已经 `stty -echo`，控制字符不再
     * 回显；远端即使处在空闲提示符，多发一个 \x03 只是让它的 shell 清一次空行，
     * 屏幕上不会多出东西。屏幕上那个 ^C 是本行编辑器打的。
     */
    interrupt: () => {
      try {
        session.write('\x03');
      } catch {
        /* 连接可能刚好断了 */
      }
      // 正在等 settle 的话立刻放行，别让提示符白等那一拍
      activeSettleResolve?.();
      // AI 的捕获通道还挂着就立即收手，不用干等到超时
      activeCapture?.abort();
    },
    execUser: async (line) => {
      // 用户手敲：直接透传，不包标记（避免交互式命令被标记卡住）
      session.write(line + '\n');
      const t = line.trim().toLowerCase();
      if (/^(exit|logout)(\s|$)/.test(t)) {
        // 退出类命令走退出握手：不等远端慢吞吞的 logout 钩子
        await exitHandshake();
      } else {
        // 普通命令：最多 300ms，让即时输出先落地，避免提示符被后到的输出顶掉
        await settle(300);
      }
      return { output: '', code: 0 };
    },
    // AI 判断命令要交互输密码时，交回用户的终端：远端是真实 TTY，
    // 等同用户手敲，密码提示出来自己输。
    execInteractive: async (cmd) => {
      session.write(cmd + '\n');
      await settle(300);
    },
    execCaptured: (cmd, timeoutMs) =>
      new Promise<ExecResult>((resolve) => {
        process.stdout.write(`\r\n\x1b[36m$ ${cmd}\x1b[0m\r\n`);
        const handle = captureExec(session, cmd, 'unix', timeoutMs ?? 30000, {
          // 远端已 stty -echo，没有回显，不能跳过第一行
          skipEcho: false,
          // 嗅到密码提示立刻中断，不干等超时
          abortOnPrompt: true,
          emit: (chunk) => process.stdout.write(chunk),
        });
        activeCapture = handle;
        handle.result.then((r) => {
          activeCapture = null;
          resolve(r);
        });
      }),
  });

  // 会话收尾：显式收掉两个兜底定时器。
  // onExit → endSetup 本来也会清 giveUpTimer，但那条路依赖 stream 的 close 事件；
  // 事件没来时（半关闭 / 异常）定时器会活到 25 秒，对着已经退出的界面吐提示，
  // 还会拖住 Node 进程的自然退出。这里兜一道，零成本。
  if (giveUpTimer) {
    clearTimeout(giveUpTimer);
    giveUpTimer = null;
  }
  clearTimeout(impatientTimer);

  closedByRemote = true; // 主动收尾，避免 onExit 再报一次「远端已关闭」
  session.close();
  return true;
}
