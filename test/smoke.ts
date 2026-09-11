/**
 * 冒烟测试：不通 LLM，只验证最硬的两件事
 * 1) 手动敲的命令原样透传、输出正常
 * 2) AI 发起的命令能被捕获到 output + exitCode，且标记不污染终端
 */
import { loadConfig } from '../src/config.js';
import { createLocalSession } from '../src/session/local.js';
import { captureExec } from '../src/term/capture.js';

function show(title: string, s: string) {
  process.stdout.write(`\n=== ${title} ===\n${JSON.stringify(s)}\n`);
}

async function main() {
  const cfg = loadConfig();
  process.stdout.write(`shell: ${cfg.shell.program} (${cfg.shell.args.join(' ') || 'no args'})\n`);

  const session = createLocalSession(cfg);
  process.stdout.write(`session: ${session.label} os=${session.osFamily} type=${session.shellType}\n`);

  let raw = '';
  session.onData((d) => {
    raw += d;
  });

  // 等 shell 起来
  await new Promise((r) => setTimeout(r, 1500));
  // 清理可能残留的续行状态（多余的换行会让 PowerShell 进入 >> 模式）
  session.write('\x03');

  // 1) 透传
  raw = '';
  session.write('echo TRANSPARENT_OK' + session.eol);
  await new Promise((r) => setTimeout(r, 1200));
  show('透传输出', raw.slice(-200));
  const transparentOk = raw.includes('TRANSPARENT_OK');
  process.stdout.write(`透传结果: ${transparentOk ? 'PASS' : 'FAIL'}\n`);

  // 2) 捕获
  let visible = '';
  const handle = captureExec(session, 'echo CAPTURE_OK', session.shellType, 15000, (s) => {
    visible += s;
  });
  const off = (chunk: string) => {
    visible += handle.feed(chunk);
  };
  session.onData(off);

  const res = await handle.result;
  await new Promise((r) => setTimeout(r, 400));

  process.stdout.write(`\n=== 捕获结果 ===\n`);
  process.stdout.write(`exitCode=${res.exitCode} timedOut=${res.timedOut}\n`);
  process.stdout.write(`output=${JSON.stringify(res.output)}\n`);
  process.stdout.write(`用户可见=${JSON.stringify(visible)}\n`);

  const captureOk = res.output.includes('CAPTURE_OK') && res.exitCode === 0;
  const scrubOk = !visible.includes('__AIX_') && !/__AIX_[a-z0-9]{6}__/.test(visible);
  process.stdout.write(`\n捕获: ${captureOk ? 'PASS' : 'FAIL'}\n`);
  process.stdout.write(`标记已擦除: ${scrubOk ? 'PASS' : 'FAIL'}\n`);

  // 3) 非零退出码
  const failCmd =
    session.shellType === 'cmd'
      ? 'cmd /c exit 3'
      : session.shellType === 'powershell'
        ? 'cmd.exe /c exit 3'
        : '(exit 3)';
  const h2 = captureExec(session, failCmd, session.shellType, 15000, (s) => {
    visible += s;
  });
  const off2 = (chunk: string) => {
    h2.feed(chunk);
  };
  session.onData(off2);
  const r2 = await h2.result;
  const exitCodeOk = r2.exitCode !== 0;
  process.stdout.write(`\n退出码测试(${failCmd}): 期望非0 实际=${r2.exitCode} ${exitCodeOk ? 'PASS' : 'FAIL'}\n`);

  session.close();
  process.exit(transparentOk && captureOk && scrubOk && exitCodeOk ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(String(e));
  process.exit(1);
});
