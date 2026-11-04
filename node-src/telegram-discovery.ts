import { requestJson, type Request } from './channels.js';
import { ConfigError } from './config.js';
import { t } from './i18n.js';

export type ChatKind = 'private' | 'group' | 'supergroup' | 'channel' | 'unknown';
export interface ChatCandidate { id: string; title: string; kind: ChatKind }

const KINDS = new Set(['private', 'group', 'supergroup', 'channel']);
const MAX_CANDIDATES = 20;

function clean(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim()).slice(0, limit).join('');
}
function label(chat: Record<string, any>, kind: ChatKind): string {
  const name = kind === 'private'
    ? [clean(chat.first_name, 60), clean(chat.last_name, 60)].filter(Boolean).join(' ')
    : clean(chat.title, 80);
  const username = clean(chat.username, 60);
  const value = [name, username ? '@' + username : ''].filter(Boolean).join(' ');
  return value || t('discovery.unnamed');
}
/** 只从更新中提取 chat 元数据；消息正文、发件人等内容不会进入结果或日志。 */
export function chatsFromUpdates(updates: unknown): ChatCandidate[] {
  if (!Array.isArray(updates)) return [];
  const seen = new Map<string, ChatCandidate>();
  for (const update of updates) {
    if (!update || typeof update !== 'object') continue;
    const message = (update as Record<string, any>).message ?? (update as Record<string, any>).channel_post;
    const chat = message?.chat;
    if (!chat || !Number.isSafeInteger(chat.id) || chat.id === 0) continue;
    const kind: ChatKind = KINDS.has(chat.type) ? chat.type : 'unknown';
    const id = String(chat.id);
    // 同一会话只保留最后一次出现的位置，最近活跃的会话排在前面。
    seen.delete(id);
    seen.set(id, { id, title: label(chat, kind), kind });
  }
  return [...seen.values()].slice(-MAX_CANDIDATES).reverse();
}
async function call(token: string, method: string, payload: Record<string, unknown>, request: Request): Promise<any> {
  let response: Record<string, any>;
  try { response = await request(`https://api.telegram.org/bot${token}/${method}`, payload); }
  catch { throw new ConfigError(t('discovery.network')); }
  if (response?.ok === true) return response.result;
  if (response?.error_code === 401) throw new ConfigError(t('discovery.unauthorized'));
  if (response?.error_code === 409) throw new ConfigError(t('discovery.conflict'));
  throw new ConfigError(t('discovery.failed'));
}
export async function discoverChats(token: string, request: Request = requestJson): Promise<ChatCandidate[]> {
  if (!token) throw new ConfigError(t('discovery.noToken'));
  // 不确认 offset，也不保存消息正文；只用于让用户从最近会话中选择接收人。
  const updates = await call(token, 'getUpdates', { limit: 50, timeout: 0, allowed_updates: ['message'] }, request);
  if (!Array.isArray(updates)) throw new ConfigError(t('discovery.failed'));
  return chatsFromUpdates(updates);
}
