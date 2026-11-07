import { HttpError, TelegramApiError, TransportError } from '@quecue/notify-core';
import { ConfigError } from './config.js';
import { t } from './i18n.js';

// 仅保留类型和有界状态码；不输出底层异常、URL、Token 或服务端正文。
export class TelegramRequestError extends ConfigError {
  constructor(public readonly code: number) {
    super(t(code === 409 ? 'reply.telegramConflict' : 'reply.telegramRequestFailed'));
  }
}
export function safeFailureReason(error: unknown): string {
  if (error instanceof TelegramRequestError || error instanceof TelegramApiError) {
    const code = error.code;
    return Number.isSafeInteger(code) && code >= 100 && code <= 599
      ? t('diagnostic.telegramCode', { code }) : t('diagnostic.telegramUnknown');
  }
  if (error instanceof HttpError) {
    const code = error.status;
    return Number.isSafeInteger(code) && code >= 100 && code <= 599
      ? t('diagnostic.httpCode', { code }) : t('diagnostic.network');
  }
  if (error instanceof TransportError) return t('diagnostic.network');
  return t('diagnostic.unknown');
}
export class ReplyPreparationError extends ConfigError {
  constructor(error: unknown) {
    super(t('hook.replyIdentityFailed', { reason: safeFailureReason(error) }));
  }
}
// 公共库目前只返回安全文本而非错误类型。仅匹配本地已知值，不转发任意字符串。
export function safeDeliveryReason(error: unknown): string {
  for (const key of ['channels.network', 'channels.noResponse', 'channels.responseTooLarge', 'channels.notJsonObject'] as const) {
    if (error === t(key)) return t('diagnostic.network');
  }
  if (error === t('channels.rejected')) return t('diagnostic.rejected');
  return t('diagnostic.unknown');
}
