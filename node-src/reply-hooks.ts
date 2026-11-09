import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigError, type Config, type Env } from './config.js';
import { t, getLocale } from './i18n.js';
import { MAX_REPLY_CARDS } from './feishu-card-status.js';
import { accessReplies, botKey, digest, stateTransaction, targetEpoch, replyChannel, messageKey, validMessageId, TTL, type ReplyAccess, type SessionTarget } from './reply-state.js';
import { lookupSession, SessionLookupError, type SessionLookup } from './reply-platform.js';
import { processState } from './reply-lock.js';
import { textHash } from './reply-engine.js';
import { telegramApi, replyHint, type TelegramApi } from './reply-telegram.js';
import { feishuReplyApi } from './reply-feishu.js';
import { bridgeStatus, startBridge, bridgeBotUsername } from './reply-bridge.js';
import { CONNECTION_RESET_RETRY_DELAYS, ReplyPreparationError, TelegramConnectionResetError, type ReplyDiagnosticCode } from './notification-diagnostics.js';
import { createInteraction, questionsContent, showInteraction, waitInteraction } from './reply-interactions.js';
import { makePlan, deliver, type Message, type Plan } from './channels.js';
import { completeToolCall, endSessionInteractions, finishInteraction, matchingCall, registerToolCall } from './reply-outcomes.js';

export interface ReplyHookOptions {
  env?: Env;
  session?: (id: string) => Promise<SessionTarget | null>;
  sessionLookup?: (id: string) => Promise<SessionLookup>;
  api?: (access: ReplyAccess) => TelegramApi;
  send?: typeof deliver;
  bridge?: (file: string, env: Env) => Promise<boolean>;
  err?: (text: string) => void;
  replyDiagnostic?: (code: ReplyDiagnosticCode) => void;
  response?: (value: Record<string, any>) => void;
  wait?: typeof waitInteraction;
  sleep?: (ms: number) => Promise<unknown>;
}
const apiFor = (access: ReplyAccess, options: ReplyHookOptions) => (options.api ?? (value => replyChannel(value) === 'feishu'
  ? feishuReplyApi(value.config) : telegramApi(value.config.telegram.token)))(access);
