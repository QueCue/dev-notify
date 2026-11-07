import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replaceStateFile } from '../dist/reply-state.js';
import { ConfigError } from '../dist/config.js';
import { TransportError, makePlan } from '../dist/channels.js';
import { NotifyError } from '@quecue/notify-core';

test('旧 CLI 的安全错误类型与公共包保持同一身份', () => {
  assert.equal(ConfigError, NotifyError);
  assert.ok(new TransportError('安全摘要') instanceof ConfigError);
});
test('开发回复按钮协议由业务适配器保留', () => {
  const plan = makePlan('telegram', { title: '通知', content: '正文', footer: '', level: 'info',
    reply: { token: 'a'.repeat(32), users: ['111'], url: '' } },
  { telegram: { token: '', chatIds: ['111'] }, feishu: { webhook: '', secret: '' } });
  assert.equal(plan.items[0].payload.reply_markup.inline_keyboard[0][0].callback_data, 'dn:r:' + 'a'.repeat(32));
});
test('Windows 暂态替换冲突仅重试同一文件对，不重做上层操作', async () => {
  const pairs = [], waits = []; let attempts = 0;
  await replaceStateFile('temporary', 'state', async (source, target) => {
    pairs.push([source, target]); if (++attempts < 3) throw Object.assign(new Error('锁占用'), { code: 'EPERM' });
  }, async ms => { waits.push(ms); });
  assert.deepEqual(pairs, Array(3).fill(['temporary', 'state']));
  assert.deepEqual(waits, [10, 20]);
});
test('持久拒绝/非暂态替换错误有界退出，不删除目标或无限重试', async () => {
  let calls = 0; const waits = [];
  await assert.rejects(replaceStateFile('a', 'b', async () => {
    calls++; throw Object.assign(new Error('拒绝'), { code: 'EACCES' });
  }, async ms => { waits.push(ms); }));
  assert.equal(calls, 6); assert.deepEqual(waits, [10, 20, 40, 80, 160]);
  calls = 0;
  await assert.rejects(replaceStateFile('a', 'b', async () => {
    calls++; throw Object.assign(new Error('磁盘满'), { code: 'ENOSPC' });
  }, async () => assert.fail('非暂态错误不能等待')));
  assert.equal(calls, 1);
});
