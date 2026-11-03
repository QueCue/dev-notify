import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigError } from './config.js';
import { stateTransaction, targetEpoch, type Entry, type Interaction, type Question, type ReplyAccess, type SessionTarget } from './reply-state.js';
import { replyHint, type TelegramApi } from './reply-telegram.js';
import { finishInteraction } from './reply-outcomes.js';

export const INTERACTION_MS = 5 * 60 * 1000;
export function questionsFrom(input: Record<string, any>): Question[] {
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) throw new ConfigError('问题结构无效，请在本机回答');
  const questions = input.questions as Question[];
  const seen = new Set<string>();
  for (const q of questions) {
    if (!q || typeof q.question !== 'string' || !q.question.trim() || seen.has(q.question)
      || typeof q.header !== 'string' || (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') || !Array.isArray(q.options)
      || q.options.length < 2 || q.options.length > 4 || q.options.some(o => !o || typeof o.label !== 'string' || !o.label.trim()
        || typeof o.description !== 'string') || new Set(q.options.map(o => o.label)).size !== q.options.length) {
      throw new ConfigError('问题结构无效，请在本机回答');
    }
    seen.add(q.question);
  }
  return structuredClone(questions);
}
export async function createInteraction(access: ReplyAccess, target: SessionTarget, kind: Interaction['kind'], input: Record<string, any>, call?: string): Promise<Interaction> {
  if (kind === 'permission' && access.policy.permissions !== true) throw new ConfigError('未授权远程工具权限处理');
  const questions = kind === 'question' ? questionsFrom(input) : [];
  const value: Interaction = { id: randomBytes(16).toString('hex'), session: target.session, epoch: targetEpoch(target),
    updated: Date.now(), expires: Date.now() + INTERACTION_MS, kind, input: structuredClone(input), questions,
    answers: {}, selected: [], index: 0, call, receipts: [], messages: [] };
  await stateTransaction(access, state => {
    const current = state.sessions[target.session];
    if (!current || targetEpoch(current) !== value.epoch) throw new ConfigError('会话目标已变化');
    if (call) {
      const bound = state.calls[call];
      if (!bound || bound.ended || bound.request || bound.epoch !== value.epoch) throw new ConfigError('调用已结束或已绑定；未创建远程问题');
      bound.request = value.id;
    }
    // 不同 tool_use_id 可并行；无绑定的单元级调用仍只保留一个活动交互。
    if (!call) for (const old of Object.values(state.requests)) if (old.session === target.session && !old.result) {
      finishInteraction(old, { kind: old.claimed ? 'unknown' : 'not-applied', text: '问题已切换，旧请求不再接受答案。' });
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
    buttons.push([{ text: '✅ 本次允许', callback_data: prefix + 'a' }, { text: '⛔ 拒绝', callback_data: prefix + 'd' }]);
    buttons.push([{ text: '✍️ 自定义拒绝说明', callback_data: prefix + 'c' }]);
  } else {
    const q = value.questions[value.index];
    q.options.forEach((option, index) => buttons.push([{ text: (value.selected.includes(index) ? '☑ ' : '') + Array.from(option.label).slice(0, 60).join(''), callback_data: prefix + 'o' + index }]));
    if (q.multiSelect) buttons.push([{ text: '提交所选项', callback_data: prefix + 's' }]);
    buttons.push([{ text: '✍️ 自定义输入', callback_data: prefix + 'c' }]);
  }
  buttons.push([{ text: '关闭远程答题（本机仍可操作）', callback_data: prefix + 'l' }]);
  return { inline_keyboard: buttons };
}
export function interactionContent(value: Interaction): string {
  if (value.kind === 'permission') return '工具：' + String(value.input.tool_name || '未知') + '\n\n' + JSON.stringify(value.input.tool_input ?? {}, null, 2)
    + '\n\n仅支持本次允许、拒绝或自定义拒绝说明；官方未提供完整本地按钮列表。不会创建永久权限规则。';
  const q = value.questions[value.index];
  return `问题 ${value.index + 1}/${value.questions.length}：${q.question}\n\n`
    + q.options.map((o, i) => `${i + 1}. ${o.label}\n${o.description}${(o as any).preview ? '\n' + (o as any).preview : ''}`).join('\n\n')
    + (q.multiSelect ? '\n\n可多选，选好后点击「提交所选项」；也可自定义输入。' : '\n\n点击选项直接回答，或选择自定义输入。')
    + '\n本机原生窗口同时可答；Claude 先收到的完整答案生效。远程窗口 5 分钟有效，不会默认选择。';
}
export async function showInteraction(access: ReplyAccess, id: string, chat: string, api: TelegramApi): Promise<void> {
  const value = await stateTransaction(access, state => state.requests[id]);
  if (!active(value)) { await replyHint(api, chat, '⚠️ 交互已失效', '请从最新通知进入，或回到本机处理。'); return; }
  // 使用通知分段器发送较长选项，所有选项正文保留，只有最后一段附选择按钮。
  const { makePlan, deliver } = await import('./channels.js');
  const { config } = access;
  const plan = makePlan('telegram', { title: 'Claude Code 需要你处理', content: interactionContent(value), footer: '', level: 'warn' },
    { ...config, telegram: { ...config.telegram, chatIds: [chat] } });
  plan.items[plan.items.length - 1].payload.reply_markup = interactionMarkup(value);
  plan.onSent = async (item, response) => {
    const message = response.result?.message_id;
    if (!Number.isSafeInteger(message)) throw new ConfigError('交互通知未返回消息 ID');
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
  if (!result.ok) throw new ConfigError('交互通知未完整发送，请回到本机处理');
  await stateTransaction(access, state => {
    const current = state.requests[id];
    if (!current) return;
    current.notified ??= {};
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
    if (!active(value) || value.index !== Number(index) || !target || targetEpoch(target) !== value.epoch) return 'expired';
    if (operation === 'l') { finishInteraction(value, { kind: 'not-applied', text: '已关闭远程答题，本机仍可正常处理。' }); return 'local'; }
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
    text: outcome === 'expired' ? '未提交：按钮已失效或已有答案待确认' : outcome === 'local' ? '已关闭远程答题，本机不受影响' : outcome === 'done' || outcome === 'answered' ? '答案已登记，尚未确认生效' : '已更新' }).catch(() => {});
  if (outcome === 'done' || outcome === 'answered') await replyHint(api, chat, '⏳ 答案已登记，等待确认',
    (outcome === 'answered' ? '仍需完成其余问题，之后才回传整份答案。' : '已进入回传流程，尚不代表 Claude 采用。')
    + '\n稍后反馈生效、未生效或结果未知；若未收到最终反馈，请检查终端。\n请求：' + id.slice(0, 8)).catch(() => {});
  if (outcome === 'expired') await replyHint(api, chat, '⚠️ 本次提交未生效', '此操作未提交：问题已处理、过期、题目已切换或已有答案等待确认。\n请求：' + id.slice(0, 8)).catch(() => {});
  if (outcome === 'custom') {
    const value = await stateTransaction(access, state => state.requests[id]);
    if (!active(value)) return true;
    const sent = await replyHint(api, chat, '✍️ 自定义输入', value.kind === 'permission' ? '请回复此消息填写拒绝说明；此输入不会批准权限。' : '请回复此消息输入这个问题的完整答案。',
      callback.message.message_id, { force_reply: true, selective: true });
    if (Number.isSafeInteger(sent?.message_id)) await stateTransaction(access, state => {
      state.entries[`tg:${chat}:${sent.message_id}`] = { session: value.session, epoch: value.epoch, request: id, question: value.index, updated: Date.now() } as Entry;
    });
  } else if (outcome === 'next' || outcome === 'answered') await showInteraction(access, id, chat, api);
  return true;
}
export async function handleInteractionText(access: ReplyAccess, id: string, chat: string, message: any, api: TelegramApi): Promise<void> {
  const text = message.text;
  if (!text.trim() || Array.from(text).length > 4000) { await replyHint(api, chat, '❌ 未提交答案', '请输入不超过 4000 字符的答案；不会截断。', message.message_id); return; }
  const outcome = await stateTransaction(access, state => {
    const value = state.requests[id], target = value && state.sessions[value.session];
    const entry = state.entries[`tg:${chat}:${message.reply_to_message.message_id}`];
    if (!active(value) || !target || targetEpoch(target) !== value.epoch || entry?.question !== value.index) return 'expired';
    const question = value.questions[value.index]?.question;
    if (value.kind === 'permission') {
      if (access.policy.permissions !== true) return 'expired';
      value.response = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: text } } };
    } else answer(value, text);
    (value.receipts ??= []).push({ id: `text:${chat}:${message.message_id}`, chat, message: message.message_id,
      question, answer: value.kind === 'question' ? text : 'deny', custom: true });
    return value.response ? 'done' : 'next';
  });
  await replyHint(api, chat, outcome === 'expired' ? '⚠️ 本次提交未生效' : '⏳ 答案已登记，等待确认',
    (outcome === 'done' ? '等待 Claude 确认，稍后反馈最终结果；若未收到反馈请检查终端。'
      : outcome === 'next' ? '仍需完成其余问题，之后才回传整份答案；尚未生效。'
      : '此操作未提交：对应问题已结束、过期、已切换或已有答案等待确认。') + '\n请求：' + id.slice(0, 8));
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
      if (!request.response || request.claimed || options.signal?.aborted) return null;
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
    if (request && !request.result) finishInteraction(request, { kind: request.claimed ? 'unknown' : 'not-applied', text: options.signal?.aborted ? '交互等待已取消；远程答案未确认生效。' : '远程交互等待超时；未确认生效，本机仍可继续处理。' });
  });
  return null;
}
