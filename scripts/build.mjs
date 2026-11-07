import { spawnSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length > 2) throw new Error('构建不接受跨仓库源码或其他参数。');
for (const directory of ['dist', 'dist/shared']) {
  try {
    const stat = await lstat(path.join(root, directory));
    if (stat.isSymbolicLink()) throw new Error('构建输出不能是符号链接。');
    if (directory === 'dist/shared') throw new Error('请先归档陈旧的 dist/shared 生成目录；构建不再复制通讯库。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.json')],
  { cwd: root, stdio: 'inherit', shell: false });
if (result.status !== 0) process.exit(result.status ?? 1);
