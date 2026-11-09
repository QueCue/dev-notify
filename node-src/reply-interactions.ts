import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigError } from './config.js';
import { t } from './i18n.js';
import { stateTransaction, targetEpoch, replyChannel, messageKey, validMessageId, type Entry, type Interaction, type Question, type ReplyAccess, type SessionTarget } from './reply-state.js';
import { replyHint, type TelegramApi } from './reply-telegram.js';
import { finishInteraction } from './reply-outcomes.js';

export const INTERACTION_MS = 10 * 60 * 1000;
export function questionsFrom(input: Record<string, any>): Question[] {
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) throw new ConfigError(t('reply.invalidQuestions'));
  const questions = input.questions as Question[];
  const seen = new Set<string>();
  for (const q of questions) {
    if (!q || typeof q.question !== 'string' || !q.question.trim() || seen.has(q.question)
      || typeof q.header !== 'string' || (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') || !Array.isArray(q.options)
      || q.options.length < 2 || q.options.length > 4 || q.options.some(o => !o || typeof o.label !== 'string' || !o.label.trim()
        || typeof o.description !== 'string') || new Set(q.options.map(o => o.label)).size !== q.options.length) {
      throw new ConfigError(t('reply.invalidQuestions'));
    }
    seen.add(q.question);
  }
  return structuredClone(questions);
}
export async function createInteraction(access: ReplyAccess, target: SessionTarget, kind: Interaction['kind'], input: Record<string, any>, call?: string): Promise<Interaction> {
  if (kind === 'permission' && access.policy.permissions !== true) throw new ConfigError(t('reply.permissionsNotAuthorized'));
  const questions = kind === 'question' ? questionsFrom(input) : [];
  const value: Interaction = { id: randomBytes(16).toString('hex'), session: target.session, epoch: targetEpoch(target),
    updated: Date.now(), expires: Date.now() + INTERACTION_MS, kind, input: structuredClone(input), questions,
    answers: {}, selected: [], index: 0, call, receipts: [], messages: [] };
  await stateTransaction(access, state => {
    const current = state.sessions[target.session];
    if (!current || current.unverified === true || targetEpoch(current) !== value.epoch) throw new ConfigError(t('reply.targetChanged'));
    if (call) {
      const bound = state.calls[call];
      if (!bound || bound.ended || bound.request || bound.epoch !== value.epoch) throw new ConfigError(t('reply.callUnavailable'));
      bound.request = value.id;
    }
    // 不同 tool_use_id 可并行；无绑定的单元级调用仍只保留一个活动交互。
    if (!call) for (const old of Object.values(state.requests)) if (old.session === target.session && !old.result) {
      finishInteraction(old, { kind: old.claimed ? 'unknown' : 'not-applied', reason: 'switched', text: t('reply.questionSwitched') });
    }
    state.requests[value.id] = value;
    state.entries['token:' + value.id] = { session: target.session, epoch: value.epoch, request: value.id, updated: Date.now() };
  });
  return value;
}
function active(value: Interaction | undefined): value is Interaction {
  return !!value && !value.result && !value.response && !value.claimed && value.expires > Date.now();
}
export function interactionMarkup(value: Interaction): Record<string, any> {
  const prefix = `dn:q:${value.id}:${value.index}:`;
  const buttons: { text: string; callback_data: string }[][] = [];
  if (value.kind === 'permission') {
    buttons.push([{ text: t('reply.allowButton'), callback_data: prefix + 'a' }, { text: t('reply.denyButton'), callback_data: prefix + 'd' }]);
    buttons.push([{ text: t('reply.customDenyButton'), callback_data: prefix + 'c' }]);
  } else {
    const q = value.questions[value.index];
    q.options.forEach((option, index) => buttons.push([{ text: (value.selected.includes(index) ? '☑ ' : '') + Array.from(option.label).slice(0, 60).join(''), callback_data: prefix + 'o' + index }]));
    if (q.multiSelect) buttons.push([{ text: t('reply.submitSelected'), callback_data: prefix + 's' }]);
    buttons.push([{ text: t('reply.customInput'), callback_data: prefix + 'c' }]);
  }
  buttons.push([{ text: t('reply.closeRemote'), callback_data: prefix + 'l' }]);
  return { inline_keyboard: buttons };
}
export function interactionContent(value: Interaction, feishu = false): string {
  if (value.kind === 'permission') return t('reply.toolLabel', { tool: String(value.input.tool_name || t('reply.unknownTool')) }) + '\n\n' + JSON.stringify(value.input.tool_input ?? {}, null, 2)
    + '\n\n' + t('reply.permissionNote') + (feishu ? t('feishu.permissionHint') : '');
  const q = value.questions[value.index];
  return t('reply.questionHeading', { index: value.index + 1, total: value.questions.length, question: q.question }) + '\n\n'
    + q.options.map((o, i) => `${i + 1}. ${o.label}\n${o.description}${(o as any).preview ? '\n' + (o as any).preview : ''}`).join('\n\n')
    + (feishu ? t('feishu.questionHint') : q.multiSelect ? t('reply.multiSelectHint') : t('reply.singleSelectHint'))
    + t('reply.localWindowNote');
}
// 飞书卡片没有回调按钮，只展示全部题目和跳转入口；逐题编号并空行分隔，避免题目与选项粘连。
export function questionsContent(questions: Question[]): string {
  return questions.map((q, index) => t('reply.questionHeading', { index: index + 1, total: questions.length, question: q.question }) + '\n\n'
    + q.options.map((o, i) => `${i + 1}. ${o.label}\n${o.description}${(o as any).preview ? '\n' + (o as any).preview : ''}`).join('\n\n')
    + (q.multiSelect ? t('reply.feishuMultiSelectHint')
      : t('reply.feishuSingleSelectHint'))).join('\n\n────────\n\n');
}
export async function showInteraction(access: ReplyAccess, id: string, chat: string, api: TelegramApi, synchronize = false): Promise<void> {
  const value = await stateTransaction(access, state => state.requests[id]);
  if (!active(value)) { await replyHint(api, chat, t('reply.inactiveTitle'), t('reply.inactiveBody')); return; }
  if (!access.policy.users.includes(chat) || value.kind === 'permission' && access.policy.permissions !== true) return;
  if (access.grants) {
    const claimed = await stateTransaction(access, state => {
      const current = state.requests[id];
      if (!active(current) || current.index !== value.index) return false;
      const displayed = current.displayed ??= {}, key = `${replyChannel(access)}:${chat}`;
      if (synchronize && displayed[key] === value.index) return false;
      // 与后台逐题同步共用发送登记；未知投递不自动重发。
      displayed[key] = value.index; return true;
    });
    if (!claimed) return;
  }
  if (replyChannel(access) === 'feishu') {
    const sent = await replyHint(api, chat, t('hook.notificationTitle'), interactionContent(value, true));
    const ids = sent?.message_ids ?? [sent?.message_id];
    if (!Array.isArray(ids) || !ids.length || !ids.every(validMessageId)) throw new ConfigError(t('reply.noInteractionMessageId'));
    await stateTransaction(access, state => {
      const current = state.requests[id];
      if (!current) return;
      for (const message of ids) {
        state.entries[messageKey(access, chat, message)] = { session: value.session, epoch: value.epoch, request: id, question: value.index, updated: Date.now() };
        (current.messages ??= []).push({ chat, message });
      }
      (current.displayed ??= {})[`${replyChannel(access)}:${chat}`] = value.index;
    });
    return;
  }
  // 使用通知分段器发送较长选项，所有选项正文保留，只有最后一段附选择按钮。
  const { makePlan, deliver } = await import('./channels.js');
  const { config } = access;
  const plan = makePlan('telegram', { title: t('hook.notificationTitle'), content: interactionContent(value), footer: '', level: 'warn' },
    { ...config, telegram: { ...config.telegram, chatIds: [chat] } });
  plan.items[plan.items.length - 1].payload.reply_markup = interactionMarkup(value);
  plan.onSent = async (item, response) => {
    const message = response.result?.message_id;
    if (!Number.isSafeInteger(message)) throw new ConfigError(t('reply.noInteractionMessageId'));
    await stateTransaction(access, state => {
      const current = state.requests[id];
      if (current) {
        state.entries[`tg:${chat}:${message}`] = { session: value.session, epoch: value.epoch, request: id, question: value.index, updated: Date.now() } as Entry;
        // 发送期间可能由本机先答；仍登记消息，随后移除过期按钮。
        (current.messages ??= []).push({ chat, message });
      }
    });
  };
  // 完整分段及按钮投递成功后才覆盖通用提醒；重发失败时恢复该接收人的兜底提醒。
  await stateTransaction(access, state => {
    const current = state.requests[id];
    if (current?.notified?.telegram) current.notified.telegram = current.notified.telegram.filter(user => user !== chat);
  });
  // API 封装由测试或真实桥接注入，不另建网络连接。
  const result = await deliver(plan, config, async (_url, payload) => ({ ok: true, result: await api('sendMessage', payload) }));
  if (!result.ok) throw new ConfigError(t('reply.interactionNotSent'));
  await stateTransaction(access, state => {
    const current = state.requests[id];
    if (!current) return;
    current.notified ??= {};
    (current.displayed ??= {})[`${replyChannel(access)}:${chat}`] = value.index;
    const users = current.notified.telegram ??= [];
    if (!users.includes(chat)) users.push(chat);
  });
}
function answer(value: Interaction, text: string): void {
  const q = value.questions[value.index];
  Object.defineProperty(value.answers, q.question, { value: text, enumerable: true, writable: true, configurable: true });
  value.selected = []; value.index++;
  if (value.index === value.questions.length) value.response = {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...value.input, questions: value.input.questions, answers: { ...value.answers } } } },
  };
}
export async function handleInteractionCallback(access: ReplyAccess, callback: any, chat: string, api: TelegramApi): Promise<boolean> {
  if (typeof callback.data !== 'string' || !callback.data.startsWith('dn:q:')) return false;
  const match = callback.data.match(/^dn:q:([a-f0-9]{32}):(\d):([adcls]|o[0-3])$/);
  if (!match || typeof callback.id !== 'string') return true;
  const [, id, index, operation] = match;
  const outcome = await stateTransaction(access, state => {
    const value = state.requests[id], target = value && state.sessions[value.session];
    if (!active(value) || value.index !== Number(index) || !target || target.unverified === true || targetEpoch(target) !== value.epoch) return 'expired';
    if (value.kind === 'permission' && access.policy.permissions !== true) return 'expired';
    if (operation === 'l') { finishInteraction(value, { kind: 'not-applied', reason: 'closed', text: t('reply.closedLocal') }); return 'local'; }
    const question = value.questions[value.index]?.question;
    const previousIndex = value.index;
    if (value.kind === 'permission') {
      if (access.policy.permissions !== true) return 'expired';
      if (operation === 'a' || operation === 'd') {
        value.response = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: operation === 'a' ? 'allow' : 'deny' } } };
      } else if (operation !== 'c') return 'expired';
    } else {
      const q = value.questions[value.index];
      if (operation.startsWith('o')) {
        const selected = Number(operation.slice(1));
        if (!q.options[selected]) return 'expired';
        if (q.multiSelect) value.selected = value.selected.includes(selected) ? value.selected.filter(i => i !== selected) : [...value.selected, selected].sort();
        else answer(value, q.options[selected].label);
      } else if (operation === 's' && q.multiSelect && value.selected.length) answer(value, value.selected.map(i => q.options[i].label).join(','));
      else if (operation !== 'c') return 'expired';
    }
    if (value.index !== previousIndex || value.response) (value.receipts ??= []).push({ id: callback.id, chat,
      message: callback.message.message_id, question, answer: value.kind === 'question' ? value.answers[question!] : operation === 'a' ? 'allow' : 'deny' });
    return operation === 'c' ? 'custom' : value.response ? 'done' : value.index !== previousIndex ? 'answered' : 'next';
  });
  await api('answerCallbackQuery', { callback_query_id: callback.id,
    text: outcome === 'expired' ? t('reply.callbackExpired') : outcome === 'local' ? t('reply.callbackClosed') : outcome === 'done' || outcome === 'answered' ? t('reply.callbackRegistered') : t('reply.callbackUpdated') }).catch(() => {});
  if (outcome === 'done' || outcome === 'answered') await replyHint(api, chat, t('reply.pendingConfirmationTitle'),
    (outcome === 'answered' ? t('reply.pendingRemaining') : t('reply.pendingSubmitted'))
    + t('reply.pendingFooter', { id: id.slice(0, 8) })).catch(() => {});
  if (outcome === 'expired') await replyHint(api, chat, t('reply.notAppliedTitle'), t('reply.notAppliedBody', { id: id.slice(0, 8) })).catch(() => {});
  if (outcome === 'custom') {
    const value = await stateTransaction(access, state => state.requests[id]);
    if (!active(value)) return true;
    const sent = await replyHint(api, chat, t('reply.customInput'), value.kind === 'permission' ? t('reply.denyInstruction') : t('reply.answerInstruction'),
      callback.message.message_id, { force_reply: true, selective: true });
    if (Number.isSafeInteger(sent?.message_id)) await stateTransaction(access, state => {
      state.entries[`tg:${chat}:${sent.message_id}`] = { session: value.session, epoch: value.epoch, request: id, question: value.index, updated: Date.now() } as Entry;
    });
  } else if (outcome === 'next' || outcome === 'answered') await showInteraction(access, id, chat, api);
  return true;
}
export async function handleInteractionText(access: ReplyAccess, id: string, chat: string, message: any, api: TelegramApi): Promise<void> {
  const text: string = message.text;
  if (!text.trim() || Array.from(text).length > 4000) { await replyHint(api, chat, t('reply.answerInvalidTitle'), t('reply.answerInvalidBody'), message.message_id); return; }
  const outcome = await stateTransaction(access, state => {
    const value = state.requests[id], target = value && state.sessions[value.session];
    const entry = state.entries[messageKey(access, chat, message.reply_to_message.message_id)];
    if (!active(value) || !target || target.unverified === true || targetEpoch(target) !== value.epoch || entry?.question !== value.index) return 'expired';
    const question = value.questions[value.index]?.question;
    const feishu = replyChannel(access) === 'feishu';
    const command = text.trim();
    if (value.kind === 'permission' && access.policy.permissions !== true) return 'expired';
    if (feishu && command === '/close') {
      finishInteraction(value, { kind: 'not-applied', reason: 'closed', text: t('reply.closedLocal') });
      return 'closed';
    }
    let submitted = text;
    if (value.kind === 'permission') {
      if (access.policy.permissions !== true) return 'expired';
      submitted = feishu && command === '/allow' ? 'allow' : 'deny';
      value.response = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: {
        behavior: submitted, ...(submitted === 'deny' && !(feishu && command === '/deny') ? { message: text } : {}) } } };
    } else {
      const q = value.questions[value.index];
      if (feishu && /^\d+(?:\s*,\s*\d+)*$/.test(command)) {
        const indexes = [...new Set(command.split(',').map(v => Number(v.trim()) - 1))];
        if ((!q.multiSelect && indexes.length !== 1) || indexes.some(i => !q.options[i])) return 'invalid';
        submitted = indexes.map(i => q.options[i].label).join(',');
      }
      answer(value, submitted);
    }
    (value.receipts ??= []).push({ id: `text:${chat}:${message.message_id}`, chat, message: message.message_id,
      question, answer: submitted, custom: true });
    return value.response ? 'done' : 'next';
  });
  if (outcome === 'invalid' || outcome === 'closed') {
    await replyHint(api, chat, t(outcome === 'closed' ? 'reply.callbackClosed' : 'reply.answerInvalidTitle'),
      t(outcome === 'closed' ? 'reply.closedLocal' : 'reply.answerInvalidBody')); return;
  }
  await replyHint(api, chat, outcome === 'expired' ? t('reply.notAppliedTitle') : t('reply.pendingConfirmationTitle'),
    (outcome === 'done' ? t('reply.finalWaiting')
      : outcome === 'next' ? t('reply.nextWaiting')
      : t('reply.notSubmitted')) + t('reply.requestLine', { id: id.slice(0, 8) }));
  if (outcome === 'next') await showInteraction(access, id, chat, api);
}
export async function waitInteraction(access: ReplyAccess, value: Interaction, fresh: () => Promise<ReplyAccess | null>,
  options: { sleep?: (ms: number) => Promise<unknown>; timeout?: number; signal?: AbortSignal } = {}): Promise<Record<string, any> | null> {
  const end = Math.min(value.expires, Date.now() + (options.timeout ?? INTERACTION_MS));
  while (Date.now() < end && !options.signal?.aborted) {
    const current = await fresh();
    if (!current || current.identity !== access.identity || (value.kind === 'permission' && current.policy.permissions !== true)) return null;
    const response = await stateTransaction(access, state => {
      const request = state.requests[value.id], target = state.sessions[value.session];
      if (!request || request.result || !target || targetEpoch(target) !== value.epoch || (request.call && (!state.calls[request.call] || state.calls[request.call].ended))) return { ended: true };
      if (target.unverified === true || !request.response || request.claimed || options.signal?.aborted) return null;
      request.claimed = true;
      // 回传后等待独立的完成事件确认；不能在这里删除请求或报告成功。
      request.expires = Date.now() + INTERACTION_MS;
      return { response: request.response };
    });
    if (response?.ended) return null;
    if (response?.response) return response.response;
    await (options.sleep ?? delay)(200);
  }
  await stateTransaction(access, state => {
    const request = state.requests[value.id];
    if (request && !request.result) finishInteraction(request, { kind: request.claimed ? 'unknown' : 'not-applied', reason: options.signal?.aborted ? 'failed' : 'expired', text: options.signal?.aborted ? t('reply.interactionCancelled') : t('reply.expiredUnsentAnswer') });
  });
  return null;
}
