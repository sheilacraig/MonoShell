/**
 * 把 MonoShell 打成单文件可执行程序（Node 官方 SEA）。
 *
 *   npm run pack        -> 产物 release/mono.exe（Windows）/ release/mono（macOS / Linux）
 *
 * 几点约定：
 * - SEA 的 blob 只能注入「与构建时同版本」的 node 二进制，且不能跨平台编译；
 *   要出 mac / linux 版，请在对应平台（或对应架构的机器）上跑本脚本。
 * - ssh2 的可选原生依赖 cpu-features / bcrypt 显式排除，运行期走纯 JS 兜底。
 * - 注入后 node.exe 的 Authenticode 签名会失效，postject 会提示 signature corrupted，属正常。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
const isWin = process.platform === 'win32';
const exeName = isWin ? 'mono.exe' : 'mono';
const bundle = path.join(release, 'bundle.cjs');
const blob = path.join(release, 'sea-prep.blob');
const out = path.join(release, exeName);
// node 二进制里预置的哨兵串，postject 靠它定位注入位置，不可改动
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const run = (args) => execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });

fs.mkdirSync(release, { recursive: true });

console.log('· 1/5 编译 TypeScript');
run([path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']);

console.log('· 2/5 打包为单个 CJS（排除可选原生依赖）');
await esbuild.build({
  entryPoints: [path.join(root, 'dist/index.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: bundle,
  external: ['cpu-features', 'bcrypt', '*.node'],
  // 终端里不该出现依赖的弃用告警（punycode 等），在 bundle 最前面关掉
  banner: {
    js: 'process.noDeprecation=true;',
  },
});

console.log('· 3/5 生成 SEA blob');
// 配置放在仓库根目录：main / output 都用相对根的路径，避免相对路径歧义
const cfgPath = path.join(root, 'sea-config.json');
fs.writeFileSync(
  cfgPath,
  JSON.stringify(
    {
      main: 'release/bundle.cjs',
      output: 'release/sea-prep.blob',
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2,
  ) + '\n',
);
run(['--experimental-sea-config', cfgPath]);

console.log('· 4/5 复制宿主 node 二进制');
fs.copyFileSync(process.execPath, out);
if (!isWin) {
  try {
    fs.chmodSync(out, 0o755);
  } catch {}
}
if (process.platform === 'darwin') {
  try {
    execFileSync('codesign', ['--remove-signature', out], { stdio: 'inherit' });
  } catch {}
}

console.log('· 5/5 注入 blob');
const injectArgs = [
  path.join(root, 'node_modules/postject/dist/cli.js'),
  out,
  'NODE_SEA_BLOB',
  blob,
  '--sentinel-fuse',
  SENTINEL,
];
if (process.platform === 'darwin') injectArgs.push('--macho-segment-name', 'NODE_SEA');
run(injectArgs);

if (process.platform === 'darwin') {
  try {
    execFileSync('codesign', ['--sign', '-', out], { stdio: 'inherit' });
  } catch {}
}

console.log(`\n✓ 打包完成 ${path.relative(root, out)} （${(fs.statSync(out).size / 1024 / 1024).toFixed(1)}MB）`);
