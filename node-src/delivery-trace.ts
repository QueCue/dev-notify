// 真实 hook 中 Telegram 发送单元的有界阶段取证。只观察，不新增请求、重试或定时器；
// 不保存收件人、正文、Token、URL、地址、请求头或原始异常，只保存序号、阶段和白名单分类。
import dc from 'node:diagnostics_channel';
import { HttpError, TransportError, type Plan } from '@quecue/notify-core';
import { requestJson } from './channels.js';
import { TelegramConnectionResetError } from './notification-diagnostics.js';

export type DeliveryStage = 'create' | 'connect' | 'connected' | 'connect-error' | 'headers-sent' | 'body-sent' | 'response' | 'error';
export interface DeliveryAttemptTrace {
  /** initial=首次；retry=公共库 429 等待后的同内容重发；plain=HTML 解析失败后的纯文本重发。 */
  kind: 'initial' | 'retry' | 'plain';
  atMs: number; elapsedMs: number; stages: DeliveryStage[];
  socket?: 'new' | 'reused'; socketUses?: number; idleMs?: number; family?: 4 | 6;
  status?: number; apiCode?: number; errorCodes?: string[];
  outcome: 'accepted' | 'rejected' | 'reset' | 'http' | 'network' | 'unknown';
}
export interface DeliveryUnitTrace {
  /** unit 为计划内序号；recipient 为本计划内接收人出现顺序，不是 chat ID。 */
  unit: number; recipient: number; part: number; parts: number; button: boolean;
  outcome: 'accepted' | 'rejected' | 'failed' | 'skipped';
  attempts: DeliveryAttemptTrace[];
}
export interface DeliveryTrace { units: DeliveryUnitTrace[]; omitted?: number }

export const MAX_TRACE_UNITS = 8, MAX_TRACE_ATTEMPTS = 4, MAX_TRACE_STAGES = 10;
const ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER']);
const CHANNELS = ['undici:request:create', 'undici:request:bodySent', 'undici:request:headers', 'undici:request:trailers',
  'undici:request:error', 'undici:client:beforeConnect', 'undici:client:connected', 'undici:client:connectError',
  'undici:client:sendHeaders'] as const;

export function safeErrorCodes(error: unknown): string[] {
  const pending: unknown[] = [error], seen = new Set<unknown>(), found = new Set<string>();
  for (let checked = 0; pending.length && checked < 16 && found.size < 3; checked++) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const item = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof item.code === 'string' && ERROR_CODES.has(item.code)) found.add(item.code);
    pending.push(item.cause);
    if (Array.isArray(item.errors)) pending.push(...item.errors.slice(0, 8));
  }
  return [...found];
}
const httpCode = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 100 && (value as number) <= 599 ? value as number : undefined;
function telegramMethod(request: any): string | undefined {
  try {
    if (new URL(String(request?.origin)).hostname !== 'api.telegram.org') return undefined;
    return String(request?.path ?? '').match(/\/(sendMessage|getMe|getWebhookInfo|getUpdates|editMessageReplyMarkup|answerCallbackQuery)(?:\?|$)/)?.[1];
  } catch { return undefined; }
}

