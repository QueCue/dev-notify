import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigError, decodeUtf8, loadConfig, ready, type Config, type Env } from './config.js';
import { joinList, t } from './i18n.js';
import type { Prompts } from './prompts.js';
import { replyHooksReady } from './claude-code.js';

export const TTL = 24 * 60 * 60 * 1000;
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export type ReplyChannel = 'telegram' | 'feishu';
export const replyChannel = (access: ReplyAccess): ReplyChannel => access.policy.channel ?? 'telegram';
export const botKey = (config: Config, channel: ReplyChannel = 'telegram') => channel === 'feishu'
  ? digest(JSON.stringify(['feishu', config.feishu.appId, config.feishu.appSecret])) : digest(config.telegram.token);
export type MessageId = number | string;
export const validMessageId = (id: unknown): id is MessageId => typeof id === 'number' ? Number.isSafeInteger(id) && id > 0 : typeof id === 'string' && /^om_[A-Za-z0-9_-]+$/.test(id);
export const messageKey = (access: ReplyAccess, chat: string, id: MessageId) => `${replyChannel(access) === 'feishu' ? 'fs' : 'tg'}:${chat}:${id}`;
export interface ReplyPolicy { version: 1; enabled: boolean; bot: string; users: string[]; generation: string; permissions?: boolean; channel?: ReplyChannel }
export interface SessionTarget { session: string; pid: number; birth: string; tty: string; title: string; cwd: string; updated: number; working: boolean; tracked?: boolean; latestCall?: string; unverified?: boolean }
export const targetEpoch = (target: SessionTarget) => digest(JSON.stringify([target.session, target.pid, target.birth, target.tty]));
export interface Entry { session: string; epoch: string; updated: number; request?: string; question?: number }
export interface Pending { hash: string; id: string; epoch: string; updated: number; queued: boolean;
  text?: string; chat: string; message: MessageId; phase: 'queued' | 'submitted' | 'unknown' }
export interface Question { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }
export type InteractionEndReason = 'processed' | 'expired' | 'session' | 'switched' | 'closed' | 'failed';
export interface InteractionResult { kind: 'applied' | 'not-applied' | 'unknown'; text: string; reason?: InteractionEndReason }
export interface InteractionReceipt {
  id: string; chat: string; message: MessageId; question?: string; answer: string; custom?: boolean;
  result?: InteractionResult; delivery?: 'sending' | 'sent' | 'unknown';
}
export interface ToolCall {
  id: string; session: string; epoch: string; tool: string; fingerprint: string;
  prompt?: string; updated: number; ended?: boolean; request?: string;
}
export interface Interaction {
  id: string; session: string; epoch: string; updated: number; expires: number;
  kind: 'question' | 'permission'; input: Record<string, any>; questions: Question[];
  answers: Record<string, string>; selected: number[]; index: number;
  response?: Record<string, any>; claimed?: boolean;
  call?: string; result?: InteractionResult; receipts?: InteractionReceipt[];
  messages?: { chat: string; message: MessageId; cleared?: boolean; registered?: boolean }[];
  displayed?: Record<string, number>;
  notified?: { telegram?: string[]; feishu?: string; feishuUsers?: string[] };
}
export interface ReplyState {
  version: 1; identity: string; offset: number; sessions: Record<string, SessionTarget>;
  entries: Record<string, Entry>; pending: Record<string, Pending>; requests: Record<string, Interaction>;
  calls: Record<string, ToolCall>;
  feishuInbox?: Record<string, import('./reply-feishu.js').FeishuInboxMessage>;
  feishuSeen?: Record<string, number>;
  feishuCards?: Record<string, import('./feishu-card-status.js').FeishuReplyCard>;
}
export interface ReplyAccess { policy: ReplyPolicy; config: Config; identity: string; file: string;
  grants?: Partial<Record<ReplyChannel, ReplyPolicy>>; authorization?: string; view?: ReplyChannel }
export function channelAccess(access: ReplyAccess, channel: ReplyChannel): ReplyAccess | null {
  if (!access.grants) return replyChannel(access) === channel ? access : null;
  const policy = access.grants[channel];
  return policy ? { ...access, policy, view: channel } : null;
}
export const replyAccesses = (access: ReplyAccess): ReplyAccess[] => access.grants
  ? (['telegram', 'feishu'] as const).flatMap(channel => { const value = channelAccess(access, channel); return value ? [value] : []; }) : [access];
