import { randomBytes } from 'node:crypto';
import { ConfigError } from './config.js';
import { digest, targetEpoch, stateTransaction, TTL, type ReplyAccess, type Entry, type SessionTarget } from './reply-state.js';
import { handleInteractionCallback, handleInteractionText, showInteraction } from './reply-interactions.js';
import { injectReply, sanitizeReply, validateTarget } from './reply-platform.js';
import { replyHint, type TelegramApi } from './reply-telegram.js';

export const sessionEpoch = targetEpoch;
export const textHash = (text: string) => digest(text.replace(/\s+/g, ' ').trim());
export interface EngineContext {
  api: TelegramApi;
  fresh: () => Promise<ReplyAccess | null>;
  validate?: (target: SessionTarget) => Promise<boolean>;
  inject?: (target: SessionTarget, text: string) => Promise<void>;
}
function privateUser(message: any, sender: any): string | null {
  const chat = message?.chat;
  if (chat?.type !== 'private' || !Number.isSafeInteger(chat.id) || chat.id <= 0
    || !Number.isSafeInteger(sender?.id) || sender.id !== chat.id || sender.is_bot === true) return null;
  return String(chat.id);
}
export async function resolveEntry(access: ReplyAccess, key: string, context: EngineContext): Promise<{ entry: Entry; target: SessionTarget } | null> {
  const resolved = await stateTransaction(access, state => {
    const entry = state.entries[key], target = entry && state.sessions[entry.session];
    return entry && target && (target.tracked === true || !!entry.request) && entry.epoch === sessionEpoch(target) && Date.now() - entry.updated < TTL ? { entry, target } : null;
  });
  if (!resolved || !await (context.validate ?? (target => validateTarget(target)))(resolved.target)) return null;
  return resolved;
}
async function prompt(access: ReplyAccess, chat: string, messageId: number, key: string, context: EngineContext): Promise<void> {
  const resolved = await resolveEntry(access, key, context);
  if (!resolved) { await replyHint(context.api, chat, '⚠️ 无法回复', '该会话已关闭、切换或通知过期，请从最新通知进入。', messageId); return; }
  if (resolved.entry.request) { await showInteraction(access, resolved.entry.request, chat, context.api); return; }
  const sent = await replyHint(context.api, chat, '💬 回复 Claude', '请回复此消息输入内容。该输入将提交到对应本机会话。\n会话：' + (resolved.target.title || resolved.target.session),
    messageId, { force_reply: true, selective: true });
  if (Number.isSafeInteger(sent?.message_id)) await stateTransaction(access, state => { state.entries[`tg:${chat}:${sent.message_id}`] = resolved.entry; });
}
export async function processUpdate(access: ReplyAccess, update: any, context: EngineContext): Promise<void> {
  try { await processAuthorizedUpdate(access, update, context); }
  catch (error) {
    const message = update?.callback_query?.message ?? update?.message;
    const sender = update?.callback_query?.from ?? update?.message?.from;
    const chat = privateUser(message, sender);
    const current = await context.fresh().catch(() => null);
    if (chat && current?.identity === access.identity && current.policy.users.includes(chat)) {
      if (typeof update?.callback_query?.id === 'string') await context.api('answerCallbackQuery', {
        callback_query_id: update.callback_query.id, text: '处理失败或结果未知，请检查终端；不会自动重复提交',
      }).catch(() => {});
      await replyHint(context.api, chat, '⚠️ 本次提交结果无法确认',
        '处理发生异常，无法确认是否已登记或采用。请检查终端及后续结果反馈；不会自动重复提交。').catch(() => {});
    }
    throw error;
  }
}
async function processAuthorizedUpdate(access: ReplyAccess, update: any, context: EngineContext): Promise<void> {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return;
  const current = await context.fresh();
  if (!current || current.identity !== access.identity) return;
  // 先提交 offset；强杀可能丢失本条，但不能重放已授权的终端输入。
  const claimed = await stateTransaction(access, state => {
    if (update.update_id < state.offset) return false;
    state.offset = update.update_id + 1; return true;
  });
  if (!claimed) return;
  if (update.callback_query) {
    const callback = update.callback_query, chat = privateUser(callback.message, callback.from);
    if (!chat || !current.policy.users.includes(chat)) return;
    const value = callback.data;
    if (typeof value === 'string' && value.startsWith('dn:q:')) {
      const id = value.split(':')[2];
      if (!/^[a-f0-9]{32}$/.test(id) || !await resolveEntry(access, 'token:' + id, context)) {
        await context.api('answerCallbackQuery', { callback_query_id: callback.id, text: '会话已关闭或交互已失效' }).catch(() => {});
        await replyHint(context.api, chat, '⚠️ 本次提交未生效', '会话已关闭、切换或交互已失效；未回传答案。').catch(() => {}); return;
      }
      if (await handleInteractionCallback(access, callback, chat, context.api)) return;
    }
    if (typeof value !== 'string' || !/^dn:r:[a-f0-9]{32}$/.test(value) || typeof callback.id !== 'string') return;
    await context.api('answerCallbackQuery', { callback_query_id: callback.id, text: '请在回复框输入内容' });
    await prompt(access, chat, callback.message.message_id, 'token:' + value.slice(5), context);
    return;
  }
  const message = update.message, chat = privateUser(message, message?.from);
  if (!chat || typeof message.text !== 'string' || !Number.isSafeInteger(message.message_id)) return;
  const text = message.text.trim();
  if (text === '/chatid') { await replyHint(context.api, chat, 'Telegram chat_id', chat, message.message_id); return; }
  if (!current.policy.users.includes(chat)) return;
  if (typeof message.date === 'number' && Date.now() / 1000 - message.date > 300) {
    await replyHint(context.api, chat, '⚠️ 本次提交未生效', '这条输入消息已超过有效时间，未回传；请查看最新问题或终端状态。'); return;
  }
  if (/^\/start\s+[a-f0-9]{32}$/.test(text)) {
    await prompt(access, chat, message.message_id, 'token:' + text.split(/\s+/)[1], context); return;
  }
  const replyTo = message.reply_to_message?.message_id;
  if (!Number.isSafeInteger(replyTo)) {
    await replyHint(context.api, chat, '💬 回复方式', '请直接回复任务完成通知，或点击通知里的「回复 Claude」按钮。', message.message_id); return;
  }
  const resolved = await resolveEntry(access, `tg:${chat}:${replyTo}`, context);
  if (!resolved) { await replyHint(context.api, chat, '⚠️ 无法回复', '通知已过期或对应会话已关闭、切换，请从最新通知回复。', message.message_id); return; }
  if (resolved.entry.request) { await handleInteractionText(access, resolved.entry.request, chat, message, context.api); return; }
  let safe;
  try { safe = sanitizeReply(message.text); }
  catch (error) { await replyHint(context.api, chat, '❌ 未提交回复', error instanceof ConfigError ? error.message : '输入无效', message.message_id); return; }
  const id = randomBytes(16).toString('hex');
  const queued = await stateTransaction(access, state => {
    const target = state.sessions[resolved.target.session];
    if (!target || sessionEpoch(target) !== resolved.entry.epoch) throw new ConfigError('会话已变化，未提交');
    if (state.pending[target.session] && Date.now() - state.pending[target.session].updated < 5 * 60 * 1000) return null;
    state.pending[target.session] = { hash: textHash(safe), text: safe, epoch: resolved.entry.epoch, id, updated: Date.now(), queued: target.working,
      phase: 'queued', chat, message: message.message_id };
    return target.working;
  });
  if (queued === null) { await replyHint(context.api, chat, '⏳ 未提交新回复', '该会话已有未确认回复，请等待收到确认或检查本机终端后再试。', message.message_id); return; }
  if (queued) await replyHint(context.api, chat, '⏳ 回复已排队', 'Claude 正在处理当前任务；本地队列将在本轮结束后尝试提交，不会把文本输入到正在等待权限的弹窗。', message.message_id);
  else await drainReplies(access, context);
}
export async function drainReplies(access: ReplyAccess, context: EngineContext): Promise<void> {
  const queued = await stateTransaction(access, state => Object.entries(state.pending)
    .filter(([session, value]) => value.phase === 'queued' && (!state.sessions[session]?.working || Date.now() - value.updated > 5 * 60 * 1000))
    .map(([session, pending]) => ({ target: state.sessions[session], pending })));
  for (const item of queued) {
    const { target, pending } = item;
    if (!target || !pending.text) continue;
    try {
      const current = await context.fresh();
      if (!current || current.identity !== access.identity || !current.policy.users.includes(pending.chat)) return;
      if (Date.now() - pending.updated > 5 * 60 * 1000) throw new ConfigError('排队回复已超过 5 分钟，未提交；请检查本机后重新回复');
      if (!target.tracked || pending.epoch !== sessionEpoch(target) || !await (context.validate ?? (value => validateTarget(value)))(target)) throw new ConfigError('会话已关闭或切换，未提交');
      const text = pending.text;
      const claimed = await stateTransaction(access, state => {
        const actual = state.pending[target.session], active = state.sessions[target.session];
        if (!actual || actual.id !== pending.id || actual.phase !== 'queued' || active?.working || sessionEpoch(active) !== sessionEpoch(target)) return false;
        actual.phase = 'submitted'; delete actual.text; return true;
      });
      if (!claimed) continue;
      // 输入前再次核验授权，撤销后不发送。原生调用一旦开始，不能撤回或保证无竞态。
      const final = await context.fresh();
      if (!final || final.identity !== access.identity) return;
      await (context.inject ?? ((value, content) => injectReply(value, content)))(target, text);
      await replyHint(context.api, pending.chat, '✅ 已转发给 Claude', '终端输入已提交，等待 UserPromptSubmit 确认；这不等于 Claude 已开始处理。', pending.message);
    } catch (error) {
      await stateTransaction(access, state => {
        const value = state.pending[target.session];
        if (value?.id === pending.id) { value.phase = 'unknown'; delete value.text; }
      });
      await replyHint(context.api, pending.chat, '⚠️ 转发未确认', error instanceof ConfigError ? error.message : '提交失败或结果未知，请检查本机终端；不会自动重复提交。', pending.message).catch(() => {});
    }
  }
}
