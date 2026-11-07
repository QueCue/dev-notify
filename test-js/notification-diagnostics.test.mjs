import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { TelegramApiError, HttpError, TransportError } from '@quecue/notify-core';
import { safeFailureReason, safeDeliveryReason, ReplyPreparationError, saveNotificationDiagnostic, TelegramConnectionResetError } from '../dist/notification-diagnostics.js';
import { telegramApi } from '../dist/reply-telegram.js';
import { makePlan, deliver } from '../dist/channels.js';
import { setLocale, t } from '../dist/i18n.js';

globalThis.fetch = async () => { throw new Error('禁止真实网络'); };
for (const locale of ['zh', 'en']) test(`${locale} 安全诊断只保留错误类型与状态码，不泄漏异常或响应正文`, async () => {
  setLocale(locale);
  try {
    const secret = 'FAKE_SECRET https://fake.invalid/bot123';
    assert.equal(safeFailureReason(new Error(secret)), t('diagnostic.unknown'));
    assert.equal(safeFailureReason(new TransportError(secret)), t('diagnostic.network'));
    assert.equal(safeFailureReason(new HttpError(502)), t('diagnostic.httpCode', { code: 502 }));
    for (const code of [401, 403, 409, 429, 500]) {
      const api = telegramApi('123:FAKE_ONLY', async () => ({ ok: false, error_code: code, description: secret, parameters: { retry_after: 61 } }));
      await assert.rejects(api('getMe', {}), error => {
        assert.equal(safeFailureReason(error), t('diagnostic.telegramCode', { code }));
        assert.ok(!new ReplyPreparationError(error).message.includes(secret));
        if (code === 409) assert.match(error.message, /冲突|conflict/i);
        return true;
      });
    }
    assert.equal(safeDeliveryReason(t('channels.network')), t('diagnostic.network'));
    assert.equal(safeDeliveryReason(t('channels.rejected')), t('diagnostic.rejected'));
    assert.equal(safeDeliveryReason(secret), t('diagnostic.unknown'));
    assert.equal(safeDeliveryReason('HTTP 请求失败（状态码 401）。' + secret), t('diagnostic.unknown'));
    assert.ok(!new ReplyPreparationError(new Error(secret)).message.includes('fake.invalid'));
  } finally { setLocale('zh'); }
});
test('恢复成功不会覆盖先前通知失败，后续失败按会话独立更新', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-failure-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  const failed = { version: 1, updated: 1, reply: 'getme-failed', channels: { telegram: { status: 'incomplete', sent: 0, planned: 1 } } };
  const success = { version: 1, updated: 2, reply: 'attached', channels: { telegram: { status: 'complete', sent: 1, planned: 1 } } };
  await saveNotificationDiagnostic(file, 'session-a', failed);
  await saveNotificationDiagnostic(file, 'session-a', success);
  const failurePath = path.join(file + '.reply-data', 'notification-failures', 'session-a.json');
  assert.deepEqual(JSON.parse(await readFile(failurePath, 'utf8')), failed);
  assert.deepEqual(JSON.parse(await readFile(path.join(file + '.reply-data', 'notification-diagnostics', 'session-a.json'), 'utf8')), success);
  const later = { ...failed, updated: 3, reply: 'bridge-unready' };
  await saveNotificationDiagnostic(file, 'session-a', later);
  await saveNotificationDiagnostic(file, 'session-b', failed);
  assert.deepEqual(JSON.parse(await readFile(failurePath, 'utf8')), later);
  assert.deepEqual(JSON.parse(await readFile(path.join(file + '.reply-data', 'notification-failures', 'session-b.json'), 'utf8')), failed);
});
test('成功或未启用回复不制造失败记录，但渠道投递失败仍保留', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-failure-kind-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  const value = { version: 1, updated: 1, reply: 'disabled', channels: { feishu: { status: 'complete', sent: 1, planned: 1 } } };
  await saveNotificationDiagnostic(file, 'session-a', value);
  await assert.rejects(readdir(path.join(file + '.reply-data', 'notification-failures')), { code: 'ENOENT' });
  await saveNotificationDiagnostic(file, 'session-a', { ...value, channels: { feishu: { status: 'failed', reason: safeFailureReason(new TransportError('PRIVATE')) } } });
  assert.equal((await readdir(path.join(file + '.reply-data', 'notification-failures'))).length, 1);
});
test('非法会话ID不写诊断目录', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-failure-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const session of ['../outside', '/absolute', '', undefined])
    await saveNotificationDiagnostic(path.join(root, 'config.json'), session, { version: 1, updated: 1, reply: 'attached', channels: {} });
  assert.deepEqual(await readdir(root), []);
});
for (const location of ['direct', 'cause', 'aggregate', 'cycle']) test(`真实传输适配器只保留ECONNRESET分类：${location}`, async () => {
  const previous = globalThis.fetch;
  const reset = Object.assign(new Error('PRIVATE_TOKEN https://fake.invalid'), { code: 'ECONNRESET' });
  const error = location === 'direct' ? reset : location === 'cause' ? new TypeError('PRIVATE', { cause: reset })
    : location === 'aggregate' ? new TypeError('PRIVATE', { cause: new AggregateError([reset]) }) : Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' });
  if (location === 'cycle') error.cause = error;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw error; };
  try {
    await assert.rejects(telegramApi('123:FAKE_ONLY')('getWebhookInfo', {}), failure => {
      assert.ok(failure instanceof TelegramConnectionResetError);
      assert.match(safeFailureReason(failure), /ECONNRESET/);
      assert.doesNotMatch(failure.message, /PRIVATE|fake\.invalid|FAKE_ONLY/);
      assert.equal(failure.cause, undefined);
      return true;
    });
    assert.equal(calls, 1); // API适配层本身不添加重试。
  } finally { globalThis.fetch = previous; }
});
for (const code of ['ETIMEDOUT', 'ENOTFOUND', 'CERT_HAS_EXPIRED']) test(`${code}不伪装成连接重置`, async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error('PRIVATE'), { code }); };
  try {
    await assert.rejects(telegramApi('123:FAKE_ONLY')('getWebhookInfo', {}), failure => {
      assert.ok(failure instanceof TransportError); assert.ok(!(failure instanceof TelegramConnectionResetError));
      assert.doesNotMatch(failure.message, /PRIVATE/); return true;
    });
  } finally { globalThis.fetch = previous; }
});
test('sendMessage连接重置不自动重试，即使收到结果未知', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' }); };
  try {
    await assert.rejects(telegramApi('123:FAKE_ONLY')('sendMessage', { chat_id: 111, text: 'FAKE_ONLY' }), TelegramConnectionResetError);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});
