/** 内置 shell 冒烟测试：验证不依赖系统 cmd/powershell 也能跑通常用命令 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ShellEngine } from '../src/shell/engine.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    fail++;
    process.stdout.write(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}\n`);
  }
}

async function main() {
  const engine = new ShellEngine(os.tmpdir());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shell-'));

  process.stdout.write('\n[内置命令]\n');

  let r = await engine.exec('pwd');
  check('pwd 返回当前目录', r.output.trim() === engine.cwd, r.output);

  r = await engine.exec('echo hello world');
  check('echo', r.output.trim() === 'hello world', r.output);

  await engine.exec(`mkdir ${path.join(tmp, 'adir').replace(/\\/g, '/')}`);
  check('mkdir', fs.existsSync(path.join(tmp, 'adir')));

  r = await engine.exec('ls ' + tmp.replace(/\\/g, '/'));
  check('ls 列出刚建的目录', r.output.includes('adir'), r.output);

  fs.writeFileSync(path.join(tmp, 'f.txt'), 'a\nb\nc\nd\ne\n');
  r = await engine.exec('cat ' + path.join(tmp, 'f.txt').replace(/\\/g, '/'));
  check('cat', r.output.trim() === 'a\nb\nc\nd\ne', JSON.stringify(r.output));

  r = await engine.exec('head -n 2 ' + path.join(tmp, 'f.txt').replace(/\\/g, '/'));
  check('head -n 2', r.output.trim() === 'a\nb', JSON.stringify(r.output));

  r = await engine.exec('tail -n 2 ' + path.join(tmp, 'f.txt').replace(/\\/g, '/'));
  check('tail -n 2', r.output.trim() === 'd\ne', JSON.stringify(r.output));

  r = await engine.exec('wc -l ' + path.join(tmp, 'f.txt').replace(/\\/g, '/'));
  check('wc', /6|5/.test(r.output), r.output);

  process.stdout.write('\n[管道与重定向]\n');

  r = await engine.exec('cat ' + path.join(tmp, 'f.txt').replace(/\\/g, '/') + ' | grep b');
  check('管道 + grep', r.output.trim() === 'b', JSON.stringify(r.output));

  r = await engine.exec('cat ' + path.join(tmp, 'f.txt').replace(/\\/g, '/') + ' | grep -n c');
  check('grep -n 带行号', r.output.trim() === '3:c', JSON.stringify(r.output));

  const outFile = path.join(tmp, 'out.txt').replace(/\\/g, '/');
  r = await engine.exec(`echo redirected > ${outFile}`);
  check('重定向 >', fs.readFileSync(path.join(tmp, 'out.txt'), 'utf8').trim() === 'redirected');

  r = await engine.exec('cat ' + outFile);
  check('读回重定向文件', r.output.trim() === 'redirected', r.output);

  process.stdout.write('\n[多语句与状态]\n');

  r = await engine.exec('echo one && echo two');
  check('&& 连接', r.output.trim() === 'two', JSON.stringify(r.output));

  r = await engine.exec('cd ' + tmp.replace(/\\/g, '/'));
  check('cd 改变目录', engine.cwd === fs.realpathSync(tmp), engine.cwd);

  r = await engine.exec('nonexistent-cmd-xyz-123');
  check('未知命令返回 127', r.code === 127, `code=${r.code} out=${r.output}`);

  r = await engine.exec('echo first ; echo second');
  check('; 分隔', r.output.trim() === 'second', JSON.stringify(r.output));

  process.stdout.write('\n[引号与转义]\n');

  r = await engine.exec('echo "a b  c"');
  check('双引号保留空格', r.output.trim() === 'a b  c', JSON.stringify(r.output));

  r = await engine.exec("echo 'x y'");
  check('单引号', r.output.trim() === 'x y', JSON.stringify(r.output));

  process.stdout.write('\n[外部命令]\n');
  const isWin = process.platform === 'win32';
  const extCmd = isWin ? 'where cmd' : 'echo external-ok';
  r = await engine.exec(extCmd);
  check(`外部命令可执行 (${extCmd})`, r.code === 0 || r.output.length > 0, `code=${r.code}`);

  process.stdout.write(`\n结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e));
  process.exit(1);
});
