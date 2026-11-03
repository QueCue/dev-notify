import { digest, stateTransaction, targetEpoch, type Interaction, type InteractionResult, type ReplyAccess, type ReplyState, type SessionTarget } from './reply-state.js';
import { replyHint, type TelegramApi } from './reply-telegram.js';

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
  for (const receipt of value.receipts ?? []) receipt.result ??= result;
  // 留下短期结果和消息 ID，用于反馈及旧按钮；不保留已结束的问题、参数和答案正文。
  value.input = {}; value.questions = []; value.answers = {}; value.selected = [];
  delete value.response;
  for (const receipt of value.receipts ?? []) { receipt.answer = ''; delete receipt.question; }
}
export function endSessionInteractions(state: ReplyState, session: string, reason: string): void {
  for (const call of Object.values(state.calls)) if (call.session === session) call.ended = true;
  for (const value of Object.values(state.requests)) if (value.session === session && !value.result) finishInteraction(value, {
    kind: value.claimed ? 'unknown' : 'not-applied',
    text: value.claimed ? reason + '；没有收到本次答案的生效确认，请检查终端。不会重复提交。' : reason + '；本次远程答案未回传。',
  });
}
export async function registerToolCall(access: ReplyAccess, target: SessionTarget, data: any): Promise<void> {
  if (typeof data.tool_use_id !== 'string' || !data.tool_use_id || typeof data.tool_name !== 'string' || !data.tool_input) return;
  const key = callKey(target.session, data.tool_use_id);
  await stateTransaction(access, state => {
    if (state.calls[key]) return;
    const previous = state.sessions[target.session];
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
        receipt.result = !value.claimed ? { kind: 'not-applied', text: '本机或其他应答端已先处理；本次 Telegram 答案未回传。' }
          : !valid ? { kind: 'unknown', text: 'Claude 已结束问题，但未提供可核实的答案结果。请检查终端；不会重复提交。' }
          : exists && sameAnswer(answers[receipt.question!], receipt.answer, q?.multiSelect === true && receipt.custom !== true && q.options.every(o => !o.label.includes(',')))
            ? { kind: 'applied', text: 'Claude 已确认采用与你提交内容一致的答案。若本机同时提交了相同内容，无法仅凭结果区分来源。' }
            : { kind: 'not-applied', text: 'Claude 已结束问题，但没有采用你提交的答案；本机或其他应答端可能已先处理。' };
      }
      finishInteraction(value, { kind: 'not-applied', text: '问题已处理，旧按钮已失效。' });
    } else if (data.hook_event_name === 'PostToolUse' && value.kind === 'permission') {
      const allow = value.claimed && value.receipts?.some(r => r.answer === 'allow');
      finishInteraction(value, allow
        ? { kind: 'applied', text: '已确认该工具获准并执行完成；无法仅凭完成事件区分是否由本机同时批准。' }
        : { kind: 'not-applied', text: '该工具已获准执行；本次远程决定未阻止执行。' });
    } else finishInteraction(value, { kind: value.claimed ? 'unknown' : 'not-applied', text: value.claimed
      ? '工具失败、拒绝或取消；此事件不能确认远程决定是否被采用。请检查终端，不会重复提交。'
      : '请求已失败、拒绝或取消，本次远程决定未回传。' });
  });
}
export async function drainInteractionFeedback(access: ReplyAccess, api: TelegramApi,
  fresh: () => Promise<ReplyAccess | null>, log: (text: string) => void = () => {}): Promise<void> {
  const current = await fresh();
  if (!current || current.identity !== access.identity) return;
  const work = await stateTransaction(access, state => {
    for (const value of Object.values(state.requests)) {
      const target = state.sessions[value.session];
      if (!value.result && (!target || targetEpoch(target) !== value.epoch || value.expires <= Date.now())) finishInteraction(value, {
        kind: value.claimed ? 'unknown' : 'not-applied', text: value.claimed
          ? '等待生效确认超时或会话已切换；结果未知，请检查终端。不会自动重复提交。'
          : '交互已过期或会话已结束；远程答案未回传，本机仍可按实际界面处理。',
      });
    }
    return Object.values(state.requests).filter(value => value.result || value.receipts?.some(r => r.result));
  });
  for (const value of work) {
    for (const receipt of value.receipts ?? []) {
      if (!receipt.result || receipt.delivery) continue;
      const authorized = await fresh();
      if (!authorized || authorized.identity !== access.identity || !authorized.policy.users.includes(receipt.chat)) return;
      const claimed = await stateTransaction(access, state => {
        const actual = state.requests[value.id]?.receipts?.find(r => r.id === receipt.id);
        if (!actual?.result || actual.delivery) return false;
        actual.delivery = 'sending'; return true;
      });
      if (!claimed) continue;
      let delivery: 'sent' | 'unknown' = 'sent';
      try {
        const title = receipt.result.kind === 'applied' ? '✅ 答案内容已生效' : receipt.result.kind === 'not-applied' ? '⚠️ 本次提交未生效' : '⚠️ 提交结果暂时无法确认';
        await replyHint(api, receipt.chat, title, receipt.result.text + '\n请求：' + value.id.slice(0, 8));
      } catch { delivery = 'unknown'; log('Telegram 交互结果反馈发送失败或结果未知；不自动重发，不影响已采用的答案。'); }
      await stateTransaction(access, state => {
        const actual = state.requests[value.id]?.receipts?.find(r => r.id === receipt.id);
        if (actual) actual.delivery = delivery;
      });
    }
    if (!value.result) continue;
    for (const message of value.messages ?? []) {
      if (message.cleared) continue;
      const authorized = await fresh();
      if (!authorized || authorized.identity !== access.identity || !authorized.policy.users.includes(message.chat)) return;
      // 最多尝试一次移除按钮；编辑失败时旧回调仍由服务端状态拒绝。
      await stateTransaction(access, state => {
        const actual = state.requests[value.id]?.messages?.find(m => m.chat === message.chat && m.message === message.message);
        if (actual) actual.cleared = true;
      });
      const label = value.result.kind === 'unknown' ? '已关闭 · 结果待核实' : value.result.text.includes('过期') ? '已过期 · 不再接受答案' : '已处理 · 不再接受答案';
      await api('editMessageReplyMarkup', { chat_id: message.chat, message_id: message.message,
        reply_markup: { inline_keyboard: [[{ text: label, callback_data: `dn:q:${value.id}:0:l` }]] } })
        .catch(() => log('Telegram 旧按钮移除失败；服务端状态仍拒绝该请求。'));
    }
  }
}