async function inspectTarget(data: any, options: ReplyHookOptions): Promise<SessionLookup> {
  try {
    if (options.sessionLookup) return await options.sessionLookup(data.session_id);
    if (options.session) {
      const target = await options.session(data.session_id);
      return target ? { status: 'found', target } : { status: 'missing' };
    }
    return await lookupSession(data.session_id, { env: options.env });
  } catch { return { status: 'unavailable' }; }
}
async function getTarget(data: any, options: ReplyHookOptions): Promise<SessionTarget | null> {
  const result = await inspectTarget(data, options);
  if (result.status === 'unavailable') throw new SessionLookupError();
  return result.status === 'found' ? result.target : null;
}
export async function lifecycleHook(data: any, file: string, options: ReplyHookOptions = {}): Promise<void> {
  const event = data.hook_event_name;
  if (!['SessionStart', 'UserPromptSubmit', 'SessionEnd', 'Stop', 'Notification'].includes(event) || typeof data.session_id !== 'string') return;
  const access = await accessReplies(file, options.env);
  if (!access) return;
  if (event === 'Stop' && data.stop_hook_active === true) return;
  const before = event === 'SessionEnd' ? null : await stateTransaction(access, state => state.sessions[data.session_id]);
  const inspection = event === 'SessionEnd' ? null : await inspectTarget(data, options);
  const target = inspection?.status === 'found' ? inspection.target : null;
  const confirmedGone = inspection?.status === 'missing' && !!before && processState(before.pid) === 'dead';
  if (!target && event !== 'SessionEnd') options.err?.(t('reply.sessionUnavailable'));
  const receipt = await stateTransaction(access, state => {
    const previous = state.sessions[data.session_id];
    if (event === 'SessionEnd' || (confirmedGone && previous && before && targetEpoch(previous) === targetEpoch(before))) {
      for (const card of Object.values(state.feishuCards ?? {})) if (card.session === data.session_id) card.invalidated = 'closed';
      delete state.sessions[data.session_id]; delete state.pending[data.session_id];
      endSessionInteractions(state, data.session_id, t('reply.endSessionReason'));
      return null;
    }
    if (!target) {
      if (previous) { previous.unverified = true; previous.updated = Date.now(); }
      // 观察到新的本地输入时仍取消旧排队任务，不能在恢复核验后抢先注入。
      if (event === 'UserPromptSubmit' || event === 'SessionStart') {
        if (state.pending[data.session_id]?.phase === 'queued') delete state.pending[data.session_id];
        if (previous) previous.working = true;
      }
      if (event === 'Stop' || event === 'UserPromptSubmit' || event === 'SessionStart')
        endSessionInteractions(state, data.session_id, t('reply.endTurnReason'));
      return null;
    }
    // 同进程 / 同 TTY 已切换会话时，旧映射不再允许输入。
    for (const [id, other] of Object.entries(state.sessions)) {
      if (id !== target.session && (other.pid === target.pid || (target.tty && other.tty === target.tty))) {
        for (const card of Object.values(state.feishuCards ?? {})) if (card.session === id) card.invalidated = 'switched';
        endSessionInteractions(state, id, t('reply.endSwitchedReason'));
        delete state.sessions[id]; delete state.pending[id];
      }
    }
    const pending = state.pending[target.session];
    const match = event === 'UserPromptSubmit' && typeof data.prompt === 'string' && pending?.phase === 'submitted'
      && pending.epoch === targetEpoch(target) && pending.hash === textHash(data.prompt) && Date.now() - pending.updated < 5 * 60 * 1000;
    if (match || (pending && pending.epoch !== targetEpoch(target))) delete state.pending[target.session];
    const working = event !== 'Stop';
    const tracked = event === 'UserPromptSubmit' || (event !== 'SessionStart' && previous?.tracked === true && targetEpoch(previous) === targetEpoch(target));
    const latestCall = event !== 'SessionStart' && event !== 'UserPromptSubmit' && previous && targetEpoch(previous) === targetEpoch(target)
      ? previous.latestCall : undefined;
    state.sessions[target.session] = { ...target, working, tracked, latestCall, updated: Date.now() };
    // 本地用户提交新任务时，尚未注入的排队回复不能抢在该任务前输入。
    if (event === 'UserPromptSubmit' && !match && pending?.phase === 'queued') delete state.pending[target.session];
    if (event === 'UserPromptSubmit' || event === 'SessionStart' || event === 'Stop') {
      endSessionInteractions(state, target.session, event === 'Stop' ? t('reply.endTurnReason') : t('reply.endLocalReason'));
    }
    return match ? pending : null;
  });
  if (receipt) {
    await replyHint(apiFor(access, options), receipt.chat, t('reply.receivedTitle'),
      t('reply.receivedBody'), receipt.message).catch(() => options.err?.(t('feishu.receiptFailed')));
    if (replyChannel(access) === 'telegram' && access.config.feishu.enabled && access.config.feishu.mode !== 'app' && access.config.feishu.webhook) {
      try {
        const result = await (options.send ?? deliver)(makePlan('feishu', { title: t('reply.receivedTitle'), level: 'info',
          content: t('reply.receivedFeishuBody'),
          footer: t('reply.receivedFeishuFooter', { session: data.session_id }) }, access.config), access.config);
        if (!result.ok) options.err?.(t('reply.receivedFeishuIncomplete'));
      } catch { options.err?.(t('reply.receivedFeishuFailed')); }
    }
  }
}
const feishuTarget = (config: Config) => digest(JSON.stringify([config.feishu.webhook, config.feishu.secret]));
export async function notificationCoverage(data: any, file: string, config: Config, options: ReplyHookOptions = {}): Promise<{ telegram: string[]; feishu: boolean }> {
  const none = { telegram: [] as string[], feishu: false };
  if (data.hook_event_name !== 'Notification' || data.notification_type !== 'permission_prompt' || typeof data.session_id !== 'string') return none;
  const access = await accessReplies(file, options.env);
  if (!access || replyChannel(access) === 'feishu' || botKey(config) !== access.policy.bot) return none;
  return stateTransaction(access, state => {
    const target = state.sessions[data.session_id];
    const call = target?.latestCall && state.calls[target.latestCall];
    if (!target || target.unverified === true || !call || call.session !== target.session || call.epoch !== targetEpoch(target) || call.tool !== 'AskUserQuestion'
      || typeof data.tool_use_id === 'string' && data.tool_use_id !== call.id
      || typeof data.tool_name === 'string' && data.tool_name !== call.tool
      || typeof data.prompt_id === 'string' && data.prompt_id !== call.prompt) return none;
    const request = call.request && state.requests[call.request];
    if (!request || request.kind !== 'question' || request.session !== target.session || request.epoch !== call.epoch || request.expires <= Date.now()) return none;
    // Notification 通常没有调用 ID；仅覆盖当前最后一项调用，存在其他并行调用时保守保留提醒。
    if (Object.entries(state.calls).some(([key, other]) => key !== target.latestCall && other.session === target.session && other.epoch === call.epoch && !other.ended)) return none;
    return { telegram: (request.notified?.telegram ?? []).filter(user => access.policy.users.includes(user)),
      feishu: request.notified?.feishu === feishuTarget(config) };
  });
}
export async function attachReply(message: Message, data: any, file: string, options: ReplyHookOptions = {}): Promise<{ access: ReplyAccess; token: string } | null> {
  if (data.hook_event_name !== 'Stop') return null;
  const access = await accessReplies(file, options.env);
  if (!access) { options.replyDiagnostic?.('disabled'); return null; }
  const skip = (reason: ReplyDiagnosticCode) => {
    options.replyDiagnostic?.(reason);
    const detail = t(reason === 'disabled' ? 'reply.skipDisabled'
      : reason === 'session-working' ? 'reply.skipWorking'
      : reason === 'input-unobserved' ? 'reply.skipInput'
      : reason === 'identity-changed' ? 'reply.skipChanged'
      : reason === 'bridge-unready' ? 'reply.skipBridge' : 'reply.skipSession');
    options.err?.(t('reply.buttonSkipped', { reason, detail }));
    return null;
  };
  const target = await getTarget(data, options);
  if (!target) return skip('session-unverified');
  const saved = await stateTransaction(access, state => state.sessions[target.session]);
  if (!saved) return skip('state-missing');
  if (saved.unverified === true) return skip('session-unverified');
  if (saved.working) return skip('session-working');
  if (!saved.tracked) return skip('input-unobserved');
  if (targetEpoch(saved) !== targetEpoch(target)) return skip('identity-changed');
  const ready = options.bridge ? await options.bridge(file, options.env ?? process.env)
    : (await bridgeStatus(file, access)).ready || await startBridge(file, options.env);
  if (!ready) { options.replyDiagnostic?.('bridge-unready'); options.err?.(t('reply.bridgeNotReadyButton')); return null; }
  const revalidate = async (): Promise<ReplyDiagnosticCode | null> => {
    const current = await accessReplies(file, options.env);
    if (!current) return 'disabled';
    if (current.identity !== access.identity) return 'identity-changed';
    const active = await getTarget(data, options);
    if (!active || targetEpoch(active) !== targetEpoch(target)) return 'identity-changed';
    const latest = await stateTransaction(current, state => state.sessions[target.session]);
    if (!latest || latest.unverified === true) return 'session-unverified';
    if (latest.working) return 'session-working';
    if (!latest.tracked) return 'input-unobserved';
    if (targetEpoch(latest) !== targetEpoch(target)) return 'identity-changed';
    const stillReady = options.bridge ? await options.bridge(file, options.env ?? process.env) : (await bridgeStatus(file, access)).ready;
    return stillReady ? null : 'bridge-unready';
  };
  if (replyChannel(access) === 'feishu') {
    const reason = await revalidate();
    if (reason) return skip(reason);
    const full = await stateTransaction(access, state => Object.values(state.feishuCards ?? {})
      .filter(card => !['expired', 'closed', 'switched'].includes(card.status)).length >= MAX_REPLY_CARDS);
    if (full) return skip('check-failed');
    const token = randomBytes(16).toString('hex');
    const committed = await stateTransaction(access, state => {
      const latest = state.sessions[target.session];
      if (!latest || latest.unverified || latest.working || !latest.tracked || targetEpoch(latest) !== targetEpoch(target)) return false;
      state.entries['token:' + token] = { session: target.session, epoch: targetEpoch(target), updated: Date.now() };
      return true;
    });
    if (!committed) return skip('identity-changed');
    options.replyDiagnostic?.('attached');
    return { access, token };
  }
  const api = apiFor(access, options);
  let bot, fromBridge = false;
  // 只读查询：明确 reset 时最多重试 2 次（约 1s、3s），每次等待后重新核验授权与会话；全部 reset 才用桥接已核验身份。
  for (let retry = 0; ; retry++) {
    try { bot = await api('getMe', {}); break; }
    catch (error) {
      if (!(error instanceof TelegramConnectionResetError)) throw new ReplyPreparationError(error);
      if (retry >= CONNECTION_RESET_RETRY_DELAYS.length) {
        const reason = await revalidate();
        if (reason) return skip(reason);
        const username = await bridgeBotUsername(file, access.identity);
        if (!username) throw new ReplyPreparationError(error);
        bot = { username }; fromBridge = true; break;
      }
      options.replyDiagnostic?.('getme-reset-retry');
      await (options.sleep ?? delay)(CONNECTION_RESET_RETRY_DELAYS[retry]);
      const reason = await revalidate();
      if (reason) return skip(reason);
    }
  }
  if (typeof bot?.username !== 'string' || !/^[A-Za-z0-9_]{5,64}$/.test(bot.username)) throw new ConfigError(t('reply.botUsernameInvalid'));
  const reason = await revalidate();
  if (reason) return skip(reason);
  const token = randomBytes(16).toString('hex');
  const commitReason = await stateTransaction(access, (state): ReplyDiagnosticCode | null => {
    const latest = state.sessions[target.session];
    if (!latest || latest.unverified === true) return 'session-unverified';
    if (latest.working) return 'session-working';
    if (!latest.tracked) return 'input-unobserved';
    if (targetEpoch(latest) !== targetEpoch(target)) return 'identity-changed';
    state.entries['token:' + token] = { session: target.session, epoch: targetEpoch(target), updated: Date.now() };
    return null;
  });
  if (commitReason) return skip(commitReason);
  message.reply = { token, url: `https://t.me/${bot.username}?start=${token}`, users: access.policy.users };
  if (fromBridge) options.replyDiagnostic?.('getme-bridge-fallback');
  options.replyDiagnostic?.('attached');
  return { access, token };
}
export function mapReplies(plan: Plan, binding: { access: ReplyAccess; token: string }, feishuStatus?: { footer: string }): void {
  if (plan.channel !== replyChannel(binding.access)) return;
  plan.onSent = async (item, response) => {
    if (!binding.access.policy.users.includes(item.recipient)) return;
    if (!validMessageId(response.result?.message_id)) throw new ConfigError(t('reply.noMessageId'));
    await stateTransaction(binding.access, state => {
      const entry = state.entries['token:' + binding.token];
      if (!entry) throw new ConfigError(t('reply.noMessageId'));
      state.entries[messageKey(binding.access, item.recipient, response.result.message_id)] = entry;
      if (feishuStatus && replyChannel(binding.access) === 'feishu' && typeof response.result.message_id === 'string') {
        const cards = state.feishuCards ??= {};
        for (const [id, old] of Object.entries(cards)) if (['expired', 'closed', 'switched'].includes(old.status)) delete cards[id];
        if (Object.keys(cards).length >= MAX_REPLY_CARDS) throw new ConfigError(t('feishu.replyCheckFailed'));
        const title = String(item.payload.card.header.title.content);
        cards[response.result.message_id] = { message: response.result.message_id, user: item.recipient,
          session: entry.session, epoch: entry.epoch, expires: entry.updated + TTL,
          title: title.slice(title.indexOf('｜') + 1), footer: feishuStatus.footer,
          card: structuredClone(item.payload.card), language: getLocale(), status: 'preparing' };
      }
    });
  };
}
export async function interactionHook(data: any, file: string, options: ReplyHookOptions = {}): Promise<void> {
  if (!['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(data.hook_event_name)) return;
  const access = await accessReplies(file, options.env);
  if (!access) return;
  if (['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(data.hook_event_name)) {
    await completeToolCall(access, data); return;
  }
  if (!['PreToolUse', 'PermissionRequest'].includes(data.hook_event_name)) return;
  const kind = data.tool_name === 'AskUserQuestion' ? 'question' : access.policy.permissions === true ? 'permission' : null;
  if (typeof data.session_id !== 'string' || data.hook_event_name === 'PermissionRequest' && !kind) return;
  const cached = data.hook_event_name === 'PreToolUse'
    ? await stateTransaction(access, state => state.sessions[data.session_id]) : null;
  // 登记阶段复用生命周期元数据；真正开启远程交互时仍重新核验进程身份。
  const target = cached ?? await getTarget(data, options);
  if (!target || target.unverified === true) { options.err?.(t('reply.noSession')); return; }
  if (data.hook_event_name === 'PreToolUse') {
    // 只登记调用身份，不发网络请求、不等待远端，原生窗口可以正常出现。
    await registerToolCall(access, target, data); return;
  }
  if (!kind) return;
  const call = await stateTransaction(access, state => matchingCall(state, target, data));
  if (!call) { options.err?.(t('reply.noMatchingCall')); return; }
  const ready = options.bridge ? await options.bridge(file, options.env ?? process.env)
    : (await bridgeStatus(file, access)).ready || await startBridge(file, options.env);
  if (!ready) { options.err?.(t('reply.bridgeNotReadyQuestion')); return; }
  const api = apiFor(access, options);
  const request = await createInteraction(access, target, kind, kind === 'question' ? data.tool_input : { tool_name: data.tool_name, tool_input: data.tool_input }, call);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
  try {
    for (const chat of access.policy.users) await showInteraction(access, request.id, chat, api);
    if (replyChannel(access) === 'telegram' && access.config.feishu.enabled && access.config.feishu.mode !== 'app' && access.config.feishu.webhook) {
      const bot = await api('getMe', {});
      if (typeof bot?.username === 'string' && /^[A-Za-z0-9_]{5,64}$/.test(bot.username)) {
        const result = await (options.send ?? deliver)(makePlan('feishu', { title: t('hook.notificationTitle'), level: 'warn', footer: '',
          content: kind === 'question' ? questionsContent(request.questions) : t('reply.permissionRequest', { tool: String(data.tool_name) }),
          reply: { token: request.id, url: `https://t.me/${bot.username}?start=${request.id}`, users: access.policy.users } }, access.config), access.config);
        if (result.ok) await stateTransaction(access, state => {
          const current = state.requests[request.id];
          if (current) { current.notified ??= {}; current.notified.feishu = feishuTarget(access.config); }
        });
      }
    }
    const response = await (options.wait ?? waitInteraction)(access, request, () => accessReplies(file, options.env), { signal: controller.signal });
    if (response && !controller.signal.aborted) options.response?.(response);
    else options.err?.(t('reply.interactionEnded'));
  } catch (error) {
    await stateTransaction(access, state => {
      const current = state.requests[request.id];
      if (current) finishInteraction(current, { kind: current.claimed ? 'unknown' : 'not-applied', reason: 'failed', text: t('reply.interactionFailed') });
    }).catch(() => {});
    throw error;
  } finally {
    process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
    if (controller.signal.aborted) await stateTransaction(access, state => {
      const current = state.requests[request.id];
      if (current) finishInteraction(current, { kind: current.claimed ? 'unknown' : 'not-applied', reason: 'failed', text: t('reply.interactionCancelled') });
    }).catch(() => {});
  }
}
