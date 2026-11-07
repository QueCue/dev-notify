// 兼容原 CLI 的导出与语言设置，通讯实现由公共包唯一维护。
import { createChannels, type Message, type NotifyConfig, type Channel, type Plan } from '@quecue/notify-core';
import { t } from './i18n.js';
import { connectionReset, TelegramConnectionResetError } from './notification-diagnostics.js';
export type { Channel, Message, Item, Plan, Result, Request } from '@quecue/notify-core';
export { TransportError } from '@quecue/notify-core';
const channels = createChannels(key => t(key));
export const requestJson: typeof channels.requestJson = (url, payload, fetcher = fetch) => channels.requestJson(url, payload, async (...args) => {
  try { return await fetcher(...args); }
  catch (error) {
    // 只为官方 Telegram 目标保留连接重置分类，不重试或输出URL。
    if (new URL(url).hostname === 'api.telegram.org' && connectionReset(error)) throw new TelegramConnectionResetError();
    throw error;
  }
});
export const deliver: typeof channels.deliver = (plan, config, request = requestJson, sleep) => channels.deliver(plan, config, request, sleep);
export function makePlan(channel: Channel, message: Message, config: NotifyConfig): Plan {
  // 开发会话的按钮前缀属于业务协议，不写死在通用通讯包中。
  return channels.makePlan(channel, message.reply ? {
    ...message, reply: { ...message.reply, callbackData: message.reply.callbackData ?? 'dn:r:' + message.reply.token }
  } : message, config);
}
