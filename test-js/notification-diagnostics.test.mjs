import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramApiError, HttpError, TransportError } from '@quecue/notify-core';
import { safeFailureReason, safeDeliveryReason, ReplyPreparationError } from '../dist/notification-diagnostics.js';
import { telegramApi } from '../dist/reply-telegram.js';
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
test('异常状态码不作为任意文字或无界数字输出', () => {
  for (const code of [-1, 0, 99999999, Infinity, NaN, 'FAKE_SECRET']) {
    assert.equal(safeFailureReason(new TelegramApiError(code)), t('diagnostic.telegramUnknown'));
    assert.equal(safeFailureReason(new HttpError(code)), t('diagnostic.network'));
  }
});
