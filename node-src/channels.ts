import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from './config.js';
import { t } from './i18n.js';
import { escapeHtml, feishuParts, parseMarkdown, partTitle, telegramParts } from './formatting.js';

export type Channel = 'telegram' | 'feishu';
export interface Message { title: string; content: string; footer: string; level: 'info' | 'success' | 'warn' | 'error';
  reply?: { token: string; url: string; users: string[] } }
export interface Item { payload: Record<string, any>; plain?: string; recipient: string }
export interface Plan { channel: Channel; items: Item[]; recipients: number;
  onSent?: (item: Item, response: Record<string, any>) => Promise<void> }
export interface Result { channel: Channel; sent: number; planned: number; ok: boolean; error?: string }
export type Request = (url: string, payload: Record<string, any>) => Promise<Record<string, any>>;
export class TransportError extends Error {}
const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
const colors = { info: 'blue', success: 'green', warn: 'yellow', error: 'red' };
const bytes = (data: unknown) => Buffer.byteLength(JSON.stringify(data), 'utf8');

export async function requestJson(url: string, payload: Record<string, any>, fetcher: typeof fetch = fetch): Promise<Record<string, any>> {
  try {
    const response = await fetcher(url, { method: 'POST', body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.body) throw new TransportError(t('channels.noResponse'));
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); throw new TransportError(t('channels.responseTooLarge')); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TransportError(t('channels.notJsonObject'));
    return result;
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError(t('channels.network'));
  }
}
function text(title: string, content: string, footer: string, icon: string, html: boolean): string {
  const sections = [`${icon} ${html ? `<b>${escapeHtml(title)}</b>` : title}`];
  if (content) sections.push(content);
  if (footer) sections.push('────────\n' + (html ? `<i>${escapeHtml(footer)}</i>` : footer));
  return sections.join('\n\n');
}
function card(message: Message, title: string, content: string): Record<string, any> {
  const elements: Record<string, any>[] = [];
  if (content) elements.push({ tag: 'markdown', content });
  if (message.footer) elements.push({ tag: 'hr' }, { tag: 'note', elements: [{ tag: 'plain_text', content: message.footer }] });
  if (message.reply?.url) elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: t('channels.feishuReplyButton') }, url: message.reply.url, type: 'primary' }] });
  return { msg_type: 'interactive', card: { config: { wide_screen_mode: true },
    header: { template: colors[message.level], title: { tag: 'plain_text', content: title } }, elements } };
}
export function makePlan(channel: Channel, message: Message, config: Config): Plan {
  if (!message.title.trim()) throw new Error(t('channels.emptyTitle'));
  const blocks = parseMarkdown(message.content);
  if (channel === 'telegram') {
    const icon = icons[message.level];
    const reserve = String(Math.max(1, message.content.length)).length * 2 + 16;
    const budget = 3900 - text(message.title, '', message.footer, icon, false).length - reserve;
    const chunks = telegramParts(blocks, budget);
    const items: Item[] = [];
    for (const chatId of config.telegram.chatIds) chunks.forEach((chunk, index) => {
      const title = partTitle(message.title, index, chunks.length);
      const plain = text(title, chunk.plain, message.footer, icon, false);
      if (plain.length > 4096) throw new Error(t('channels.telegramTooLong'));
      items.push({ recipient: chatId, plain, payload: { chat_id: chatId,
        text: text(title, chunk.html, message.footer, icon, true), parse_mode: 'HTML', disable_web_page_preview: true,
        ...(message.reply?.users.includes(chatId) ? { reply_markup: { inline_keyboard: [[{ text: t('channels.telegramReplyButton'), callback_data: 'dn:r:' + message.reply.token }]] } } : {}) } });
    });
    return { channel, items, recipients: config.telegram.chatIds.length };
  }
  const budget = Math.min(10000, Math.floor((28000 - bytes(card(message, message.title, '')) - 512) / 6));
  const chunks = feishuParts(blocks, budget);
  const items = chunks.map((chunk, index) => {
    const payload = card(message, partTitle(message.title, index, chunks.length), chunk);
    if (bytes(payload) + 128 > 28000) throw new Error(t('channels.feishuTooLong'));
    return { recipient: 'feishu', payload };
  });
  return { channel, items, recipients: 1 };
}
export async function deliver(plan: Plan, config: Config, request: Request = requestJson,
  sleep: (ms: number) => Promise<unknown> = delay): Promise<Result> {
  let sent = 0, error: string | undefined;
  const failed = new Set<string>();
  const telegram = plan.channel === 'telegram';
  const url = telegram ? `https://api.telegram.org/bot${config.telegram.token}/sendMessage` : config.feishu.webhook;
  const post = async (payload: Record<string, any>) => {
    if (!telegram && config.feishu.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      payload.timestamp = timestamp;
      payload.sign = createHmac('sha256', `${timestamp}\n${config.feishu.secret}`).update('').digest('base64');
    }
    let response = await request(url, payload);
    if (telegram && response.error_code === 429) {
      const wait = response.parameters?.retry_after;
      if (typeof wait === 'number' && Number.isFinite(wait) && wait > 0 && wait <= 60) {
        await sleep(wait * 1000);
        response = await request(url, payload);
      }
    }
    return response;
  };
  for (let index = 0; index < plan.items.length; index++) {
    const item = plan.items[index];
    if (failed.has(item.recipient)) continue;
    const payload = structuredClone(item.payload);
    try {
      let response = await post(payload);
      if (telegram && response.ok !== true && /parse|entit/i.test(String(response.description ?? ''))) {
        delete payload.parse_mode;
        payload.text = item.plain;
        response = await post(payload);
      } else if (!telegram && response.code !== 0) {
        let changed = false;
        payload.card.elements = payload.card.elements.map((element: Record<string, any>) => {
          if (element.tag !== 'markdown') return element;
          changed = true;
          return { tag: 'div', text: { tag: 'lark_md', content: element.content } };
        });
        if (changed) response = await post(payload);
      }
      if (telegram ? response.ok === true : response.code === 0) {
        sent++;
        if (plan.onSent) await plan.onSent(item, response);
      }
      else { failed.add(item.recipient); error = t('channels.rejected'); }
    } catch (cause) {
      failed.add(item.recipient);
      error = cause instanceof TransportError ? cause.message : t('channels.sendFailed');
    }
    if (!telegram && !failed.has(item.recipient) && index + 1 < plan.items.length) await sleep(250);
  }
  return { channel: plan.channel, sent, planned: plan.items.length, ok: sent > 0 && sent === plan.items.length && !error, error };
}