export const chatChannel = (chat: string): ReplyChannel => typeof chat === 'string' && chat.startsWith('ou_') ? 'feishu' : 'telegram';
export const authorizedChat = (access: ReplyAccess, chat: string): boolean => channelAccess(access, chatChannel(chat))?.policy.users.includes(chat) === true;
export const policyPath = (config: string) => config + '.reply.json';
export const replyDirectory = (config: string) => config + '.reply-data';
export async function readJson(file: string): Promise<any | null> {
  try {
    const bytes = await readFile(file);
    if (bytes.length > 16 * 1024 * 1024) throw new Error();
    return JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigError(t('reply.readFailed'));
  }
}
// Windows 防病毒/索引程序可能短暂占用目标文件；只重试原子替换，不重做状态事务或业务操作。
export async function replaceStateFile(source: string, target: string,
  replace: typeof rename = rename, sleep: (ms: number) => Promise<unknown> = delay): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await replace(source, target); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 5) throw error;
      await sleep(10 * 2 ** attempt);
    }
  }
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.reply-${randomBytes(12).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await replaceStateFile(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function locked<T>(file: string, work: () => Promise<T>, attempts = 100): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { handle = await open(file, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConfigError(t('reply.lockUnavailable'));
      if (attempt === attempts - 1) throw new ConfigError(t('reply.lockBusy'));
      await delay(40);
    }
  }
  try { return await work(); }
  finally { await handle?.close(); await unlink(file); }
}
export async function accessReplies(file: string, env: Env = process.env): Promise<ReplyAccess | null> {
  const policy = await readJson(policyPath(file));
  if (policy === null || policy.enabled === false) return null;
  if (policy.version === 2) {
    if (policy.enabled !== true || typeof policy.generation !== 'string' || !/^[a-f0-9]{32}$/.test(policy.generation)
      || !policy.channels || typeof policy.channels !== 'object' || Array.isArray(policy.channels)
      || !Object.keys(policy.channels).length || Object.keys(policy.channels).some(key => !['telegram', 'feishu'].includes(key))) throw new ConfigError(t('reply.invalidPolicy'));
    if (!await replyHooksReady(file, { env })) throw new ConfigError(t('reply.hooksMissing'));
    const config = await loadConfig(file, true, env);
    const grants: Partial<Record<ReplyChannel, ReplyPolicy>> = {};
    for (const channel of ['telegram', 'feishu'] as const) {
      const grant = policy.channels[channel];
      if (grant === undefined) continue;
      const pattern = channel === 'feishu' ? /^ou_[A-Za-z0-9_-]+$/ : /^[1-9][0-9]*$/;
      if (!grant || typeof grant !== 'object' || typeof grant.bot !== 'string' || !/^[a-f0-9]{64}$/.test(grant.bot)
        || !Array.isArray(grant.users) || !grant.users.length || grant.users.some((id: unknown) => typeof id !== 'string' || !pattern.test(id))
        || typeof grant.permissions !== 'boolean') throw new ConfigError(t('reply.invalidPolicy'));
      if (!ready(config, channel) || channel === 'feishu' && config.feishu.mode !== 'app' || botKey(config, channel) !== grant.bot) continue;
      const recipients = channel === 'feishu' ? config.feishu.openIds ?? [] : config.telegram.chatIds;
      const users = grant.users.filter((id: string) => recipients.includes(id));
      if (users.length) grants[channel] = { version: 1, enabled: true, channel, bot: grant.bot, users, permissions: grant.permissions, generation: policy.generation };
    }
    const primary = grants.telegram ?? grants.feishu;
    if (!primary) throw new ConfigError(t('reply.botChanged'));
    return { file, config, policy: primary, grants, identity: digest(JSON.stringify([policy.generation, grants])), authorization: digest(JSON.stringify(policy)) };
  }
  const channel: ReplyChannel = policy.channel ?? 'telegram';
  const userPattern = channel === 'feishu' ? /^ou_[A-Za-z0-9_-]+$/ : /^[1-9][0-9]*$/;
  if (!['telegram', 'feishu'].includes(channel) || policy.version !== 1 || policy.enabled !== true || typeof policy.bot !== 'string' || !/^[a-f0-9]{64}$/.test(policy.bot)
    || typeof policy.generation !== 'string' || !/^[a-f0-9]{32}$/.test(policy.generation)
    || !Array.isArray(policy.users) || !policy.users.length || policy.users.some((id: unknown) => typeof id !== 'string' || !userPattern.test(id))) {
    throw new ConfigError(t('reply.invalidPolicy'));
  }
  if (!await replyHooksReady(file, { env })) throw new ConfigError(t('reply.hooksMissing'));
  const config = await loadConfig(file, true, env);
  if (!ready(config, channel) || channel === 'feishu' && config.feishu.mode !== 'app' || botKey(config, channel) !== policy.bot) throw new ConfigError(t('reply.botChanged'));
  const recipients = channel === 'feishu' ? config.feishu.openIds ?? [] : config.telegram.chatIds;
  const users = policy.users.filter((id: string) => recipients.includes(id));
  if (!users.length) throw new ConfigError(t('reply.usersRevoked'));
  const effective = { ...policy, users } as ReplyPolicy;
  return { file, config, policy: effective, identity: digest(JSON.stringify([policy.bot, policy.generation, users, policy.permissions === true])) };
}
export async function stateTransaction<T>(access: ReplyAccess, work: (state: ReplyState) => Promise<T> | T, lockAttempts = 100): Promise<T> {
  const directory = replyDirectory(access.file);
  return locked(path.join(directory, 'state.lock'), async () => {
    const policy = await readJson(policyPath(access.file));
    const unchanged = access.authorization ? policy?.version === 2 && digest(JSON.stringify(policy)) === access.authorization
      : policy?.version === 1 && policy.bot === access.policy.bot && policy.generation === access.policy.generation
        && (policy.channel ?? 'telegram') === replyChannel(access) && (policy.permissions === true) === (access.policy.permissions === true);
    if (!policy?.enabled || !unchanged) throw new ConfigError(t('reply.authorizationChanged'));
    let state = await readJson(path.join(directory, 'state.json')) as ReplyState | null;
    const before = JSON.stringify(state);
    if (!state || state.identity !== access.identity) state = { version: 1, identity: access.identity, offset: 0, sessions: {}, entries: {}, pending: {}, requests: {}, calls: {} };
    const record = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
    state.requests ??= {};
    state.calls ??= {};
    if (state.version !== 1 || !Number.isSafeInteger(state.offset) || state.offset < 0
      || ![state.sessions, state.entries, state.pending, state.requests, state.calls].every(record)
      || state.feishuInbox !== undefined && !record(state.feishuInbox)
      || state.feishuSeen !== undefined && !record(state.feishuSeen)
      || state.feishuCards !== undefined && !record(state.feishuCards)) throw new ConfigError(t('reply.invalidState'));
    const now = Date.now();
    for (const section of [state.sessions, state.entries, state.pending, state.requests, state.calls]) for (const [key, value] of Object.entries(section)) {
      if (!record(value) || typeof value.updated !== 'number' || !Number.isFinite(value.updated)
        || value.updated > now + 60000 || now - value.updated > TTL) delete section[key];
    }
    for (const [key, value] of Object.entries(state.feishuCards ?? {})) {
      if (!record(value) || value.message !== key || typeof value.user !== 'string' || !record(value.card)
        || typeof value.session !== 'string' || typeof value.epoch !== 'string' || typeof value.title !== 'string'
        || typeof value.footer !== 'string' || !['zh', 'en'].includes(value.language)
        || !['preparing', 'enabled', 'working', 'paused', 'expired', 'closed', 'switched'].includes(value.status)
        || !Number.isFinite(value.expires) || now - value.expires > TTL) delete state.feishuCards![key];
    }
    for (const [key, value] of Object.entries(state.feishuInbox ?? {})) {
      if (!record(value) || value.id !== key || typeof value.user !== 'string' || typeof value.text !== 'string'
        || !Number.isFinite(value.created) || now - value.created > 300000 || value.created > now + 60000) delete state.feishuInbox![key];
    }
    for (const [key, value] of Object.entries(state.sessions)) {
      if (value.session !== key || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.birth !== 'string'
        || typeof value.tty !== 'string' || typeof value.working !== 'boolean'
        || value.unverified !== undefined && typeof value.unverified !== 'boolean') delete state.sessions[key];
    }
    for (const [key, value] of Object.entries(state.entries)) {
      if (typeof value.session !== 'string' || typeof value.epoch !== 'string') delete state.entries[key];
    }
    for (const [key, value] of Object.entries(state.pending)) {
      if (typeof value.epoch !== 'string' || !(chatChannel(value.chat) === 'feishu' ? /^ou_[A-Za-z0-9_-]+$/ : /^[1-9][0-9]*$/).test(value.chat) || typeof value.id !== 'string'
        || !['queued', 'submitted', 'unknown'].includes(value.phase)) delete state.pending[key];
    }
    for (const [key, value] of Object.entries(state.requests)) {
      if (value.id !== key || !['question', 'permission'].includes(value.kind) || !record(value.input)
        || !Array.isArray(value.questions) || !record(value.answers) || !Array.isArray(value.selected)
        || !Number.isFinite(value.expires)) delete state.requests[key];
    }
    const result = await work(state);
    // 长连接空闲检查不反复重写状态；清理、入队和所有业务变更仍在同一锁内原子提交。
    if (JSON.stringify(state) !== before) await atomicJson(path.join(directory, 'state.json'), state);
    return result;
  }, lockAttempts);
}
export async function configureReplies(file: string, prompts: Prompts, env: Env = process.env): Promise<boolean> {
  if (!await replyHooksReady(file, { env })) throw new ConfigError(t('reply.setupHooksFirst'));
  const config = await loadConfig(file, true, env);
  const telegram = ready(config, 'telegram'), feishu = ready(config, 'feishu') && config.feishu.mode === 'app';
  if (!telegram && !feishu) throw new ConfigError(t('feishu.setupFirst'));
  const before = await readJson(policyPath(file));
  let channels: ReplyChannel[] = [feishu && !telegram ? 'feishu' : 'telegram'];
  if (telegram && feishu) {
    const current = before?.version === 2 && before.channels?.telegram && before.channels?.feishu ? '3' : before?.channel === 'feishu' ? '2' : '1';
    const selected = (await prompts.text(t('feishu.channelPrompt', { current }))).trim() || current;
    if (!['1', '2', '3'].includes(selected)) return false;
    channels = selected === '3' ? ['telegram', 'feishu'] : [selected === '2' ? 'feishu' : 'telegram'];
  }
  const grants: Partial<Record<ReplyChannel, { bot: string; users: string[]; permissions: boolean }>> = {};
  prompts.out(t('reply.setupNoticeInput'));
  prompts.out(t('reply.setupNoticePlatform'));
  prompts.out(t('reply.setupNoticeUnsupported'));
  for (const channel of channels) {
    const available = channel === 'feishu' ? config.feishu.openIds ?? [] : config.telegram.chatIds.filter(id => /^[1-9][0-9]*$/.test(id));
    if (!available.length) throw new ConfigError(t('reply.setupPrivateOnly'));
    prompts.out(t('feishu.channelStatus', { channel: channel === 'telegram' ? 'Telegram' : 'Feishu' }));
    prompts.out(t(channel === 'feishu' ? 'feishu.setupNotice' : 'reply.setupNoticeBridge'));
    prompts.out(t('reply.setupAvailable', { users: available.join(', ') }));
    const text = await prompts.text(t(channel === 'feishu' ? 'reply.setupFeishuPrompt' : 'reply.setupTelegramPrompt'));
    if (!text.trim()) return false;
    const users = [...new Set(text.split(/[,，、;；\s]+/u).filter(Boolean))];
    if (!users.length || users.some(id => !available.includes(id))) throw new ConfigError(t('reply.setupInvalidUser'));
    prompts.out(t('reply.setupAuthorizing', { users: joinList(users) }));
    prompts.out(t('reply.setupSensitive'));
    const permissions = /^(y|yes)$/i.test(await prompts.text(t('reply.setupPermissionsPrompt')));
    grants[channel] = { bot: botKey(config, channel), users, permissions };
  }
  await locked(policyPath(file) + '.lock', async () => {
    if (JSON.stringify(before) !== JSON.stringify(await readJson(policyPath(file)))) throw new ConfigError(t('reply.setupChanged'));
    const effective = await loadConfig(file, true, env);
    for (const channel of channels) {
      const recipients = channel === 'feishu' ? effective.feishu.openIds ?? [] : effective.telegram.chatIds;
      if (!ready(effective, channel) || botKey(effective, channel) !== botKey(config, channel)
        || grants[channel]!.users.some(id => !recipients.includes(id))) throw new ConfigError(t('reply.setupConfigChanged'));
    }
    const generation = randomBytes(16).toString('hex');
    await atomicJson(policyPath(file), channels.length > 1 ? { version: 2, enabled: true, generation, channels: grants }
      : { version: 1, enabled: true, ...grants[channels[0]], ...(channels[0] === 'feishu' ? { channel: 'feishu' } : {}), generation });
  });
  prompts.out(t('reply.setupSaved'));
  return true;
}
export async function disableReplies(file: string, prompts: Prompts): Promise<boolean> {
  const before = await readJson(policyPath(file));
  if (!before?.enabled) { prompts.out(t('reply.disableNotEnabled')); return true; }
  if (!/^(y|yes)$/i.test(await prompts.text(t('reply.disableConfirm')))) return false;
  await locked(policyPath(file) + '.lock', async () => {
    if (JSON.stringify(before) !== JSON.stringify(await readJson(policyPath(file)))) throw new ConfigError(t('reply.disableChanged'));
    await atomicJson(policyPath(file), { ...before, enabled: false });
  });
  prompts.out(t('reply.disabled'));
  return true;
}
