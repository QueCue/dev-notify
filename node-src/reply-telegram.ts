import { requestJson, type Request } from './channels.js';
import { ConfigError } from './config.js';

export type TelegramApi = (method: string, payload: Record<string, unknown>) => Promise<any>;
export function telegramApi(token: string, request: Request = requestJson): TelegramApi {
  return async (method, payload) => {
    if (!['sendMessage', 'editMessageReplyMarkup', 'answerCallbackQuery', 'getMe', 'getUpdates', 'getWebhookInfo'].includes(method)) throw new ConfigError('不支持的 Telegram 桥接方法');
    const response = await request(`https://api.telegram.org/bot${token}/${method}`, payload);
    if (response.ok !== true) {
      if (response.error_code === 409) throw new ConfigError('Telegram 轮询冲突；检查旧 Python 桥接、其他机器或 webhook，桥接不会抢占或删除 webhook');
      throw new ConfigError('Telegram 桥接请求失败；不输出服务端正文或秘密');
    }
    return response.result;
  };
}
export async function replyHint(api: TelegramApi, chat: string, title: string, content: string, replyTo?: number, markup?: unknown): Promise<any> {
  return api('sendMessage', { chat_id: chat, text: title + '\n\n' + content,
    ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}), ...(markup ? { reply_markup: markup } : {}) });
}
