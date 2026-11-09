import type { Readable } from 'node:stream';
import path from 'node:path';
import { ConfigError, decodeUtf8, loadConfig, ready, type Config, type Env } from './config.js';
import { deliver, makePlan, type Channel, type Message, type Plan } from './channels.js';
import { claudeSettingsPath, NOTIFICATION_MATCHER } from './claude-code.js';
import { t } from './i18n.js';
import { shouldNotify, type NotifyEvent } from './notifications.js';
import { transcriptEndTime } from './hook-time.js';
import { findSessionName } from './reply-platform.js';
import { ReplyPreparationError, safeDeliveryReason, safeFailureReason, saveNotificationDiagnostic, type NotificationDiagnostic, type ReplyDiagnosticCode } from './notification-diagnostics.js';
import { createDeliveryTracer, type DeliveryTrace, type DeliveryTracerOptions } from './delivery-trace.js';
import { lifecycleHook, interactionHook, attachReply, mapReplies, notificationCoverage, type ReplyHookOptions } from './reply-hooks.js';
import { replyCardFooter } from './feishu-card-status.js';
import { TTL } from './reply-state.js';

export const MAX_HOOK_BYTES = 8 * 1024 * 1024;
export async function readHookInput(input: Readable = process.stdin, limit = MAX_HOOK_BYTES): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => input.destroy(new ConfigError(t('hook.timeout'))), 15000);
  timer.unref();
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw new ConfigError(t('hook.tooLarge'));
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}
function metadata(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\x00-\x1f\x7f]/g, ' ');
  const chars = Array.from(clean);
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : clean;
}
function footerValues(data: any, sessionName: string, time = '') {
  return {
    project: typeof data.cwd === 'string' && data.cwd.trim() ? metadata(data.cwd, 300) : '',
    topic: typeof sessionName === 'string' && sessionName.trim() ? metadata(sessionName.trim(), 120) : '',
    session: typeof data.session_id === 'string' && data.session_id.trim() ? metadata(data.session_id, 120) : '',
    time,
  };
}
function footer(data: any, sessionName: string): string {
  const values = footerValues(data, sessionName);
  const project = values.project ? t('hook.footerProject', { value: values.project }) : '';
  const topic = values.topic ? t('hook.footerTopic', { value: values.topic }) : '';
  const session = values.session ? t('hook.footerSession', { value: values.session }) : '';
  return [project, topic, session].filter(Boolean).join('\n');
}
const pad = (value: number) => String(value).padStart(2, '0');
/** 使用本机本地时间，格式固定为 YYYY-MM-DD HH:mm:ss。 */
export function formatTime(time: Date): string {
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} `
    + `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}
