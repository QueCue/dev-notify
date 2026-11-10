import { digest, stateTransaction, targetEpoch, authorizedChat, replyAccesses, replyChannel, interactionExpired, INTERACTION_RESULT_MS, type Interaction, type InteractionResult, type ReplyAccess, type ReplyState, type SessionTarget } from './reply-state.js';
import { t } from './i18n.js';
import { ConfigError } from './config.js';
import { replyHint, type TelegramApi } from './reply-telegram.js';
import { showInteraction } from './reply-interactions.js';

// PermissionRequest 没有 tool_use_id：只接受唯一且尚未结束的同输入调用，歧义时保留本机处理。
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const inputFingerprint = (value: unknown) => digest(JSON.stringify(canonical(value)) ?? 'null');
export const callKey = (session: string, id: string) => digest(JSON.stringify([session, id]));
export function finishInteraction(value: Interaction, result: InteractionResult): void {
  if (value.result) return;
  value.result = result;
  value.updated = Date.now();
  value.expires ??= value.updated + INTERACTION_RESULT_MS;
  for (const receipt of value.receipts ?? []) receipt.result ??= result;
  // 留下短期结果和消息 ID，用于反馈及旧按钮；不保留已结束的问题、参数和答案正文。
  value.input = {}; value.questions = []; value.answers = {}; value.selected = [];
  delete value.response;
  for (const receipt of value.receipts ?? []) { receipt.answer = ''; delete receipt.question; }
}
function endLabel(result: InteractionResult): string {
  if (result.kind === 'unknown') return t('reply.buttonUnknown');
  if (result.kind === 'applied') return t('reply.buttonApplied');
  switch (result.reason) {
    case 'expired': return t('reply.buttonExpired');
    case 'session': case 'switched': return t('reply.buttonInvalid');
    case 'closed': return t('reply.buttonClosed');
    case 'processed': return t('reply.buttonProcessed');
    default: return t('reply.buttonEnded');
  }
}
export function endSessionInteractions(state: ReplyState, session: string, reason: string): void {
  for (const call of Object.values(state.calls)) if (call.session === session) call.ended = true;
  for (const value of Object.values(state.requests)) if (value.session === session && !value.result) finishInteraction(value, {
    kind: value.claimed ? 'unknown' : 'not-applied', reason: 'session',
    text: reason + (value.claimed ? t('reply.sessionUnknownSuffix') : t('reply.sessionUnsentSuffix')),
  });
}
export async function registerToolCall(access: ReplyAccess, target: SessionTarget, data: any): Promise<void> {
  if (typeof data.tool_use_id !== 'string' || !data.tool_use_id || typeof data.tool_name !== 'string' || !data.tool_input) return;
  const key = callKey(target.session, data.tool_use_id);
  await stateTransaction(access, state => {
    if (state.calls[key]) return;
    const previous = state.sessions[target.session];
    if (previous?.unverified === true || target.unverified === true) throw new ConfigError(t('reply.sessionUnavailable'));
    state.sessions[target.session] = { ...target, working: true, latestCall: key, tracked: previous?.tracked === true && targetEpoch(previous) === targetEpoch(target) };
    state.calls[key] = { id: data.tool_use_id, session: target.session, epoch: targetEpoch(target), tool: data.tool_name,
      fingerprint: inputFingerprint(data.tool_input), prompt: typeof data.prompt_id === 'string' ? data.prompt_id : undefined, updated: Date.now() };
    // 正常工具不一定有权限请求，限制关联索引大小。丢失索引只会回到本机，不会猜目标。
    const old = Object.entries(state.calls).filter(([, call]) => !call.request).sort((a, b) => a[1].updated - b[1].updated);
    for (const [id] of old.slice(0, Math.max(0, old.length - 256))) delete state.calls[id];
  });
}
export function matchingCall(state: ReplyState, target: SessionTarget, data: any): string | undefined {
  const fingerprint = inputFingerprint(data.tool_input);
  const matches = Object.entries(state.calls).filter(([, call]) => call.session === target.session && call.epoch === targetEpoch(target)
    && call.tool === data.tool_name && call.fingerprint === fingerprint
    && (typeof data.prompt_id !== 'string' || call.prompt === data.prompt_id));
  // 包括已结束的同内容记录，防止迟到的 PermissionRequest 误绑到重复的新题。
  if (matches.length !== 1 || matches[0][1].ended || matches[0][1].request || Date.now() - matches[0][1].updated > 300000) return;
  return matches[0][0];
}
function sameAnswer(actual: unknown, expected: string, multi: boolean): boolean {
  if (!multi) return actual === expected;
  const parts = (value: string | string[]) => [...(Array.isArray(value) ? value : value.split(',')).map(s => s.trim())].sort();
  return (typeof actual === 'string' || Array.isArray(actual) && actual.every(s => typeof s === 'string'))
    && JSON.stringify(parts(actual)) === JSON.stringify(parts(expected));
}
export async function completeToolCall(access: ReplyAccess, data: any): Promise<void> {
  if (typeof data.session_id !== 'string' || typeof data.tool_use_id !== 'string') return;
  await stateTransaction(access, state => {
    const call = state.calls[callKey(data.session_id, data.tool_use_id)];
    if (!call || call.tool !== data.tool_name) return;
    call.ended = true;
    const value = call.request && state.requests[call.request];
    if (!value || value.result) return;
    if (data.hook_event_name === 'PostToolUse' && value.kind === 'question') {
      const output = data.tool_response;
      const answers = output?.answers;
      const valid = answers && typeof answers === 'object' && !Array.isArray(answers);
      const answered = !output?.afkTimeoutMs && output?.followUp !== true && !(typeof output?.response === 'string' && output.response.trim());
      for (const receipt of value.receipts ?? []) {
        const q = value.questions.find(q => q.question === receipt.question);
        const exists = valid && answered && receipt.question !== undefined && Object.hasOwn(answers, receipt.question)
          && !output.annotations?.[receipt.question]?.unanswered;
        receipt.result = !value.claimed ? { kind: 'not-applied', text: t('reply.earlierHandled') }
          : !valid ? { kind: 'unknown', text: t('reply.noVerifiableResult') }
          : exists && sameAnswer(answers[receipt.question!], receipt.answer, q?.multiSelect === true && receipt.custom !== true && q.options.every(o => !o.label.includes(',')))
            ? { kind: 'applied', text: t('reply.answerApplied') }
            : { kind: 'not-applied', text: t('reply.answerNotApplied') };
      }
      finishInteraction(value, { kind: 'not-applied', reason: 'processed', text: t('reply.questionProcessed') });
    } else if (data.hook_event_name === 'PostToolUse' && value.kind === 'permission') {
      const allow = value.claimed && value.receipts?.some(r => r.answer === 'allow');
      finishInteraction(value, allow
        ? { kind: 'applied', reason: 'processed', text: t('reply.permissionApplied') }
        : { kind: 'not-applied', reason: 'processed', text: t('reply.permissionNotApplied') });
    } else finishInteraction(value, { kind: value.claimed ? 'unknown' : 'not-applied', reason: 'failed', text: value.claimed
      ? t('reply.toolFailedUnknown')
      : t('reply.toolFailed') });
  });
}
export async function drainInteractionFeedback(access: ReplyAccess, api: TelegramApi,
  fresh: () => Promise<ReplyAccess | null>, log: (text: string) => void = () => {}): Promise<void> {
  const current = await fresh();
  if (!current || current.identity !== access.identity) return;
  if (access.grants) {
    const active = await stateTransaction(access, state => Object.values(state.requests).filter(value => !value.result && !value.response && !value.claimed && !interactionExpired(value)
      && state.sessions[value.session]?.unverified !== true && state.sessions[value.session] && targetEpoch(state.sessions[value.session]) === value.epoch));
    for (const value of active) for (const view of replyAccesses(access)) {
      if (value.kind === 'permission' && view.policy.permissions !== true) continue;
      for (const chat of view.policy.users) {
        if (value.displayed?.[`${replyChannel(view)}:${chat}`] === value.index) continue;
        const final = await fresh();
        if (!final || final.identity !== access.identity) return;
        await showInteraction(view, value.id, chat, api, true).catch(() => log(t('reply.feedbackFailedLog')));
      }
    }
  }
  const work = await stateTransaction(access, state => {
    for (const value of Object.values(state.requests)) {
      if (value.result) continue;
      const target = state.sessions[value.session];
      const ended = !target || targetEpoch(target) !== value.epoch;
      if (!ended && !interactionExpired(value)) continue;
      finishInteraction(value, {
        kind: value.claimed ? 'unknown' : 'not-applied',
        reason: ended ? 'session' : 'expired',
        text: value.claimed
          ? t('reply.waitTimeoutUnknown')
          : ended
            ? t('reply.sessionEndedUnsent')
            : t('reply.expiredUnanswered'),
      });
    }
    return Object.values(state.requests).filter(value => value.result || value.receipts?.some(r => r.result) || access.grants && value.response);
  });
  for (const value of work) {
    for (const receipt of value.receipts ?? []) {
      if (!receipt.result || receipt.delivery) continue;
      const authorized = await fresh();
      if (!authorized || authorized.identity !== access.identity || !authorizedChat(authorized, receipt.chat)) return;
      const claimed = await stateTransaction(access, state => {
        const actual = state.requests[value.id]?.receipts?.find(r => r.id === receipt.id);
        if (!actual?.result || actual.delivery) return false;
        actual.delivery = 'sending'; return true;
      });
      if (!claimed) continue;
      let delivery: 'sent' | 'unknown' = 'sent';
      try {
        const title = receipt.result.kind === 'applied' ? t('reply.appliedTitle') : receipt.result.kind === 'not-applied' ? t('reply.notAppliedTitle') : t('reply.resultUnknownTitle');
        await replyHint(api, receipt.chat, title, receipt.result.text + t('reply.requestLabel', { id: value.id.slice(0, 8) }));
      } catch { delivery = 'unknown'; log(t('reply.feedbackFailedLog')); }
      await stateTransaction(access, state => {
        const actual = state.requests[value.id]?.receipts?.find(r => r.id === receipt.id);
        if (actual) actual.delivery = delivery;
      });
    }
    if (!value.result) {
      if (access.grants && value.response) for (const message of value.messages ?? []) {
        if (message.registered) continue;
        const final = await fresh();
        if (!final || final.identity !== access.identity || !authorizedChat(final, message.chat)) return;
        const claimed = await stateTransaction(access, state => {
          const actual = state.requests[value.id]?.messages?.find(item => item.chat === message.chat && item.message === message.message);
          if (!actual || actual.registered) return false;
          actual.registered = true; return true;
        });
        if (!claimed) continue;
        if (typeof message.message === 'number') await api('editMessageReplyMarkup', { chat_id: message.chat, message_id: message.message,
          reply_markup: { inline_keyboard: [[{ text: t('reply.pendingConfirmationTitle'), callback_data: `dn:q:${value.id}:0:l` }]] } }).catch(() => {});
        else await replyHint(api, message.chat, t('reply.pendingConfirmationTitle'), t('reply.pendingSubmitted'), message.message).catch(() => {});
      }
      continue;
    }
    for (const message of value.messages ?? []) {
      if (message.cleared) continue;
      const authorized = await fresh();
      if (!authorized || authorized.identity !== access.identity || !authorizedChat(authorized, message.chat)) return;
      // 最多尝试一次移除按钮；编辑失败时旧回调仍由服务端状态拒绝。
      await stateTransaction(access, state => {
        const actual = state.requests[value.id]?.messages?.find(m => m.chat === message.chat && m.message === message.message);
        if (actual) actual.cleared = true;
      });
      const label = endLabel(value.result);
      if (typeof message.message === 'string') await replyHint(api, message.chat, label, value.result.text, message.message)
        .catch(() => log(t('reply.feedbackFailedLog')));
      else await api('editMessageReplyMarkup', { chat_id: message.chat, message_id: message.message,
        reply_markup: { inline_keyboard: [[{ text: label, callback_data: `dn:q:${value.id}:0:l` }]] } })
        .catch(() => log(t('reply.clearButtonsFailedLog')));
    }
  }
}
