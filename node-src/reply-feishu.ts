import { createFeishuClient, splitPlainText, type FeishuClient, type FeishuMessageEvent } from '@quecue/notify-core';
import { ConfigError, type Config } from './config.js';
import { t } from './i18n.js';
import type { TelegramApi } from './reply-telegram.js';
import { digest, stateTransaction, TTL, type ReplyAccess } from './reply-state.js';

export type FeishuFactory = typeof createFeishuClient;
export function feishuClient(config: Config, options: Parameters<FeishuFactory>[1] = {}, factory: FeishuFactory = createFeishuClient): FeishuClient {
  return factory({ appId: config.feishu.appId ?? '', appSecret: config.feishu.appSecret ?? '' }, options);
}
// 复用业务层的发送边界；这里只适配发送/清理接口，不伪造 Telegram 更新或数字 ID。
export function feishuReplyApi(config: Config, client = feishuClient(config)): TelegramApi {
  return async (method, payload) => {
    if (method === 'editMessageReplyMarkup') return {};
    if (method !== 'sendMessage' || typeof payload.chat_id !== 'string' || !config.feishu.openIds?.includes(payload.chat_id)
      || typeof payload.text !== 'string') throw new ConfigError(t('feishu.failed'));
    try {
      let result;
      const ids: string[] = [];
      const reply = (payload.reply_parameters as { message_id?: unknown } | undefined)?.message_id;
      for (const text of splitPlainText(payload.text, 4000)) {
        const message = { msgType: 'text', content: JSON.stringify({ text }) };
        result = typeof reply === 'string'
          ? await client.replyMessage(reply, message)
          : await client.sendMessage({ ...message, receiveId: payload.chat_id, receiveIdType: 'open_id' });
        ids.push(result.messageId);
      }
      return { message_id: result?.messageId, message_ids: ids };
    } catch { throw new ConfigError(t('feishu.failed')); }
  };
}
export interface FeishuInboxMessage { id: string; user: string; parent?: string; text: string; created: number }
export function parseFeishuMessage(event: FeishuMessageEvent, access: ReplyAccess): FeishuInboxMessage | null {
  const { sender, message } = event;
  const user = sender?.sender_id?.open_id;
  if (access.policy.channel !== 'feishu' || event.event_type && event.event_type !== 'im.message.receive_v1'
    || sender?.sender_type !== 'user' || !user || !access.policy.users.includes(user)
    || message?.chat_type !== 'p2p' || message.message_type !== 'text'
    || !/^om_[A-Za-z0-9_-]+$/.test(message.message_id) || !/^oc_[A-Za-z0-9_-]+$/.test(message.chat_id)
    || typeof message.content !== 'string' || message.content.length > 32000) return null;
  const created = Number(message.create_time);
  if (!Number.isFinite(created) || created < Date.now() - 300000 || created > Date.now() + 60000) return null;
  try {
    const data = JSON.parse(message.content);
    if (typeof data?.text !== 'string' || !data.text.trim() || Array.from(data.text).length > 4000) return null;
    return { id: message.message_id, user, text: data.text, created,
      ...(typeof message.parent_id === 'string' && /^om_[A-Za-z0-9_-]+$/.test(message.parent_id) ? { parent: message.parent_id } : {}) };
  } catch { return null; }
}
// SDK 回调只做校验、去重和持久入队，不等待 HTTP 或终端输入，避免占用 3 秒 ACK 预算。
export async function enqueueFeishuMessage(access: ReplyAccess, event: FeishuMessageEvent): Promise<void> {
  const value = parseFeishuMessage(event, access);
  if (!value) return;
  await stateTransaction(access, state => {
    const now = Date.now();
    state.feishuInbox ??= {}; state.feishuSeen ??= {};
    for (const [key, updated] of Object.entries(state.feishuSeen)) if (now - updated > TTL) delete state.feishuSeen[key];
    const keys = ['message:' + digest(value.id), ...(typeof event.event_id === 'string' && event.event_id ? ['event:' + digest(event.event_id)] : [])];
    if (keys.some(key => Object.hasOwn(state.feishuSeen!, key))) return;
    if (Object.keys(state.feishuInbox).length >= 100 || Object.keys(state.feishuSeen).length >= 20000) throw new ConfigError(t('feishu.failed'));
    for (const key of keys) state.feishuSeen[key] = now;
    state.feishuInbox[value.id] = value;
  }, 20); // 锁竞争快速失败，交给 SDK 失败 ACK；不在回调内排队等待业务执行。
}
