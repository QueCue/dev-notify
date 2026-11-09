import { ConfigError } from './config.js';
import { t } from './i18n.js';
import { telegramApi, type TelegramApi } from './reply-telegram.js';
import { feishuReplyApi } from './reply-feishu.js';
import { channelAccess, chatChannel, replyChannel, type ReplyAccess } from './reply-state.js';

/** 只路由已授权渠道；从收件人命名空间确定回执归属，不把飞书消息 ID 当 Telegram ID。 */
export function replyApi(access: ReplyAccess, factory?: (view: ReplyAccess) => TelegramApi): TelegramApi {
  const cache = new Map<string, TelegramApi>();
  return async (method, payload) => {
    const chat = typeof payload.chat_id === 'string' || typeof payload.chat_id === 'number' && Number.isSafeInteger(payload.chat_id)
      ? String(payload.chat_id) : undefined;
    const channel = chat ? chatChannel(chat) : 'telegram';
    const view = channelAccess(access, channel);
    if (!view) throw new ConfigError(t('reply.authorizationChanged'));
    if (chat && !view.policy.users.includes(chat)) {
      // /chatid 的自助查询仅在已启用的 Telegram 私聊消费路径中可返回本人 ID。
      if (!(channel === 'telegram' && method === 'sendMessage' && payload.text === 'Telegram chat_id\n\n' + chat))
        throw new ConfigError(t('reply.authorizationChanged'));
    }
    let api = cache.get(channel);
    if (!api) {
      api = factory ? factory(view) : replyChannel(view) === 'feishu' ? feishuReplyApi(view.config) : telegramApi(view.config.telegram.token);
      cache.set(channel, api);
    }
    return api(method, payload);
  };
}
