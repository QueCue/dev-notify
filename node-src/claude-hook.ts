import type { Readable } from 'node:stream';
import { ConfigError, decodeUtf8, loadConfig, ready, type Env } from './config.js';
import { deliver, makePlan, type Channel, type Message } from './channels.js';
import { NOTIFICATION_MATCHER } from './claude-code.js';
import { t } from './i18n.js';
import { findSessionName } from './reply-platform.js';
import { lifecycleHook, interactionHook, attachReply, mapReplies, notificationCoverage, type ReplyHookOptions } from './reply-hooks.js';

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
function footer(data: any, sessionName: string): string {
  const project = typeof data.cwd === 'string' && data.cwd.trim() ? t('hook.footerProject', { value: metadata(data.cwd, 300) }) : '';
  const topic = typeof sessionName === 'string' && sessionName.trim() ? t('hook.footerTopic', { value: metadata(sessionName.trim(), 120) }) : '';
  const session = typeof data.session_id === 'string' && data.session_id.trim() ? t('hook.footerSession', { value: metadata(data.session_id, 120) }) : '';
  return [project, topic, session].filter(Boolean).join('\n');
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
}
export async function dispatchClaudeHook(bytes: Uint8Array, configFile: string, context: HookContext): Promise<void> {
  const message = claudeHookMessage(bytes);
  const data = JSON.parse(decodeUtf8(bytes));
  const options = { send: context.send, ...context.reply, env: context.env, err: context.err, response: context.response };
  try {
    await lifecycleHook(data, configFile, options);
    await interactionHook(data, configFile, options);
  } catch { context.err(t('hook.interactionFailed')); }
  if (!message) return;
  let sessionName = '';
  try { sessionName = await findSessionName(data.session_id, { env: context.env }); }
  catch { context.err(t('hook.sessionNameFailed')); }
  const notification = sessionName ? claudeHookMessage(bytes, sessionName) ?? message : message;
  let binding = null;
  try { binding = await attachReply(notification, data, configFile, options); }
  catch { context.err(t('hook.replyNotReady')); }
  const config = await loadConfig(configFile, true, context.env);
  let covered = { telegram: [] as string[], feishu: false };
  try { covered = await notificationCoverage(data, configFile, config, options); }
  catch { context.err(t('hook.coverageFailed')); }
  let channels = 0;
  for (const channel of ['telegram', 'feishu'] as Channel[]) {
    if (!ready(config, channel)) continue;
    channels++;
    try {
      if (channel === 'feishu' && covered.feishu) continue;
      const plan = makePlan(channel, notification, config);
      if (channel === 'telegram' && covered.telegram.length) {
        plan.items = plan.items.filter(item => !covered.telegram.includes(item.recipient));
        plan.recipients = new Set(plan.items.map(item => item.recipient)).size;
        if (!plan.items.length) continue;
      }
      if (binding) mapReplies(plan, binding);
      const result = await context.send(plan, config);
      if (!result.ok) context.err(t('hook.sendIncomplete', { channel }));
    } catch { context.err(t('hook.sendFailed', { channel })); }
  }
  if (!channels) throw new ConfigError(t('hook.noChannels'));
}
