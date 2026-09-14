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
  check('&& 连接（两段输出都要保留）', r.output.trim() === 'one\ntwo', JSON.stringify(r.output));

  r = await engine.exec('cd ' + tmp.replace(/\\/g, '/'));
  check('cd 改变目录', engine.cwd === fs.realpathSync(tmp), engine.cwd);

  r = await engine.exec('nonexistent-cmd-xyz-123');
  check('未知命令返回 127', r.code === 127, `code=${r.code} out=${r.output}`);

  r = await engine.exec('echo first ; echo second');
  check('; 分隔（两段输出都要保留）', r.output.trim() === 'first\nsecond', JSON.stringify(r.output));

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

  // 5b. 多语句：每段输出都要保留（以前只留最后一条的结果）
  r = await engine.exec('echo A; echo B; echo C');
  check('多语句输出全保留', r.output.trim() === 'A\nB\nC', JSON.stringify(r.output));

  r = await engine.exec('nonexistent-cmd-xyz-123 && echo never');
  check('&& 前段失败后不再执行', r.code === 127 && !r.output.includes('never'), JSON.stringify(r.output));

  // 5c. cp / mv 多源 + 目标不存在：必须直接报错，不能互相覆盖
  fs.writeFileSync(path.join(tmp, 'c1.txt'), 'C-ONE\n');
  fs.writeFileSync(path.join(tmp, 'c2.txt'), 'C-TWO\n');
  r = await engine.exec('cp c1.txt c2.txt nodir');
  check(
    'cp 多源目标不是目录时报错且不落盘',
    r.code === 1 && !fs.existsSync(path.join(tmp, 'nodir')) && fs.existsSync(path.join(tmp, 'c1.txt')),
    `${r.code} ${r.output}`,
  );

  fs.writeFileSync(path.join(tmp, 'm1.txt'), 'M-ONE\n');
  fs.writeFileSync(path.join(tmp, 'm2.txt'), 'M-TWO\n');
  r = await engine.exec('mv m1.txt m2.txt mdir');
  check(
    'mv 多源目标不是目录时报错且源文件都在',
    r.code === 1 &&
      fs.existsSync(path.join(tmp, 'm1.txt')) &&
      fs.existsSync(path.join(tmp, 'm2.txt')) &&
      !fs.existsSync(path.join(tmp, 'mdir')),
    `${r.code} ${r.output}`,
  );

  // 5d. head / tail 的 coreutils 紧凑写法
  r = await engine.exec('head -n2 ' + singleFile);
  check('head -n2 紧凑写法', r.output.trim() === 'a\nb', JSON.stringify(r.output));

  r = await engine.exec('tail -n1 ' + singleFile);
  check('tail -n1 紧凑写法', r.output.trim() === 'e', JSON.stringify(r.output));

  r = await engine.exec('head -2 ' + singleFile);
  check('head -2 短横线写法', r.output.trim() === 'a\nb', JSON.stringify(r.output));

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

  // 9. find -maxdepth 语义测试
  const depthDir = path.join(tmp, 'depthT');
  fs.mkdirSync(path.join(depthDir, 'a', 'b', 'c'), { recursive: true });
  fs.writeFileSync(path.join(depthDir, 'a', 'b', 'c', 'deep.txt'), 'hello recursive deep');
  const dNorm = depthDir.replace(/\\/g, '/');

  const pA = path.join(depthDir, 'a');
  const pB = path.join(depthDir, 'a', 'b');
  const pC = path.join(depthDir, 'a', 'b', 'c');
  const pFile = path.join(depthDir, 'a', 'b', 'c', 'deep.txt');

  r = await engine.exec(`find ${dNorm} -maxdepth 1`);
  check('find -maxdepth 1 仅列出直接子项', r.output.includes(pA) && !r.output.includes(pB), r.output);

  r = await engine.exec(`find ${dNorm} -maxdepth 2`);
  check('find -maxdepth 2 列出两层子项', r.output.includes(pA) && r.output.includes(pB) && !r.output.includes(pC), r.output);

  r = await engine.exec(`find ${dNorm} -maxdepth 3`);
  check('find -maxdepth 3 列出三层子项', r.output.includes(pC) && !r.output.includes(pFile), r.output);

  r = await engine.exec(`find ${dNorm} -maxdepth 4`);
  check('find -maxdepth 4 列出深层文件', r.output.includes(pFile), r.output);

  // 10. grep -r 递归目录测试
  r = await engine.exec(`grep hello ${dNorm}`);
  check('grep 目录不加 -r 明确报错 (code 2)', r.code === 2 && r.output.includes('是一个目录'), `${r.code}: ${r.output}`);

  r = await engine.exec(`grep -r hello ${dNorm}`);
  check('grep -r 递归搜索目录返回命中行', r.code === 0 && r.output.includes('deep.txt') && r.output.includes('hello recursive'), `${r.code}: ${r.output}`);

  // 11. 校验 safety.extraDangerous 与内置规则保持生效
  const { mergeConfig } = await import('../src/config.js');
  const userCfg = mergeConfig({
    safety: { extraDangerous: ['\\bmycmd\\b'] } as never,
  });
  check('extraDangerous 保持内置 29 条规则生效', userCfg.safety.dangerous.length >= 29);
  check('extraDangerous 自定义规则生效', checkRisk('mycmd', userCfg).risky === true);
  check('内置 rm -rf / 规则未被冲掉', checkRisk('rm -rf /', userCfg).risky === true);

  // 12. rm 长选项支持
  check('rm --force -r 拦截', checkRisk('rm --force -r /tmp/a', cfg).risky === true);
  check('rm -r --force 拦截', checkRisk('rm -r --force /tmp/a', cfg).risky === true);
  check('rm -r -f 拦截', checkRisk('rm -r -f /tmp/a', cfg).risky === true);

  // 13. 重定向与引号判定
  check('引号内的 > 不误拦', checkRisk('echo "a > b"', cfg).risky === false);
  check('单引号内的 > 不误拦', checkRisk("echo 'a > b'", cfg).risky === false);
  check('cmd 2>&1 不误拦', checkRisk('cmd 2>&1', cfg).risky === false);
  check('cmd > /dev/null 2>&1 不误拦', checkRisk('cmd > /dev/null 2>&1', cfg).risky === false);
  check('真实写文件重定向拦截', checkRisk('echo hi > out.txt', cfg).risky === true);

  // 14. detectInteractiveAuth 误判修复
  const { detectInteractiveAuth } = await import('../src/core/safety.js');
  check('echo 中的 sudo 不误判', detectInteractiveAuth('echo "sudo is a tool"').needs === false);
  check('grep 参数中的 sudo 不误判', detectInteractiveAuth('grep sudo /etc/x').needs === false);
  check('find 参数中的 sudo 不误判', detectInteractiveAuth('find . -name sudo').needs === false);
  check('命令位置的 sudo 正常识别', detectInteractiveAuth('sudo apt update').needs === true);
  check('无管道的 sudo -S 需密码输入', detectInteractiveAuth('sudo -S apt update').needs === true);
  check('管道输入的 sudo -S 视为已喂密码', detectInteractiveAuth('echo pw | sudo -S apt update').needs === false);

  // 15. alias 展开防安全绕过
  engine.aliases.set('rm2', 'rm -rf');
  const aliasExpanded = engine.expandAlias('rm2 /tmp/a');
  check('expandAlias 展开别名', aliasExpanded === 'rm -rf /tmp/a');
  check('checkRisk 作用于展开后的别名', checkRisk(aliasExpanded, cfg, 'dangerous').risky === true);

  process.stdout.write(`\n结果: ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(String(e));
  process.exit(1);
});
