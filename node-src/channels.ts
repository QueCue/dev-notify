// 兼容原 CLI 的导出与语言设置，通讯实现由公共包唯一维护。
import { createChannels, createFeishuClient, type FeishuClient, type Message, type NotifyConfig, type Channel, type Plan, type Result } from '@quecue/notify-core';
import { t } from './i18n.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
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
export const deliver: typeof channels.deliver = (plan, config, request = requestJson, sleep) => {
  const app = config.feishu as Config['feishu'];
  if (plan.channel === 'feishu' && app.mode === 'app') return deliverFeishuPlan(plan,
    createFeishuClient({ appId: app.appId ?? '', appSecret: app.appSecret ?? '' }), sleep);
  return channels.deliver(plan, config, request, sleep);
};
export async function deliverFeishuPlan(plan: Plan, client: Pick<FeishuClient, 'sendMessage'>,
  sleep: (ms: number) => Promise<unknown> = delay): Promise<Result> {
  let sent = 0, failed = false;
  const skipped = new Set<string>();
  for (const item of plan.items) {
    if (skipped.has(item.recipient)) continue;
    try {
      const result = await client.sendMessage({ receiveId: item.recipient, receiveIdType: 'open_id',
        msgType: 'interactive', content: JSON.stringify(item.payload.card) });
      sent++;
      await plan.onSent?.(item, { result: { message_id: result.messageId } });
      await sleep(250);
    } catch { skipped.add(item.recipient); failed = true; }
  }
  return { channel: 'feishu', sent, planned: plan.items.length, ok: !failed,
    ...(failed ? { error: t('feishu.failed') } : {}) };
}
export function makePlan(channel: Channel, message: Message, config: NotifyConfig): Plan {
  const app = config.feishu as Config['feishu'];
  if (channel === 'feishu' && app.mode === 'app') {
    const base = channels.makePlan(channel, { ...message, reply: undefined }, config);
    return { ...base, recipients: app.openIds?.length ?? 0,
      items: (app.openIds ?? []).flatMap(recipient => base.items.map(item => ({ ...structuredClone(item), recipient }))) };
  }
  // 开发会话的按钮前缀属于业务协议，不写死在通用通讯包中。
  return channels.makePlan(channel, message.reply ? {
    ...message, reply: { ...message.reply, callbackData: message.reply.callbackData ?? 'dn:r:' + message.reply.token }
  } : message, config);
}
