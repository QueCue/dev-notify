import { randomBytes } from 'node:crypto';
import { ConfigError, type Config, type Env } from './config.js';
import { accessReplies, botKey, digest, stateTransaction, targetEpoch, type ReplyAccess, type SessionTarget } from './reply-state.js';
import { findSession } from './reply-platform.js';
import { textHash } from './reply-engine.js';
import { telegramApi, replyHint, type TelegramApi } from './reply-telegram.js';
import { bridgeStatus, startBridge } from './reply-bridge.js';
import { createInteraction, questionsContent, showInteraction, waitInteraction } from './reply-interactions.js';
import { makePlan, deliver, type Message, type Plan } from './channels.js';
import { completeToolCall, endSessionInteractions, finishInteraction, matchingCall, registerToolCall } from './reply-outcomes.js';

export interface ReplyHookOptions {
  env?: Env;
  session?: (id: string) => Promise<SessionTarget | null>;
  api?: (access: ReplyAccess) => TelegramApi;
  send?: typeof deliver;
  bridge?: (file: string, env: Env) => Promise<boolean>;
  err?: (text: string) => void;
  response?: (value: Record<string, any>) => void;
  wait?: typeof waitInteraction;
}
const apiFor = (access: ReplyAccess, options: ReplyHookOptions) => (options.api ?? (value => telegramApi(value.config.telegram.token)))(access);
async function getTarget(data: any, options: ReplyHookOptions): Promise<SessionTarget | null> {
  return (options.session ?? (id => findSession(id, { env: options.env })))(data.session_id);
}
export async function lifecycleHook(data: any, file: string, options: ReplyHookOptions = {}): Promise<void> {
  const event = data.hook_event_name;
  if (!['SessionStart', 'UserPromptSubmit', 'SessionEnd', 'Stop', 'Notification'].includes(event) || typeof data.session_id !== 'string') return;
  const access = await accessReplies(file, options.env);
  if (!access) return;
  if (event === 'Stop' && data.stop_hook_active === true) return;
  const target = event === 'SessionEnd' ? null : await getTarget(data, options);
  const receipt = await stateTransaction(access, state => {
    const previous = state.sessions[data.session_id];
    if (event === 'SessionEnd' || !target) {
      delete state.sessions[data.session_id]; delete state.pending[data.session_id];
      endSessionInteractions(state, data.session_id, '会话已结束或无法核验');
      return null;
    }
    // 同进程 / 同 TTY 已切换会话时，旧映射不再允许输入。
    for (const [id, other] of Object.entries(state.sessions)) {
      if (id !== target.session && (other.pid === target.pid || (target.tty && other.tty === target.tty))) {
        endSessionInteractions(state, id, '会话已切换');
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
      endSessionInteractions(state, target.session, event === 'Stop' ? '本轮已结束' : '本机已开始新任务或新会话');
    }
    return match ? pending : null;
  });
  if (receipt) {
    await replyHint(apiFor(access, options), receipt.chat, '✅ Claude 已收到回复',
      'UserPromptSubmit 已匹配本次远程输入；这仅确认收到，不代表任务已经完成。', receipt.message).catch(() => options.err?.('Telegram: 收到确认发送失败；不会重放输入。'));
    if (access.config.feishu.enabled && access.config.feishu.webhook) {
      try {
        const result = await (options.send ?? deliver)(makePlan('feishu', { title: 'Claude 已收到回复', level: 'info',
          content: 'UserPromptSubmit 已匹配远程输入；仅确认收到，不代表任务完成。为减少扩散，不转发回复原文。',
          footer: '会话：' + data.session_id }, access.config), access.config);
        if (!result.ok) options.err?.('feishu: 收到确认未完整发送；不会重放输入。');
      } catch { options.err?.('feishu: 收到确认发送失败；不会重放输入。'); }
    }
  }
}
const feishuTarget = (config: Config) => digest(JSON.stringify([config.feishu.webhook, config.feishu.secret]));
export async function notificationCoverage(data: any, file: string, config: Config, options: ReplyHookOptions = {}): Promise<{ telegram: string[]; feishu: boolean }> {
  const none = { telegram: [] as string[], feishu: false };
  if (data.hook_event_name !== 'Notification' || data.notification_type !== 'permission_prompt' || typeof data.session_id !== 'string') return none;
  const access = await accessReplies(file, options.env);
  if (!access || botKey(config) !== access.policy.bot) return none;
  return stateTransaction(access, state => {
    const target = state.sessions[data.session_id];
    const call = target?.latestCall && state.calls[target.latestCall];
    if (!target || !call || call.session !== target.session || call.epoch !== targetEpoch(target) || call.tool !== 'AskUserQuestion'
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
  const access = await accessReplies(file, options.env);
  if (!access || data.hook_event_name !== 'Stop') return null;
  const target = await getTarget(data, options);
  if (!target) return null;
  const saved = await stateTransaction(access, state => state.sessions[target.session]);
  if (!saved || saved.working || !saved.tracked || targetEpoch(saved) !== targetEpoch(target)) return null;
  const ready = options.bridge ? await options.bridge(file, options.env ?? process.env)
    : (await bridgeStatus(file)).ready || await startBridge(file, options.env);
  if (!ready) { options.err?.('远程回复桥接未就绪，本次通知不展示回复按钮；可运行 reply status 检查。'); return null; }
  const api = apiFor(access, options), bot = await api('getMe', {});
  if (typeof bot?.username !== 'string' || !/^[A-Za-z0-9_]{5,64}$/.test(bot.username)) throw new ConfigError('Telegram Bot 用户名无效，未启用回复按钮');
  const token = randomBytes(16).toString('hex');
  await stateTransaction(access, state => { state.entries['token:' + token] = { session: target.session, epoch: targetEpoch(target), updated: Date.now() }; });
  message.reply = { token, url: `https://t.me/${bot.username}?start=${token}`, users: access.policy.users };
  return { access, token };
}
export function mapReplies(plan: Plan, binding: { access: ReplyAccess; token: string }): void {
  if (plan.channel !== 'telegram') return;
  plan.onSent = async (item, response) => {
    if (!binding.access.policy.users.includes(item.recipient)) return;
    if (!Number.isSafeInteger(response.result?.message_id)) throw new ConfigError('通知未返回可映射的 Telegram 消息 ID');
    await stateTransaction(binding.access, state => {
      const entry = state.entries['token:' + binding.token];
      if (entry) state.entries[`tg:${item.recipient}:${response.result.message_id}`] = entry;
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
  if (!target) { options.err?.('无法核验会话，结构化交互保留本机处理。'); return; }
  if (data.hook_event_name === 'PreToolUse') {
    // 只登记调用身份，不发网络请求、不等待远端，原生窗口可以正常出现。
    await registerToolCall(access, target, data); return;
  }
  if (!kind) return;
  const call = await stateTransaction(access, state => matchingCall(state, target, data));
  if (!call) { options.err?.('无法唯一关联工具调用，远程交互未启用；本机窗口保持正常。'); return; }
  const ready = options.bridge ? await options.bridge(file, options.env ?? process.env)
    : (await bridgeStatus(file)).ready || await startBridge(file, options.env);
  if (!ready) { options.err?.('回复桥接未就绪，问题保留本机处理。'); return; }
  const api = apiFor(access, options);
  const request = await createInteraction(access, target, kind, kind === 'question' ? data.tool_input : { tool_name: data.tool_name, tool_input: data.tool_input }, call);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
  try {
    for (const chat of access.policy.users) await showInteraction(access, request.id, chat, api);
    if (access.config.feishu.enabled && access.config.feishu.webhook) {
      const bot = await api('getMe', {});
      if (typeof bot?.username === 'string' && /^[A-Za-z0-9_]{5,64}$/.test(bot.username)) {
        const result = await (options.send ?? deliver)(makePlan('feishu', { title: 'Claude Code 需要你处理', level: 'warn', footer: '',
          content: kind === 'question' ? questionsContent(request.questions) : '工具权限请求：' + data.tool_name,
          reply: { token: request.id, url: `https://t.me/${bot.username}?start=${request.id}`, users: access.policy.users } }, access.config), access.config);
        if (result.ok) await stateTransaction(access, state => {
          const current = state.requests[request.id];
          if (current) { current.notified ??= {}; current.notified.feishu = feishuTarget(access.config); }
        });
      }
    }
    const response = await (options.wait ?? waitInteraction)(access, request, () => accessReplies(file, options.env), { signal: controller.signal });
    if (response && !controller.signal.aborted) options.response?.(response);
    else options.err?.('远程交互已结束或未提交；不会默认作答，本机操作不受影响。');
  } catch (error) {
    await stateTransaction(access, state => {
      const current = state.requests[request.id];
      if (current) finishInteraction(current, { kind: current.claimed ? 'unknown' : 'not-applied', text: '远程交互处理失败；请检查本机，不会自动重复提交。' });
    }).catch(() => {});
    throw error;
  } finally {
    process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
    if (controller.signal.aborted) await stateTransaction(access, state => {
      const current = state.requests[request.id];
      if (current) finishInteraction(current, { kind: current.claimed ? 'unknown' : 'not-applied', text: '交互等待已取消，远程答案未确认生效。' });
    }).catch(() => {});
  }
}
