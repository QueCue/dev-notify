import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postUpdate } from '../dist/maintenance.js';

const CONFIG = '/tmp/dev-notify/config.json';
const zero = { stop: 0, notification: 0, lifecycle: 0, interaction: 0, configs: [] };
const bound = { stop: 1, notification: 1, lifecycle: 3, interaction: 5, configs: [CONFIG] };

function harness({ hooks = zero, bridgeStates = [{ running: false }], runStatus = 0 } = {}) {
  const output = [], errors = [], calls = [];
  let index = 0;
  return { output, errors, calls, options: {
    config: CONFIG, env: {},
    out: text => output.push(text), err: text => errors.push(text),
    run: args => { calls.push(args); return runStatus; },
    hooks: async () => hooks,
    bridge: async () => bridgeStates[Math.min(index++, bridgeStates.length - 1)],
    wait: async () => {},
  } };
}

test('未安装 hooks 且桥接未运行时不执行维护命令', async () => {
  const h = harness();
  assert.equal(await postUpdate(h.options), 0);
  assert.deepEqual(h.calls, []);
  assert.match(h.output.join('\n'), /Claude Code hooks，跳过/);
  assert.match(h.output.join('\n'), /回复桥接，跳过/);
});
test('已安装 hooks 且桥接运行时重装并重启', async () => {
  const h = harness({ hooks: bound, bridgeStates: [{ running: true }, { running: false }] });
  assert.equal(await postUpdate(h.options), 0);
  assert.deepEqual(h.calls, [
    ['integration', 'claude-code', 'install', '--yes', '--config', CONFIG],
    ['reply', 'stop', '--config', CONFIG],
    ['reply', 'start', '--config', CONFIG],
  ]);
  assert.match(h.output.join('\n'), /Claude Code hooks 已更新/);
  assert.match(h.output.join('\n'), /回复桥接已重启/);
});
test('hooks 绑定其他配置时不自动改绑', async () => {
  const h = harness({ hooks: { ...bound, configs: ['/tmp/dev-notify/other.json'] } });
  assert.equal(await postUpdate(h.options), 0);
  assert.deepEqual(h.calls, []);
  assert.match(h.output.join('\n'), /其他通知配置/);
});
test('桥接未在等待时间内退出时提示手动启动', async () => {
  const h = harness({ bridgeStates: [{ running: true }, { running: true }] });
  assert.equal(await postUpdate(h.options), 1);
  assert.deepEqual(h.calls, [['reply', 'stop', '--config', CONFIG]]);
  assert.match(h.errors.join('\n'), /仍在退出/);
});
test('维护命令失败时返回非零并继续报告', async () => {
  const h = harness({ hooks: bound, bridgeStates: [{ running: true }, { running: false }], runStatus: 1 });
  assert.equal(await postUpdate(h.options), 1);
  assert.ok(h.calls.some(args => args[2] === 'install'));
  assert.ok(h.calls.some(args => args[1] === 'start'));
  assert.match(h.errors.join('\n'), /hooks 更新失败/);
  assert.match(h.errors.join('\n'), /回复桥接启动失败/);
});
