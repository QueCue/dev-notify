import { HttpError, TelegramApiError, TransportError } from '@quecue/notify-core';
import { ConfigError } from './config.js';
import { t } from './i18n.js';
import path from 'node:path';
import { atomicJson, replyDirectory } from './reply-state.js';

export type ReplyDiagnosticCode = 'not-attempted' | 'disabled' | 'session-unverified' | 'state-missing'
  | 'session-working' | 'input-unobserved' | 'identity-changed' | 'bridge-unready' | 'getme-failed'
  | 'check-failed' | 'getme-reset-retry' | 'getme-bridge-fallback' | 'attached';
export interface NotificationDiagnostic {
  version: 1;
  updated: number;
  reply: ReplyDiagnosticCode;
  replyReason?: string;
  identityRetries?: number;
  identityFallback?: 'bridge';
  channels: Partial<Record<'telegram' | 'feishu', { status: 'complete' | 'incomplete' | 'failed'; sent?: number; planned?: number; reason?: string }>>;
}
export async function saveNotificationDiagnostic(file: string, session: unknown, value: NotificationDiagnostic): Promise<void> {
  if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) return;
  // 失败先单独保存，成功只更新最新摘要，不能抹掉自动恢复前的证据。
  const failed = !['attached', 'disabled', 'not-attempted'].includes(value.reply)
    || Object.values(value.channels).some(channel => channel.status !== 'complete');
  if (failed) await atomicJson(path.join(replyDirectory(file), 'notification-failures', session + '.json'), value);
  await atomicJson(path.join(replyDirectory(file), 'notification-diagnostics', session + '.json'), value);
}

export type BridgeDiagnosticStage = 'authorization' | 'lease-read' | 'existing-unready' | 'runtime-paths'
  | 'spawn' | 'wait-ready' | 'spawn-error' | 'child-exit' | 'worker-error' | 'wait-timeout'
  | 'storage' | 'bot-lock' | 'lease-write' | 'getWebhookInfo' | 'getMe' | 'state-read'
  | 'initial-getUpdates' | 'state-write' | 'ready' | 'polling' | 'cleanup';
export const BRIDGE_DIAGNOSTIC_STAGES: readonly BridgeDiagnosticStage[] = ['authorization', 'lease-read', 'existing-unready', 'runtime-paths',
  'spawn', 'wait-ready', 'spawn-error', 'child-exit', 'worker-error', 'wait-timeout', 'storage', 'bot-lock', 'lease-write',
  'getWebhookInfo', 'getMe', 'initial-getUpdates', 'state-read', 'state-write', 'ready', 'polling', 'cleanup'];
export function isBridgeDiagnosticStage(value: unknown): value is BridgeDiagnosticStage {
  return typeof value === 'string' && (BRIDGE_DIAGNOSTIC_STAGES as readonly string[]).includes(value);
}
export interface BridgeFailureDiagnostic {
  version: 1; updated: number; pid: number; stage: BridgeDiagnosticStage;
  elapsedMs: number; outcome: 'failed' | 'unconfirmed'; reason?: string; errorCode?: string;
}
export async function saveBridgeFailure(file: string, source: 'start' | 'worker', value: BridgeFailureDiagnostic): Promise<void> {
  // 每种来源只保留最近一次失败；不存凭据、API URL、响应正文或原始异常。
  await atomicJson(path.join(replyDirectory(file), 'bridge-failures', source + '.json'), value);
}

// 仅保留类型和有界状态码；不输出底层异常、URL、Token 或服务端正文。
export class TelegramRequestError extends ConfigError {
  constructor(public readonly code: number) {
    super(t(code === 409 ? 'reply.telegramConflict' : 'reply.telegramRequestFailed'));
  }
}
export function connectionReset(error: unknown): boolean {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  for (let checked = 0; pending.length && checked < 16; checked++) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const cause = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (cause.code === 'ECONNRESET') return true;
    pending.push(cause.cause);
    if (Array.isArray(cause.errors)) pending.push(...cause.errors.slice(0, 8));
  }
  return false;
}
export class TelegramConnectionResetError extends TransportError {
  constructor() { super(t('diagnostic.connectionReset')); }
}
export function safeFailureReason(error: unknown): string {
  if (error instanceof TelegramConnectionResetError) return t('diagnostic.connectionReset');
  if (error instanceof TelegramRequestError || error instanceof TelegramApiError) {
    const code = error.code;
    return Number.isSafeInteger(code) && code >= 100 && code <= 599
      ? t('diagnostic.telegramCode', { code }) : t('diagnostic.telegramUnknown');
  }
  if (error instanceof HttpError) {
    const code = error.status;
    return Number.isSafeInteger(code) && code >= 100 && code <= 599
      ? t('diagnostic.httpCode', { code }) : t('diagnostic.network');
  }
  if (error instanceof TransportError) return t('diagnostic.network');
  return t('diagnostic.unknown');
}
export class ReplyPreparationError extends ConfigError {
  constructor(error: unknown) {
    super(t('hook.replyIdentityFailed', { reason: safeFailureReason(error) }));
  }
}
// 公共库目前只返回安全文本而非错误类型。仅匹配本地已知值，不转发任意字符串。
export function safeDeliveryReason(error: unknown): string {
  if (error === t('diagnostic.connectionReset')) return t('diagnostic.connectionReset');
  for (const key of ['channels.network', 'channels.noResponse', 'channels.responseTooLarge', 'channels.notJsonObject'] as const) {
    if (error === t(key)) return t('diagnostic.network');
  }
  if (error === t('channels.rejected')) return t('diagnostic.rejected');
  return t('diagnostic.unknown');
}
