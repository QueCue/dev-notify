import { createTelegramApi, TelegramApiError } from '@quecue/notify-core';
import { requestJson, type Request } from './channels.js';
import { ConfigError } from './config.js';
import { t } from './i18n.js';
import { TelegramRequestError } from './notification-diagnostics.js';

export type TelegramApi = (method: string, payload: Record<string, unknown>) => Promise<any>;
export function telegramApi(token: string, request: Request = requestJson): TelegramApi {
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
