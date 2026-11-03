import { requestJson, type Request } from './channels.js';
import { ConfigError } from './config.js';
import { t } from './i18n.js';

export type TelegramApi = (method: string, payload: Record<string, unknown>) => Promise<any>;
export function telegramApi(token: string, request: Request = requestJson): TelegramApi {
  return async (method, payload) => {
    if (!['sendMessage', 'editMessageReplyMarkup', 'answerCallbackQuery', 'getMe', 'getUpdates', 'getWebhookInfo'].includes(method)) throw new ConfigError(t('reply.telegramMethod'));
    const response = await request(`https://api.telegram.org/bot${token}/${method}`, payload);
    if (response.ok !== true) {
      if (response.error_code === 409) throw new ConfigError(t('reply.telegramConflict'));
      throw new ConfigError(t('reply.telegramRequestFailed'));
    }
    return response.result;
  };
}
export async function replyHint(api: TelegramApi, chat: string, title: string, content: string, replyTo?: number, markup?: unknown): Promise<any> {
  return api('sendMessage', { chat_id: chat, text: title + '\n\n' + content,
    ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}), ...(markup ? { reply_markup: markup } : {}) });
}
