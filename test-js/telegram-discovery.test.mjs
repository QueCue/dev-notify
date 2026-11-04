import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatsFromUpdates, discoverChats } from '../dist/telegram-discovery.js';

test('从更新中提取会话、去重并按最近活跃排序', () => {
  const updates = [
    { update_id: 1, message: { text: 'SECRET', chat: { id: 111, type: 'private', first_name: 'Alice', username: 'alice' } } },
    { update_id: 2, message: { text: 'SECRET', chat: { id: -100123, type: 'supergroup', title: '团队' } } },
    { update_id: 3, message: { chat: { id: 111, type: 'private', first_name: 'Alice' } } },
    { update_id: 4, message: { chat: { id: 0, type: 'private', first_name: 'Zero' } } },
    { update_id: 5, message: { chat: { id: 222, type: 'channel', title: '发布\n渠道\u0000' } } },
  ];
  const result = chatsFromUpdates(updates);
  assert.deepEqual(result.map(chat => chat.id), ['222', '111', '-100123']);
  assert.deepEqual(result.map(chat => chat.kind), ['channel', 'private', 'supergroup']);
  assert.equal(result.find(chat => chat.id === '111').title, 'Alice');
  assert.equal(result.find(chat => chat.id === '222').title, '发布 渠道');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.deepEqual(chatsFromUpdates(null), []);
});

test('自动发现只调用 getUpdates，错误信息不泄露 Token', async () => {
  let called;
  const result = await discoverChats('123:TEST_ONLY', async (url, payload) => {
    called = { url, payload };
    return { ok: true, result: [{ message: { chat: { id: 9, type: 'private', first_name: 'A' } } }] };
  });
  assert.deepEqual(result, [{ id: '9', title: 'A', kind: 'private' }]);
  assert.match(called.url, /\/getUpdates$/);
  assert.equal(called.payload.timeout, 0);
  assert.deepEqual(called.payload.allowed_updates, ['message']);
  for (const response of [{ ok: false, error_code: 401 }, { ok: false, error_code: 409 }, { ok: false }]) {
    await assert.rejects(discoverChats('123:SECRET', async () => response),
      error => !error.message.includes('SECRET') && error.message.length > 0);
  }
  await assert.rejects(discoverChats('123:SECRET', async () => { throw new Error('SECRET network'); }),
    error => !error.message.includes('SECRET'));
});
