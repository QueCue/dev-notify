import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { verifyPackage } from '../scripts/verify-package.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-package-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'node-src'), { recursive: true });
  await writeFile(path.join(root, 'node-src/cli.ts'), '');
  const metadata = { name: '@quecue/dev-notify', version: '0.0.0', dependencies: { '@quecue/notify-core': '^0.1.0' } };
  await writeFile(path.join(root, 'package.json'), JSON.stringify(metadata));
  const pack = { filename: 'candidate-0.0.0.tgz', integrity: '',
    files: ['dist/cli.js', 'package.json', 'README.md', 'README.en.md', 'SECURITY.md', 'SECURITY.en.md',
      'CHANGELOG.md', 'CHANGELOG.en.md', 'LICENSE'].map(file => ({ path: file })) };
  const repack = async () => {
    await mkdir(path.join(root, 'package'), { recursive: true });
    await writeFile(path.join(root, 'package/package.json'), JSON.stringify(metadata));
    execFileSync('tar', ['-czf', pack.filename, 'package/package.json'], { cwd: root, windowsHide: true });
    pack.integrity = 'sha512-' + createHash('sha512').update(await readFile(path.join(root, pack.filename))).digest('base64');
  };
  await repack();
  const manifest = path.join(root, 'pack.json');
  const run = async () => {
    await writeFile(manifest, JSON.stringify([pack]));
    return verifyPackage(manifest, root, root);
  };
  return { root, pack, metadata, repack, run };
}

test('用户README不混入开发记录，开发指南与版本记录有独立入口', async () => {
  for (const language of ['', '.en']) {
    const text = await readFile(new URL(`../README${language}.md`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /当前未发布源码|当前源码的通讯层|Current unreleased source|Communication dependency in current source/);
    assert.doesNotMatch(text, /回归记录|回归共\s*\d+|\d+ tests:|regression totals|## 开发与验证|## Development and verification|v\*.*(?:标签|tag)/i);
    assert.match(text, /github\.com\/QueCue\/notify-core/);
    assert.match(text, /CONTRIBUTING(?:\.en)?\.md/);
    assert.match(text, /CHANGELOG(?:\.en)?\.md/);
    const guide = await readFile(new URL(`../CONTRIBUTING${language}.md`, import.meta.url), 'utf8');
    assert.match(guide, /npm ci --ignore-scripts/); assert.match(guide, /npm test/);
  }
});
test('发布校验允许应用运行时、标准通讯依赖与公开文档', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.run(), { filename: f.pack.filename, integrity: f.pack.integrity });
});
test('发布校验拒绝配置、版本包、嵌入通讯副本和无关源码', async t => {
  const f = await fixture(t);
  for (const file of ['config.json', 'vendor/quecue-notify-core-0.1.0.tgz', 'vendor/README.md',
    'node-src/cli.ts', 'dist/shared/notify-core/index.js', 'node_modules/@quecue/notify-core/dist/index.js']) {
    f.pack.files.push({ path: file });
    await assert.rejects(f.run(), /白名单/);
    f.pack.files.pop();
  }
});
test('发布校验发现缺失的应用运行时', async t => {
  const f = await fixture(t);
  f.pack.files = f.pack.files.filter(file => file.path !== 'dist/cli.js');
  await assert.rejects(f.run(), /编译文件清单/);
});
test('发布校验拒绝虽在 dist 内但不属于源码的陈旧入口', async t => {
  const f = await fixture(t);
  f.pack.files.push({ path: 'dist/stale.js' });
  await assert.rejects(f.run(), /编译文件清单/);
});
test('发布校验要求必要中英文文档与许可证', async t => {
  const f = await fixture(t);
  f.pack.files = f.pack.files.filter(file => file.path !== 'SECURITY.en.md');
  await assert.rejects(f.run(), /必要的公开说明/);
});
test('发布校验不接受篡改 tarball 的完整性', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, f.pack.filename), '被修改的测试包');
  await assert.rejects(f.run(), /完整性不一致/);
});
test('发布校验不接受路径穿越文件名', async t => {
  const f = await fixture(t);
  for (const filename of ['../outside.tgz', 'dir/candidate.tgz', 'dir\\candidate.tgz']) {
    f.pack.filename = filename;
    await assert.rejects(f.run(), /非法路径/);
  }
});
test('发布校验兼容 PowerShell 重定向的 UTF-16LE 和 UTF-8 BOM 清单', async t => {
  const f = await fixture(t);
  for (const encoding of ['utf16le', 'utf8']) {
    const file = path.join(f.root, 'powershell-pack.json');
    await writeFile(file, Buffer.from(String.fromCharCode(0xfeff) + JSON.stringify([f.pack]), encoding));
    assert.equal(verifyPackage(file, f.root, f.root).integrity, f.pack.integrity);
  }
});
test('发布校验拒绝重复清单条目', async t => {
  const f = await fixture(t);
  f.pack.files.push({ path: 'README.md' });
  await assert.rejects(f.run(), /重复路径/);
});
test('发布校验从实际归档检查兼容范围运行时依赖', async t => {
  const f = await fixture(t);
  for (const version of [undefined, '0.1.0', '*', '^0.2.0', 'file:vendor/old.tgz', '0.2.0']) {
    f.metadata.dependencies['@quecue/notify-core'] = version;
    await f.repack();
    await assert.rejects(f.run(), /标准通讯运行时依赖/);
  }
});
test('发布校验拒绝旧别名及 bundledDependencies 两种拼写', async t => {
  const f = await fixture(t);
  for (const extra of [{ imports: { '#notify-core': './dist/shared/notify-core/index.js' } },
    { bundledDependencies: ['@quecue/notify-core'] }, { bundleDependencies: true },
    { devDependencies: { '@quecue/notify-core': '0.1.0' } }]) {
    Object.assign(f.metadata, extra);
    await f.repack();
    await assert.rejects(f.run(), /标准通讯运行时依赖/);
    for (const key of Object.keys(extra)) delete f.metadata[key];
  }
});
