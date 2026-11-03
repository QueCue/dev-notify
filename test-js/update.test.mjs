import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updatePackage, compareVersions } from '../dist/update.js';

// updatePackage 的正常路径使用注入的 latest；这里确保意外调用真实网络时立即失败。
globalThis.fetch = async () => { throw new Error('禁止真实网络请求'); };

function harness(latest, { answer = 'y', installStatus = 0, check = false, yes = false, postCode = 0 } = {}) {
  const output = [], calls = [], promptsSeen = [], postCalls = [];
  const runner = (args, capture) => {
    calls.push({ args, capture });
    return { status: installStatus, stdout: '', stderr: '' };
  };
  const prompts = { text: async label => { promptsSeen.push(label); return answer; } };
  return { output, calls, promptsSeen, postCalls, options: {
    out: text => output.push(text), prompts, check, yes, runner, latest: async () => latest,
    post: async () => { postCalls.push(true); return postCode; },
  } };
}

test('版本比较覆盖正式版与预发布', () => {
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0-alpha.4'), 1);
  assert.equal(compareVersions('0.1.0-alpha.4', '0.1.0-alpha.3'), 1);
  assert.equal(compareVersions('0.1.0-beta.1', '0.1.0-alpha.9'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
});
test('已是最新版本或本地版本更新时不提示也不安装', async () => {
  for (const latest of ['0.1.1', '0.1.0-alpha.4']) {
    const h = harness(latest);
    assert.equal(await updatePackage('0.1.1', h.options), 0);
    assert.match(h.output.join('\n'), /已是最新版本 0\.1\.1/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.promptsSeen.length, 0);
    assert.equal(h.postCalls.length, 0);
  }
});
test('--check 只报告新版本，不提示、不安装、不维护', async () => {
  const h = harness('0.1.2', { check: true });
  assert.equal(await updatePackage('0.1.1', h.options), 0);
  assert.match(h.output.join('\n'), /当前版本 0\.1\.1，npm 最新版本 0\.1\.2/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.promptsSeen.length, 0);
  assert.equal(h.postCalls.length, 0);
});
test('确认后调用 npm 安装精确版本并执行维护', async () => {
  const h = harness('0.1.2');
  assert.equal(await updatePackage('0.1.1', h.options), 0);
  assert.deepEqual(h.calls, [{ args: ['install', '-g', '@quecue/dev-notify@0.1.2'], capture: false }]);
  assert.equal(h.postCalls.length, 1);
  assert.match(h.output.join('\n'), /已更新到 0\.1\.2/);
  assert.match(h.output.join('\n'), /维护步骤已完成/);
});
test('--yes 跳过确认直接安装', async () => {
  const h = harness('0.1.2', { yes: true });
  assert.equal(await updatePackage('0.1.1', h.options), 0);
  assert.equal(h.promptsSeen.length, 0);
  assert.equal(h.calls.length, 1);
});
test('取消更新不调用 npm 和维护', async () => {
  const h = harness('0.1.2', { answer: 'n' });
  assert.equal(await updatePackage('0.1.1', h.options), 130);
  assert.equal(h.promptsSeen.length, 1);
  assert.equal(h.calls.length, 0);
  assert.equal(h.postCalls.length, 0);
  assert.match(h.output.join('\n'), /已取消/);
});
test('维护失败时返回非零', async () => {
  const h = harness('0.1.2', { postCode: 1 });
  assert.equal(await updatePackage('0.1.1', h.options), 1);
  assert.match(h.output.join('\n'), /后续维护步骤没有全部成功/);
});
test('未提供维护步骤时只打印手动提示', async () => {
  const h = harness('0.1.2');
  h.options.post = undefined;
  assert.equal(await updatePackage('0.1.1', h.options), 0);
  assert.match(h.output.join('\n'), /如有 Claude Code hooks/);
});
test('安装失败明确报错且不执行维护', async () => {
  const h = harness('0.1.2', { installStatus: 1 });
  await assert.rejects(updatePackage('0.1.1', h.options), /更新没有完成/);
  assert.equal(h.postCalls.length, 0);
});
test('拒绝非法版本号', async () => {
  const h = harness('0.1.2; rm -rf /');
  await assert.rejects(updatePackage('0.1.1', h.options), /版本号格式/);
  await assert.rejects(updatePackage('bad', h.options), /当前版本号/);
});
