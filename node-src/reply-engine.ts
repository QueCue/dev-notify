import { randomBytes } from 'node:crypto';
import { ConfigError } from './config.js';
import { t } from './i18n.js';
import { digest, targetEpoch, stateTransaction, TTL, messageKey, validMessageId, replyChannel, authorizedChat, type ReplyAccess, type Entry, type SessionTarget } from './reply-state.js';
import { handleInteractionCallback, handleInteractionText, showInteraction } from './reply-interactions.js';
import { injectReply, sanitizeReply, validateTarget, SessionLookupError } from './reply-platform.js';
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
export type ReplyResolutionFailure = 'mapping-missing' | 'session-missing' | 'session-changed' | 'mapping-expired' | 'input-unobserved' | 'verification-paused' | 'interaction-ended';
export async function resolveEntry(access: ReplyAccess, key: string, context: EngineContext,
  onFailure?: (reason: ReplyResolutionFailure) => void): Promise<{ entry: Entry; target: SessionTarget } | null> {
  const fail = (reason: ReplyResolutionFailure) => { onFailure?.(reason); return null; };
  const resolved = await stateTransaction<{ reason: ReplyResolutionFailure } | { entry: Entry; target: SessionTarget }>(access, state => {
    const entry = state.entries[key], target = entry && state.sessions[entry.session];
    if (!entry) return { reason: 'mapping-missing' as const };
    if (!target) return { reason: 'session-missing' as const };
    if (entry.epoch !== sessionEpoch(target)) return { reason: 'session-changed' as const };
    if (Date.now() - entry.updated >= TTL) return { reason: 'mapping-expired' as const };
    if (!target.tracked && !entry.request) return { reason: 'input-unobserved' as const };
    const request = entry.request && state.requests[entry.request];
    // 只有仍在等待的原始结构化请求可以请求重新核验；普通终端输入维持原来的暂停规则。
    const recoverable = !!request && request.session === entry.session && request.epoch === entry.epoch
      && !request.result && !request.response && !request.claimed && request.expires > Date.now()
      && (!request.call || state.calls[request.call]?.request === request.id && !state.calls[request.call]?.ended);
    if (target.unverified && !recoverable) return { reason: entry.request ? 'interaction-ended' as const : 'verification-paused' as const };
    return { entry, target };
  });
  if ('reason' in resolved) return fail(resolved.reason);
  const recovering = resolved.target.unverified === true;
  // 仅清除用于阻止旧状态的标记后执行真实查询；仍须核对 session/PID/birth/TTY，不把旧快照当作证明。
  const candidate = recovering ? { ...resolved.target, unverified: false } : resolved.target;
  try {
    if (!await (context.validate ?? (target => validateTarget(target)))(candidate)) return fail('session-changed');
  } catch (error) {
    if (error instanceof SessionLookupError) return fail('verification-paused');
    throw error;
  }
  const current = await context.fresh();
  if (!current || current.identity !== access.identity) return fail('session-changed');
  if (!recovering) return resolved;
  return stateTransaction(current, state => {
    const entry = state.entries[key], target = state.sessions[resolved.target.session];
    const request = entry?.request && state.requests[entry.request];
    if (!entry || !target || entry.request !== resolved.entry.request || entry.epoch !== resolved.entry.epoch
      || sessionEpoch(target) !== resolved.entry.epoch) return fail('session-changed');
    if (!request || request.result || request.response || request.claimed || request.expires <= Date.now()
      || request.call && (state.calls[request.call]?.request !== request.id || state.calls[request.call]?.ended)) return fail('interaction-ended');
    // 查询期间其他 hook 又更新了会话时，不覆盖较新的核验决定。
    if (target.updated !== resolved.target.updated) return fail('verification-paused');
    delete target.unverified;
    return { entry, target };
  });
}
// autoReply：Telegram 内联按钮沿用 force_reply，点击后自动进入回复状态。
// 飞书跳转使用普通提示 + remove_keyboard：清除客户端缓存的旧强制回复目标，但不拉起新的回复框。
async function prompt(access: ReplyAccess, chat: string, messageId: number, key: string, context: EngineContext, autoReply = true): Promise<void> {
  const resolved = await resolveEntry(access, key, context);
  if (!resolved) { await replyHint(context.api, chat, t('reply.sessionGoneTitle'), t('reply.sessionGoneBody'), messageId); return; }
  if (resolved.entry.request) { await showInteraction(access, resolved.entry.request, chat, context.api); return; }
  const session = resolved.target.title || resolved.target.session;
  const sent = autoReply
    ? await replyHint(context.api, chat, t('reply.replyPromptTitle'), t('reply.replyPromptBody', { session }),
      messageId, { force_reply: true, selective: true })
    : await replyHint(context.api, chat, t('reply.replyPromptTitle'), t('reply.replyPromptLongPress', { session }),
      messageId, { remove_keyboard: true });
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
        callback_query_id: update.callback_query.id, text: t('reply.processingFailedCallback'),
      }).catch(() => {});
      await replyHint(context.api, chat, t('reply.processingFailedTitle'),
        t('reply.processingFailedBody')).catch(() => {});
    }
    throw error;
  }
}
async function processAuthorizedUpdate(access: ReplyAccess, update: any, context: EngineContext): Promise<void> {
  if (replyChannel(access) !== 'telegram' || !Number.isSafeInteger(update?.update_id) || update.update_id < 0) return;
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
        await context.api('answerCallbackQuery', { callback_query_id: callback.id, text: t('reply.interactionExpiredCallback') }).catch(() => {});
        await replyHint(context.api, chat, t('reply.interactionExpiredTitle'), t('reply.interactionExpiredBody')).catch(() => {}); return;
      }
      if (await handleInteractionCallback(access, callback, chat, context.api)) return;
    }
    if (typeof value !== 'string' || !/^dn:r:[a-f0-9]{32}$/.test(value) || typeof callback.id !== 'string') return;
    await context.api('answerCallbackQuery', { callback_query_id: callback.id, text: t('reply.replyBoxHint') });
    await prompt(access, chat, callback.message.message_id, 'token:' + value.slice(5), context);
    return;
  }
  const message = update.message, chat = privateUser(message, message?.from);
  if (!chat || typeof message.text !== 'string' || !Number.isSafeInteger(message.message_id)) return;
  await processMessage(access, message, chat, context, current);
}
async function processMessage(access: ReplyAccess, message: any, chat: string, context: EngineContext, current: ReplyAccess): Promise<void> {
  const text = message.text.trim();
  if (replyChannel(access) === 'telegram' && text === '/chatid') { await replyHint(context.api, chat, 'Telegram chat_id', chat, message.message_id); return; }
  if (!current.policy.users.includes(chat)) return;
  if (typeof message.date === 'number' && Date.now() / 1000 - message.date > 300) {
    await replyHint(context.api, chat, t('reply.staleTitle'), t('reply.staleBody')); return;
  }
  if (replyChannel(access) === 'telegram' && /^\/start\s+[a-f0-9]{32}$/.test(text)) {
    // 飞书跳转：只发普通提示并清除旧键盘状态，不自动进入回复。
    await prompt(access, chat, message.message_id, 'token:' + text.split(/\s+/)[1], context, false); return;
  }
  const replyTo = message.reply_to_message?.message_id;
  if (!validMessageId(replyTo)) {
    await replyHint(context.api, chat, t('reply.howToTitle'), t(replyChannel(access) === 'feishu' ? 'feishu.replyHint' : 'reply.howToBody'), message.message_id); return;
  }
  const failure: { reason: ReplyResolutionFailure } = { reason: 'session-changed' };
  const resolved = await resolveEntry(access, messageKey(access, chat, replyTo), context, reason => { failure.reason = reason; });
  if (!resolved) {
    const detail = failure.reason === 'mapping-missing' ? 'reply.mappingMissingBody'
      : failure.reason === 'verification-paused' || failure.reason === 'input-unobserved' ? 'reply.verificationPausedBody'
      : failure.reason === 'interaction-ended' ? 'reply.interactionExpiredBody' : 'reply.expiredReplyBody';
    await replyHint(context.api, chat, t('reply.sessionGoneTitle'), t(detail), message.message_id); return;
  }
  if (resolved.entry.request) { await handleInteractionText(access, resolved.entry.request, chat, message, context.api); return; }
  let safe;
  try { safe = sanitizeReply(message.text); }
  catch (error) { await replyHint(context.api, chat, t('reply.replyFailedTitle'), error instanceof ConfigError ? error.message : t('reply.invalidInput'), message.message_id); return; }
  const id = randomBytes(16).toString('hex');
  const queued = await stateTransaction(access, state => {
    const target = state.sessions[resolved.target.session];
    if (!target || target.unverified === true || sessionEpoch(target) !== resolved.entry.epoch) throw new ConfigError(t('reply.sessionChanged'));
    if (state.pending[target.session] && Date.now() - state.pending[target.session].updated < 5 * 60 * 1000) return null;
    state.pending[target.session] = { hash: textHash(safe), text: safe, epoch: resolved.entry.epoch, id, updated: Date.now(), queued: target.working,
      phase: 'queued', chat, message: message.message_id };
    return target.working;
  });
  if (queued === null) { await replyHint(context.api, chat, t('reply.pendingTitle'), t('reply.pendingBody'), message.message_id); return; }
  if (queued) await replyHint(context.api, chat, t('reply.queuedTitle'), t('reply.queuedBody'), message.message_id);
  else await drainReplies(access, context);
}
export async function drainFeishuInbox(access: ReplyAccess, context: EngineContext): Promise<void> {
  if (replyChannel(access) !== 'feishu') return;
  for (let i = 0; i < 100; i++) {
    const current = await context.fresh();
    if (!current || current.identity !== access.identity) return;
    // 先移除持久消息再处理；崩溃时允许丢失，但绝不重放终端输入或权限决定。
    const message = await stateTransaction(access, state => {
      const value = Object.values(state.feishuInbox ?? {})[0];
      if (value) delete state.feishuInbox![value.id];
      return value;
    });
    if (!message) return;
    if (!current.policy.users.includes(message.user)) continue;
    await processMessage(access, { message_id: message.id, text: message.text, date: message.created / 1000,
      reply_to_message: { message_id: message.parent } }, message.user, context, current);
  }
}
export async function drainReplies(access: ReplyAccess, context: EngineContext): Promise<void> {
  const queued = await stateTransaction(access, state => Object.entries(state.pending)
    .filter(([session, value]) => value.phase === 'queued' && (Date.now() - value.updated > 5 * 60 * 1000
      || (!state.sessions[session]?.working && state.sessions[session]?.unverified !== true)))
    .map(([session, pending]) => ({ target: state.sessions[session], pending })));
  for (const item of queued) {
    const { target, pending } = item;
    if (!target || !pending.text) continue;
    try {
      const current = await context.fresh();
      if (!current || current.identity !== access.identity) return;
      if (!authorizedChat(current, pending.chat)) continue;
      if (Date.now() - pending.updated > 5 * 60 * 1000) throw new ConfigError(t('reply.queueExpired'));
      if (!target.tracked || pending.epoch !== sessionEpoch(target) || !await (context.validate ?? (value => validateTarget(value)))(target)) throw new ConfigError(t('reply.sessionClosed'));
      const text = pending.text;
      const claimed = await stateTransaction(access, state => {
        const actual = state.pending[target.session], active = state.sessions[target.session];
        if (!actual || actual.id !== pending.id || actual.phase !== 'queued' || active?.working || active?.unverified === true || sessionEpoch(active) !== sessionEpoch(target)) return false;
        actual.phase = 'submitted'; delete actual.text; return true;
      });
      if (!claimed) continue;
      // 输入前再次核验授权，撤销后不发送。原生调用一旦开始，不能撤回或保证无竞态。
      const final = await context.fresh();
      if (!final || final.identity !== access.identity) return;
      await (context.inject ?? ((value, content) => injectReply(value, content)))(target, text);
      await replyHint(context.api, pending.chat, t('reply.forwardedTitle'), t('reply.forwardedBody'), pending.message);
    } catch (error) {
      if (error instanceof SessionLookupError) {
        const paused = await stateTransaction(access, state => {
          const value = state.pending[target.session], active = state.sessions[target.session];
          if (value?.id !== pending.id || value.phase !== 'queued') return false;
          if (active && sessionEpoch(active) === pending.epoch) active.unverified = true;
          return true;
        });
        if (paused) continue; // 未开始注入的任务保留原TTL；已提交/结果未知的任务绝不重新排队。
      }
      await stateTransaction(access, state => {
        const value = state.pending[target.session];
        if (value?.id === pending.id) { value.phase = 'unknown'; delete value.text; }
      });
      await replyHint(context.api, pending.chat, t('reply.forwardUnknownTitle'), error instanceof ConfigError ? error.message : t('reply.forwardFailed'), pending.message).catch(() => {});
    }
  }
}
