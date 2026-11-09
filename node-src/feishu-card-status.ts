import { getLocale, setLocale, t, type Locale } from './i18n.js';
import { lookupSession, type SessionLookup } from './reply-platform.js';
import { processState } from './reply-lock.js';
import { stateTransaction, targetEpoch, messageKey, type ReplyAccess } from './reply-state.js';

export type FeishuCardStatus = 'preparing' | 'enabled' | 'working' | 'paused' | 'expired' | 'closed' | 'switched';
export interface FeishuReplyCard {
  message: string; user: string; session: string; epoch: string; expires: number;
  title: string; footer: string; card: Record<string, any>; language: Locale;
  status: FeishuCardStatus; invalidated?: 'closed' | 'switched'; attempted?: number;
}
export const MAX_REPLY_CARDS = 256;
const terminal = (status: FeishuCardStatus) => ['expired', 'closed', 'switched'].includes(status);
export function replyCardFooter(detail: string, expires: number, footer: string): string {
  return [detail, t('feishu.replyExpiry', { time: new Date(expires).toLocaleString(getLocale() === 'en' ? 'en-GB' : 'zh-CN', { hour12: false }) }),
    t('feishu.replyRefreshNote'), footer].filter(Boolean).join('\n');
}
function render(value: FeishuReplyCard, status: FeishuCardStatus): Record<string, any> {
  const previous = getLocale();
  try {
    // 翻译仅在无 await 的同步渲染段切换，旧卡片继续使用发送时语言。
    setLocale(value.language);
    const card = structuredClone(value.card);
    const labels = { preparing: 'feishu.replyPreparing', enabled: 'feishu.replyAvailable', working: 'feishu.replyWorking', paused: 'feishu.replyPaused',
      expired: 'feishu.replyExpired', closed: 'feishu.replyClosed', switched: 'feishu.replySwitched' } as const;
    const details = { preparing: 'feishu.replyPreparingDetail', enabled: 'feishu.replyHint', working: 'feishu.replyWorkingDetail', paused: 'feishu.replyPausedDetail',
      expired: 'feishu.replyExpiredDetail', closed: 'feishu.replyClosedDetail', switched: 'feishu.replySwitchedDetail' } as const;
    card.header.title.content = `${t(labels[status])}｜${value.title}`;
    card.header.template = status === 'enabled' ? 'green' : status === 'working' ? 'blue' : status === 'paused' ? 'yellow' : 'grey';
    const note = card.elements.find((element: any) => element.tag === 'note');
    if (note) note.elements = [{ tag: 'plain_text', content: replyCardFooter(t(details[status]), value.expires, value.footer) }];
    return card;
  } finally { setLocale(previous); }
}
export interface CardRefreshOptions {
  fresh: () => Promise<ReplyAccess | null>;
  inspect?: (session: string) => Promise<SessionLookup>;
  process?: typeof processState;
  env?: import('./config.js').Env;
  now?: number;
  limit?: number;
  log?: (text: string) => void;
}
export async function refreshFeishuReplyCards(access: ReplyAccess,
  update: (message: string, content: string) => Promise<void>, options: CardRefreshOptions): Promise<void> {
  if (access.policy.channel !== 'feishu') return;
  const initial = await options.fresh().catch(() => null);
  if (!initial || initial.identity !== access.identity) return;
  const now = options.now ?? Date.now();
  const values = await stateTransaction(access, state => Object.values(state.feishuCards ?? {}).map(value => ({
    value: structuredClone(value), target: state.sessions[value.session], entry: state.entries[messageKey(access, value.user, value.message)],
  })));
  const inspected = new Map<string, SessionLookup>();
  let attempts = 0;
  for (const { value, target, entry } of values) {
    if (terminal(value.status) || value.attempted && now - value.attempted < 30000) continue;
    const current = await options.fresh();
    if (!current || current.identity !== access.identity || !current.policy.users.includes(value.user)) return;
    let status: FeishuCardStatus;
    if (value.invalidated) status = value.invalidated;
    else if (now >= value.expires) status = 'expired';
    else if (!target || !entry || entry.session !== value.session || entry.epoch !== value.epoch) status = 'paused';
    else if (targetEpoch(target) !== value.epoch) status = 'switched';
    else {
      let inspection = inspected.get(value.session);
      if (!inspection) {
        try { inspection = await (options.inspect ?? (session => lookupSession(session, { env: options.env })))(value.session); }
        catch { inspection = { status: 'unavailable' }; }
        inspected.set(value.session, inspection);
      }
      if (inspection.status === 'unavailable') status = 'paused';
      else if (inspection.status === 'missing') status = (options.process ?? processState)(target.pid) === 'dead' ? 'closed' : 'paused';
      else if (inspection.status === 'found') status = targetEpoch(inspection.target) !== value.epoch ? 'switched'
        : target.unverified || !target.tracked ? 'paused' : target.working ? 'working' : 'enabled';
      else status = 'paused';
    }
    if (status === value.status) continue;
    if (attempts++ >= (options.limit ?? 8)) break;
    const claimed = await stateTransaction(current, state => {
      const actual = state.feishuCards?.[value.message];
      if (!actual || actual.epoch !== value.epoch || actual.status !== value.status || actual.invalidated !== value.invalidated
        || actual.attempted && now - actual.attempted < 30000) return false;
      actual.attempted = now;
      return true;
    });
    if (!claimed) continue;
    const final = await options.fresh();
    if (!final || final.identity !== access.identity) return;
    try {
      await update(value.message, JSON.stringify(render(value, status)));
      await stateTransaction(final, state => {
        const actual = state.feishuCards?.[value.message];
        if (actual?.epoch === value.epoch) { actual.status = status; delete actual.attempted; }
      });
    } catch { options.log?.(t('feishu.replyRefreshFailed')); }
  }
}
