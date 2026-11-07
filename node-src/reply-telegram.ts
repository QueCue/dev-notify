import { createTelegramApi, TelegramApiError } from '@quecue/notify-core';
import { requestJson, type Request } from './channels.js';
import { ConfigError } from './config.js';
import { t } from './i18n.js';
import { TelegramRequestError, TelegramConnectionResetError } from './notification-diagnostics.js';

function connectionReset(error: unknown): boolean {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  for (let checked = 0; pending.length && checked < 16; checked++) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const cause = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (cause.code === 'ECONNRESET') return true;
    pending.push(cause.cause);
    if (Array.isArray(cause.errors)) pending.push(...cause.errors.slice(0, 8));
  }
  return false;
}
const telegramRequest: Request = (url, payload) => requestJson(url, payload, async (...args) => {
  try { return await fetch(...args); }
  catch (error) {
    if (connectionReset(error)) throw new TelegramConnectionResetError();
    throw error; // 公共传输仍将其他底层异常转换成安全摘要。
  }
});

export type TelegramApi = (method: string, payload: Record<string, unknown>) => Promise<any>;
export function telegramApi(token: string, request: Request = telegramRequest): TelegramApi {
  const call = createTelegramApi(token, { request });
  return async (method, payload) => {
    if (!['sendMessage', 'editMessageReplyMarkup', 'answerCallbackQuery', 'getMe', 'getUpdates', 'getWebhookInfo'].includes(method)) throw new ConfigError(t('reply.telegramMethod'));
    try { return await call(method, payload); }
    catch (error) {
      if (error instanceof TelegramApiError) {
        throw new TelegramRequestError(error.code);
      }
      throw error;
    }
  };
}
export async function replyHint(api: TelegramApi, chat: string, title: string, content: string, replyTo?: number, markup?: unknown): Promise<any> {
  return api('sendMessage', { chat_id: chat, text: title + '\n\n' + content,
    ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}), ...(markup ? { reply_markup: markup } : {}) });
}
