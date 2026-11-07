import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// 与本地和 CI 共用的只读发布包校验；不会发布、安装或修改标签。
export function verifyPackage(packFile, packageDirectory, root = fileURLToPath(new URL('../', import.meta.url))) {
  const buffer = readFileSync(packFile);
  // Windows PowerShell 5.1 的重定向默认生成 UTF-16LE；兼容它与 UTF-8/BOM。
  const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.subarray(2).toString('utf16le') : buffer.toString('utf8');
  const data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!Array.isArray(data) || data.length !== 1) throw new Error('需要一个 npm pack 结果。');
  const [pack] = data;
  const allowed = /^(?:dist\/[^/]+\.js|package\.json|README(?:\.en)?\.md|SECURITY(?:\.en)?\.md|CHANGELOG(?:\.en)?\.md|LICENSE)$/;
  if (!pack || typeof pack.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(pack.filename) ||
      !Array.isArray(pack.files) || pack.files.some(file => typeof file.path !== 'string' || !allowed.test(file.path))) {
    throw new Error('发布压缩包包含白名单以外文件或非法路径。');
  }
  const paths = pack.files.map(file => file.path);
  if (new Set(paths).size !== paths.length) throw new Error('包文件清单包含重复路径。');
  const expected = readdirSync(path.join(root, 'node-src')).filter(name => name.endsWith('.ts'))
    .map(name => 'dist/' + name.replace(/\.ts$/, '.js'));
  const actual = paths.filter(name => name.startsWith('dist/')).sort();
  if (JSON.stringify(expected.sort()) !== JSON.stringify(actual)) throw new Error('编译文件清单与应用源码不一致。');
  for (const required of ['package.json', 'README.md', 'README.en.md', 'SECURITY.md', 'SECURITY.en.md',
    'CHANGELOG.md', 'CHANGELOG.en.md', 'LICENSE']) {
    if (!paths.includes(required)) throw new Error('发布包缺少必要的公开说明或许可证。');
  }
  const archive = path.resolve(packageDirectory, pack.filename);
  const bytes = readFileSync(archive);
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  if (integrity !== pack.integrity) throw new Error('压缩包完整性不一致。');
  // 只读取归档元数据，不提取文件或执行包内脚本。Windows 与 CI 均需系统 tar。
  // 使用文件名及独立 cwd，避免 GNU tar 将 Windows 盘符误识别为远程主机。
  const metadata = JSON.parse(execFileSync('tar', ['-xOf', path.basename(archive), 'package/package.json'],
    { cwd: path.dirname(archive), encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true }));
  const source = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== source.name || metadata.version !== source.version ||
      metadata.dependencies?.['@quecue/notify-core'] !== '^0.1.0' ||
      source.dependencies?.['@quecue/notify-core'] !== '^0.1.0' ||
      metadata.devDependencies?.['@quecue/notify-core'] || metadata.imports?.['#notify-core'] ||
      [metadata.bundledDependencies, metadata.bundleDependencies].some(value =>
        value === true || (Array.isArray(value) && value.includes('@quecue/notify-core')))) {
    throw new Error('发布包必须声明兼容范围 ^0.1.0 的标准通讯运行时依赖，不能嵌入或使用旧别名。');
  }
  return { filename: pack.filename, integrity };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4) throw new Error('用法：node scripts/verify-package.mjs <npm-pack.json> <包所在目录>');
  const result = verifyPackage(process.argv[2], process.argv[3]);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `filename=${result.filename}\nintegrity=${result.integrity}\n`);
  console.log(JSON.stringify(result));
}
