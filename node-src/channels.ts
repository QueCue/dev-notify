// 兼容原 CLI 的导出与语言设置，通讯实现由公共包唯一维护。
import { createChannels, type Message, type NotifyConfig, type Channel, type Plan } from '@quecue/notify-core';
import { t } from './i18n.js';
export type { Channel, Message, Item, Plan, Result, Request } from '@quecue/notify-core';
export { TransportError } from '@quecue/notify-core';
const channels = createChannels(key => t(key));
export const requestJson = channels.requestJson;
export const deliver = channels.deliver;
export function makePlan(channel: Channel, message: Message, config: NotifyConfig): Plan {
  // 开发会话的按钮前缀属于业务协议，不写死在通用通讯包中。
  return channels.makePlan(channel, message.reply ? {
    ...message, reply: { ...message.reply, callbackData: message.reply.callbackData ?? 'dn:r:' + message.reply.token }
  } : message, config);
}