test('普通通知发送保留reset分类，但默认投递器绝不因此重发', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('PRIVATE_URL_TOKEN', { cause: Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' }) }); };
  try {
    const config = { telegram: { token: '123:FAKE_ONLY', chatIds: ['111'] }, feishu: { webhook: '', secret: '' } };
    const plan = makePlan('telegram', { title: '测试', content: '测试', footer: '', level: 'success' }, config);
    const result = await deliver(plan, config);
    assert.equal(result.ok, false); assert.equal(result.sent, 0); assert.equal(calls, 1);
    assert.match(safeDeliveryReason(result.error), /ECONNRESET/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|FAKE_ONLY/);
  } finally { globalThis.fetch = previous; }
});
test('非Telegram网络reset不错误标记为Telegram连接重置', async () => {
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' }); };
  try {
    const config = { telegram: { token: '', chatIds: [] }, feishu: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/FAKE_ONLY', secret: '' } };
    const result = await deliver(makePlan('feishu', { title: '测试', content: '测试', footer: '', level: 'success' }, config), config);
    assert.equal(result.ok, false); assert.equal(calls, 1); assert.equal(safeDeliveryReason(result.error), t('diagnostic.network'));
  } finally { globalThis.fetch = previous; }
});
test('异常状态码不作为任意文字或无界数字输出', () => {
  for (const code of [-1, 0, 99999999, Infinity, NaN, 'FAKE_SECRET']) {
    assert.equal(safeFailureReason(new TelegramApiError(code)), t('diagnostic.telegramUnknown'));
    assert.equal(safeFailureReason(new HttpError(code)), t('diagnostic.network'));
  }
});
