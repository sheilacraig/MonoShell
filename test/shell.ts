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

  process.stdout.write('\n[新增修复测试]\n');

  // 1. ls 单文件
  const singleFile = path.join(tmp, 'f.txt').replace(/\\/g, '/');
  r = await engine.exec('ls ' + singleFile);
  check('ls 列出单个文件', r.output.trim() === 'f.txt', r.output);

  // 2. cp 和 mv 到目录
  const subDir = path.join(tmp, 'adir').replace(/\\/g, '/');
  r = await engine.exec(`cp ${singleFile} ${subDir}`);
  check('cp 到目录', fs.existsSync(path.join(tmp, 'adir', 'f.txt')), r.output);

  r = await engine.exec(`mv ${path.join(tmp, 'adir', 'f.txt').replace(/\\/g, '/')} ${path.join(tmp, 'adir', 'f2.txt').replace(/\\/g, '/')}`);
  check('mv 重命名文件', fs.existsSync(path.join(tmp, 'adir', 'f2.txt')), r.output);

  // 3. grep -c 计数
  r = await engine.exec(`cat ${singleFile} | grep -c c`);
  check('grep -c 统计匹配行数', r.output.trim() === '1', r.output);

  // 4. 内置 sort (-r, -n, -h)
  r = await engine.exec('echo "10M\n2G\n500K" | sort -h');
  check('sort -h 人类可读容量正序', r.output.trim().split(/\s+/).join(' ') === '500K 10M 2G', r.output);

  r = await engine.exec('echo "10M\n2G\n500K" | sort -hr');
  check('sort -hr 人类可读容量倒序', r.output.trim().split(/\s+/).join(' ') === '2G 10M 500K', r.output);

  // 5. rm -rf 删除目录与文件无报错
  r = await engine.exec(`rm -rf ${subDir}`);
  check('rm -rf 删除目录无报错', !fs.existsSync(path.join(tmp, 'adir')) && r.code === 0, r.output);

  // 6. 安全校验 checkRisk 测试
  const { checkRisk } = await import('../src/core/safety.js');
  const { defaultConfig } = await import('../src/config.js');
  const cfg = defaultConfig();

  const sec1 = checkRisk('cat /dev/null | rm -rf /', cfg);
  check('安全检查: 拦截复合危险命令 cat | rm -rf', sec1.risky === true && sec1.reason.includes('高危'));

  const sec2 = checkRisk('echo evil > /etc/shadow', cfg);
  check('安全检查: 拦截写文件重定向 echo > file', sec2.risky === true && sec2.reason.includes('写入文件'));

  const sec3 = checkRisk('ls -la', cfg);
  check('安全检查: 白名单只读放行', sec3.risky === false);

  // 7. looksLikeNotFound 测试自研 shell 中文报错
  const { looksLikeNotFound } = await import('../src/core/classifier.js');
  check('自然语言识别: 命中中文未找到命令', looksLikeNotFound('foo: 未找到命令（也不是内置命令）', 'foo') === true);

  // 8. parseLine Windows 反斜杠路径测试
  const { parseLine } = await import('../src/shell/parser.js');
  const parsedPath = parseLine('ls C:\\Users\\whh\\test');
  check('语法解析: 保留 Windows 路径反斜杠', parsedPath.segments[0].argv[1] === 'C:\\Users\\whh\\test');

  process.stdout.write(`\n结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e));
  process.exit(1);
});