interface SocketState { uses: number; creator?: DeliveryAttemptTrace; doneAt?: number }
export interface DeliveryTracer {
  /** 包装一次 Telegram 计划的请求函数；返回的 finish 生成该计划的有界摘要。 */
  telegram(plan: Plan, request?: typeof requestJson): { request: typeof requestJson; finish(): DeliveryTrace | undefined };
  close(): void;
}
export function createDeliveryTracer(now: () => number = () => performance.now(), channel: typeof dc = dc): DeliveryTracer {
  const started = now(), sockets = new WeakMap<object, SocketState>(), requests = new WeakMap<object, { attempt?: DeliveryAttemptTrace; socket?: SocketState }>();
  let current: DeliveryAttemptTrace | undefined, closed = false;
  const elapsed = () => Math.max(0, Math.round(now() - started));
  const stage = (attempt: DeliveryAttemptTrace | undefined, value: DeliveryStage) => {
    if (attempt && attempt.stages.length < MAX_TRACE_STAGES && attempt.stages.at(-1) !== value) attempt.stages.push(value);
  };
  const handlers: Record<string, (event: any) => void> = {
    'undici:request:create': event => {
      if (!telegramMethod(event?.request)) return;
      // 发送窗口外（如身份查询）的请求只用于跟踪连接复用，不归入发送单元。
      const attempt = current && telegramMethod(event.request) === 'sendMessage' ? current : undefined;
      requests.set(event.request, { attempt });
      stage(attempt, 'create');
    },
    'undici:client:beforeConnect': event => { if (event?.connectParams?.hostname === 'api.telegram.org') stage(current, 'connect'); },
    'undici:client:connected': event => {
      if (event?.connectParams?.hostname !== 'api.telegram.org' || !event.socket || typeof event.socket !== 'object') return;
      sockets.set(event.socket, { uses: 0, creator: current });
      stage(current, 'connected');
    },
    'undici:client:connectError': event => {
      if (event?.connectParams?.hostname !== 'api.telegram.org') return;
      stage(current, 'connect-error');
      if (current) current.errorCodes = [...new Set([...(current.errorCodes ?? []), ...safeErrorCodes(event.error)])].slice(0, 3);
    },
    'undici:client:sendHeaders': event => {
      const record = event?.request && requests.get(event.request);
      if (!record || !event.socket || typeof event.socket !== 'object') return;
      let socket = sockets.get(event.socket);
      // 观察开始前已存在的连接只能确定为复用，不能确定已服务次数和空闲时长。
      const known = Boolean(socket);
      if (!socket) { socket = { uses: 0 }; sockets.set(event.socket, socket); }
      const attempt = record.attempt;
      if (attempt) {
        attempt.socket = known && socket.uses === 0 && socket.creator === attempt ? 'new' : 'reused';
        if (attempt.socket === 'reused' && known) {
          attempt.socketUses = socket.uses;
          if (socket.doneAt !== undefined) attempt.idleMs = Math.max(0, Math.round(now() - socket.doneAt));
        }
        const family = event.socket.remoteFamily;
        if (family === 'IPv4' || family === 'IPv6') attempt.family = family === 'IPv4' ? 4 : 6;
        stage(attempt, 'headers-sent');
      }
      socket.uses++;
      record.socket = socket;
    },
    'undici:request:bodySent': event => stage(event?.request && requests.get(event.request)?.attempt, 'body-sent'),
    'undici:request:headers': event => {
      const record = event?.request && requests.get(event.request);
      if (!record) return;
      if (record.socket) record.socket.doneAt = now();
      stage(record.attempt, 'response');
      const status = httpCode(event.response?.statusCode);
      if (record.attempt && status) record.attempt.status = status;
    },
    'undici:request:trailers': event => {
      const record = event?.request && requests.get(event.request);
      if (record?.socket) record.socket.doneAt = now();
    },
    'undici:request:error': event => {
      const record = event?.request && requests.get(event.request);
      if (!record) return;
      if (record.socket) record.socket.doneAt = now();
      stage(record.attempt, 'error');
      if (record.attempt) record.attempt.errorCodes = [...new Set([...(record.attempt.errorCodes ?? []), ...safeErrorCodes(event.error)])].slice(0, 3);
    },
  };
  // 观察器自身异常一律吞掉，绝不影响通知发送。
  const safe = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, (event: unknown) => {
    try { if (!closed) handler(event); } catch { /* 忽略观察异常 */ }
  }]));
  for (const name of CHANNELS) { try { channel.subscribe(name, safe[name]); } catch { /* 运行时缺少该事件时降级 */ } }
  return {
    telegram(plan, request = requestJson) {
      const recipients: unknown[] = [], parts = new Map<unknown, number>();
      const units: DeliveryUnitTrace[] = plan.items.map((item, index) => {
        if (!recipients.includes(item.recipient)) recipients.push(item.recipient);
        const part = (parts.get(item.recipient) ?? 0) + 1;
        parts.set(item.recipient, part);
        return { unit: index + 1, recipient: recipients.indexOf(item.recipient) + 1, part, parts: 0,
          button: Boolean((item.payload as any)?.reply_markup), outcome: 'skipped', attempts: [] };
      });
      for (const unit of units) unit.parts = parts.get(plan.items[unit.unit - 1].recipient) ?? 1;
      let observed = false;
      const find = (payload: any) => {
        try {
          return plan.items.findIndex(item => item.recipient === payload?.chat_id
            && (payload?.text === (item.payload as any)?.text || payload?.text === item.plain));
        } catch { return -1; }
      };
      const traced: typeof requestJson = async (url, payload, fetcher) => {
        const index = find(payload), unit = units[index];
        let attempt: DeliveryAttemptTrace | undefined;
        if (unit && index < MAX_TRACE_UNITS && unit.attempts.length < MAX_TRACE_ATTEMPTS) {
          const plain = (plan.items[index].payload as any)?.parse_mode !== undefined && (payload as any)?.parse_mode === undefined;
          // 同类内容再次请求只可能来自公共库的 429 等待重发。
          const kind = plain ? (unit.attempts.some(value => value.kind === 'plain') ? 'retry' : 'plain')
            : unit.attempts.length ? 'retry' : 'initial';
          attempt = { kind, atMs: elapsed(), elapsedMs: 0, stages: [], outcome: 'unknown' };
          unit.attempts.push(attempt);
          observed = true;
        }
        const previous = current;
        current = attempt;
        const begin = now();
        try {
          const response = await request(url, payload, fetcher);
          if (attempt) {
            const ok = (response as any)?.ok === true;
            attempt.outcome = ok ? 'accepted' : 'rejected';
            const code = httpCode((response as any)?.error_code);
            if (!ok && code) attempt.apiCode = code;
          }
          return response;
        } catch (error) {
          if (attempt) {
            attempt.outcome = error instanceof TelegramConnectionResetError ? 'reset' : error instanceof HttpError ? 'http'
              : error instanceof TransportError ? 'network' : 'unknown';
            if (error instanceof HttpError && httpCode(error.status)) attempt.status = error.status;
          }
          throw error;
        } finally {
          if (attempt) attempt.elapsedMs = Math.max(0, Math.round(now() - begin));
          current = previous;
        }
      };
      return {
        request: traced,
        finish() {
          if (!observed) return undefined;
          for (const unit of units) {
            const last = unit.attempts.at(-1);
            unit.outcome = !last ? 'skipped' : last.outcome === 'accepted' ? 'accepted' : last.outcome === 'rejected' ? 'rejected' : 'failed';
          }
          const omitted = Math.max(0, units.length - MAX_TRACE_UNITS);
          return { units: units.slice(0, MAX_TRACE_UNITS), ...(omitted ? { omitted } : {}) };
        },
      };
    },
    close() {
      closed = true;
      for (const name of CHANNELS) { try { channel.unsubscribe(name, safe[name]); } catch { /* 忽略 */ } }
    },
  };
}