/** 只替换已知变量；未知占位符保持原样，便于发现模板拼写错误。 */
export function renderFooter(template: string, data: any, sessionName: string, time = ''): string {
  const values = footerValues(data, sessionName, time);
  return template.replace(/\{(project|topic|session|time)\}/g, (_, key: string) => values[key as keyof typeof values]);
}
export function claudeHookMessage(bytes: Uint8Array, sessionName = ''): Message | null {
  if (bytes.byteLength > MAX_HOOK_BYTES) throw new ConfigError(t('hook.tooLarge'));
  let data;
  try { data = JSON.parse(decodeUtf8(bytes)); }
  catch { throw new ConfigError(t('hook.invalidJson')); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ConfigError(t('hook.notObject'));
  if (data.hook_event_name !== 'Stop' && data.hook_event_name !== 'Notification') return null;
  const details = footer(data, sessionName);
  if (data.hook_event_name === 'Stop') {
    if (data.stop_hook_active !== undefined && typeof data.stop_hook_active !== 'boolean') throw new ConfigError(t('hook.invalidStopState'));
    if (data.stop_hook_active === true) return null;
    if (data.last_assistant_message !== undefined && typeof data.last_assistant_message !== 'string') throw new ConfigError(t('hook.invalidReply'));
    return { title: t('hook.replyTitle'), level: 'success', footer: details,
      content: data.last_assistant_message?.trim() ? data.last_assistant_message : t('hook.replyFallback') };
  }
  // 空闲提醒在 Stop 之后重复触发；只转发明确需要用户处理的通知。
  if (!NOTIFICATION_MATCHER.split('|').includes(data.notification_type)) return null;
  if (data.message !== undefined && typeof data.message !== 'string') throw new ConfigError(t('hook.invalidNotification'));
  return { title: t('hook.notificationTitle'), level: 'warn', footer: details,
    content: data.message?.trim() ? data.message : t('hook.notificationFallback') };
}
export interface HookContext {
  env: Env;
  send: typeof deliver;
  err: (text: string) => void;
  response?: (value: Record<string, any>) => void;
  reply?: ReplyHookOptions;
  /** 测试注入时钟；默认使用当前本地时间。 */
  now?: () => Date;
  /** 测试注入重连等待；生产使用默认值。 */
  deliveryTrace?: DeliveryTracerOptions;
}
function feishuCompletionPlan(message: Message, config: Config,
  binding: Awaited<ReturnType<typeof attachReply>>, reason: ReplyDiagnosticCode): Plan {
  const users = binding?.access.policy.channel === 'feishu' ? binding.access.policy.users : [];
  const items = (config.feishu.openIds ?? []).flatMap(recipient => {
    const available = users.includes(recipient);
    const detail = available ? t('feishu.replyPreparingDetail')
      : binding ? t(users.length ? 'feishu.replyNotAuthorized' : 'feishu.replyOtherChannel')
      : t(reason === 'disabled' ? 'feishu.replyDisabled'
        : reason === 'bridge-unready' ? 'reply.skipBridge'
        : reason === 'input-unobserved' ? 'reply.skipInput'
        : reason === 'session-working' ? 'reply.skipWorking'
        : reason === 'identity-changed' ? 'reply.skipChanged'
        : reason === 'session-unverified' || reason === 'state-missing' ? 'reply.skipSession' : 'feishu.replyCheckFailed');
    const status = t(available ? 'feishu.replyPreparing' : 'feishu.replyUnavailable');
    // 每个接收人单独规划，让状态参与标题/正文预算；长消息的每段标题都保留状态。
    const recipientConfig: Config = { ...config, feishu: { ...config.feishu, openIds: [recipient] } };
    const plan = makePlan('feishu', { ...message, title: `${status}｜${message.title}`, level: available ? 'warn' : 'info',
      footer: available ? replyCardFooter(detail, Date.now() + TTL, message.footer) : [detail, message.footer].filter(Boolean).join('\n') }, recipientConfig);
    for (const item of plan.items) {
      if (available) item.payload.card.config.update_multi = true; // 飞书 PATCH 只支持显式启用共享更新的卡片。
      else item.payload.card.header.template = 'grey';
    }
    return plan.items;
  });
  return { channel: 'feishu', recipients: config.feishu.openIds?.length ?? 0, items };
}
export async function dispatchClaudeHook(bytes: Uint8Array, configFile: string, context: HookContext): Promise<void> {
  const message = claudeHookMessage(bytes);
  const data = JSON.parse(decodeUtf8(bytes));
  const now = context.now?.() ?? new Date();
  const diagnostic: NotificationDiagnostic = { version: 1, updated: now.getTime(), reply: 'not-attempted', channels: {} };
  const options = { send: context.send, ...context.reply, env: context.env, err: context.err, response: context.response,
    replyDiagnostic: (code: ReplyDiagnosticCode) => {
      if (code === 'getme-reset-retry') diagnostic.identityRetries = (diagnostic.identityRetries ?? 0) + 1;
      else if (code === 'getme-bridge-fallback') diagnostic.identityFallback = 'bridge';
      else diagnostic.reply = code;
      context.reply?.replyDiagnostic?.(code);
    } };
  try {
    await lifecycleHook(data, configFile, options);
    await interactionHook(data, configFile, options);
  } catch { context.err(t('hook.interactionFailed')); }
  if (!message) return;
  const config = await loadConfig(configFile, true, context.env);
  const event: NotifyEvent = data.hook_event_name === 'Stop' ? 'stop' : 'waiting';
  // 静默或项目过滤只影响普通通知；不启动桥接、不生成回复按钮。
  if (!shouldNotify(config, event, data.cwd, now)) return;
  let sessionName = '';
  try { sessionName = await findSessionName(data.session_id, { env: context.env }); }
  catch { context.err(t('hook.sessionNameFailed')); }
  const notification = sessionName ? claudeHookMessage(bytes, sessionName) ?? message : message;
  if (config.templates.footer !== null) {
    let time = '';
    if (config.templates.footer.includes('{time}')) {
      // Stop 优先使用 transcript 最后一条 assistant 记录的时间；读取不到时回退到 hook 触发时间，而不是发送时间。
      let ended: Date | null = null;
      if (data.hook_event_name === 'Stop') {
        try { ended = await transcriptEndTime(data.transcript_path, path.dirname(claudeSettingsPath(context.env)), now); }
        catch { /* 配置目录不可用时使用上面的回退时间。 */ }
      }
      time = formatTime(ended ?? now);
    }
    notification.footer = renderFooter(config.templates.footer, data, sessionName, time);
  }
  // 从身份查询前开始观察，才能判断发送是否复用了此前建立的连接；只在本函数内有效。
  // 仅当观察确认 Telegram 请求建连失败且从未写出时，才允许受限重连（见 delivery-trace.ts）。
  let channels = 0;
  const tracer = createDeliveryTracer(undefined, undefined, context.deliveryTrace);
  try {
    let binding = null;
    try { binding = await attachReply(notification, data, configFile, options); }
    catch (error) {
      diagnostic.reply = error instanceof ReplyPreparationError ? 'getme-failed' : 'check-failed';
      diagnostic.replyReason = error instanceof ReplyPreparationError ? error.message : safeFailureReason(error);
      context.err(error instanceof ReplyPreparationError ? error.message : t('hook.replyNotReady'));
    }
    let covered = { telegram: [] as string[], feishu: false };
    try { covered = await notificationCoverage(data, configFile, config, options); }
    catch { context.err(t('hook.coverageFailed')); }
    for (const channel of ['telegram', 'feishu'] as Channel[]) {
      if (!ready(config, channel)) continue;
      channels++;
      let trace: DeliveryTrace | undefined;
      try {
        if (channel === 'feishu' && covered.feishu) continue;
        const plan = channel === 'feishu' && config.feishu.mode === 'app' && data.hook_event_name === 'Stop'
          ? feishuCompletionPlan(notification, config, binding, diagnostic.reply)
          : makePlan(channel, notification, config);
        if (channel === 'telegram' && covered.telegram.length) {
          plan.items = plan.items.filter(item => !covered.telegram.includes(item.recipient));
          plan.recipients = new Set(plan.items.map(item => item.recipient)).size;
          if (!plan.items.length) continue;
        }
        if (binding) mapReplies(plan, binding, channel === 'feishu' && config.feishu.mode === 'app' ? { footer: notification.footer } : undefined);
        const traced = channel === 'telegram' ? tracer.telegram(plan) : undefined;
        let result;
        try { result = await (traced ? context.send(plan, config, traced.request) : context.send(plan, config)); }
        finally { trace = traced?.finish(); }
        diagnostic.channels[channel] = { status: result.ok ? 'complete' : 'incomplete', sent: result.sent, planned: result.planned,
          ...(!result.ok ? { reason: safeDeliveryReason(result.error) } : {}), ...(trace ? { trace } : {}) };
        if (!result.ok) context.err(t('hook.sendIncompleteDetail', {
          channel, sent: result.sent, planned: result.planned, reason: safeDeliveryReason(result.error),
        }));
      } catch (error) {
        diagnostic.channels[channel] = { status: 'failed', reason: safeFailureReason(error), ...(trace ? { trace } : {}) };
        context.err(t('hook.sendFailedDetail', { channel, reason: safeFailureReason(error) }));
      }
    }
  } finally { tracer.close(); }
  if (data.hook_event_name === 'Stop') {
    diagnostic.updated = Date.now();
    try { await saveNotificationDiagnostic(configFile, data.session_id, diagnostic); }
    catch { context.err(t('hook.diagnosticWriteFailed')); }
  }
  if (!channels) throw new ConfigError(t('hook.noChannels'));
}
