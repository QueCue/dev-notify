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
export const botKey = (config: Config) => digest(config.telegram.token);
export interface ReplyPolicy { version: 1; enabled: boolean; bot: string; users: string[]; generation: string; permissions?: boolean }
export interface SessionTarget { session: string; pid: number; birth: string; tty: string; title: string; cwd: string; updated: number; working: boolean; tracked?: boolean; latestCall?: string }
export const targetEpoch = (target: SessionTarget) => digest(JSON.stringify([target.session, target.pid, target.birth, target.tty]));
export interface Entry { session: string; epoch: string; updated: number; request?: string; question?: number }
export interface Pending { hash: string; id: string; epoch: string; updated: number; queued: boolean;
  text?: string; chat: string; message: number; phase: 'queued' | 'submitted' | 'unknown' }
export interface Question { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }
export type InteractionEndReason = 'processed' | 'expired' | 'session' | 'switched' | 'closed' | 'failed';
export interface InteractionResult { kind: 'applied' | 'not-applied' | 'unknown'; text: string; reason?: InteractionEndReason }
export interface InteractionReceipt {
  id: string; chat: string; message: number; question?: string; answer: string; custom?: boolean;
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
  messages?: { chat: string; message: number; cleared?: boolean }[];
  notified?: { telegram?: string[]; feishu?: string };
}
export interface ReplyState {
  version: 1; identity: string; offset: number; sessions: Record<string, SessionTarget>;
  entries: Record<string, Entry>; pending: Record<string, Pending>; requests: Record<string, Interaction>;
  calls: Record<string, ToolCall>;
}
export interface ReplyAccess { policy: ReplyPolicy; config: Config; identity: string; file: string }
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
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.reply-${randomBytes(12).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function locked<T>(file: string, work: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { handle = await open(file, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConfigError(t('reply.lockUnavailable'));
      if (attempt === 99) throw new ConfigError(t('reply.lockBusy'));
      await delay(40);
    }
  }
  try { return await work(); }
  finally { await handle?.close(); await unlink(file); }
}
export async function accessReplies(file: string, env: Env = process.env): Promise<ReplyAccess | null> {
  const policy = await readJson(policyPath(file));
  if (policy === null || policy.enabled === false) return null;
  if (policy.version !== 1 || policy.enabled !== true || typeof policy.bot !== 'string' || !/^[a-f0-9]{64}$/.test(policy.bot)
    || typeof policy.generation !== 'string' || !/^[a-f0-9]{32}$/.test(policy.generation)
    || !Array.isArray(policy.users) || !policy.users.length || policy.users.some((id: unknown) => typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id))) {
    throw new ConfigError(t('reply.invalidPolicy'));
  }
  if (!await replyHooksReady(file, { env })) throw new ConfigError(t('reply.hooksMissing'));
  const config = await loadConfig(file, true, env);
  if (!ready(config, 'telegram') || botKey(config) !== policy.bot) throw new ConfigError(t('reply.botChanged'));
  const users = policy.users.filter((id: string) => config.telegram.chatIds.includes(id));
  if (!users.length) throw new ConfigError(t('reply.usersRevoked'));
  const effective = { ...policy, users } as ReplyPolicy;
  return { file, config, policy: effective, identity: digest(JSON.stringify([policy.bot, policy.generation, users, policy.permissions === true])) };
}
export async function stateTransaction<T>(access: ReplyAccess, work: (state: ReplyState) => Promise<T> | T): Promise<T> {
  const directory = replyDirectory(access.file);
  return locked(path.join(directory, 'state.lock'), async () => {
    const policy = await readJson(policyPath(access.file));
    if (!policy?.enabled || policy.bot !== access.policy.bot || policy.generation !== access.policy.generation
      || (policy.permissions === true) !== (access.policy.permissions === true)) throw new ConfigError(t('reply.authorizationChanged'));
    let state = await readJson(path.join(directory, 'state.json')) as ReplyState | null;
    if (!state || state.identity !== access.identity) state = { version: 1, identity: access.identity, offset: 0, sessions: {}, entries: {}, pending: {}, requests: {}, calls: {} };
    const record = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
    state.requests ??= {};
    state.calls ??= {};
    if (state.version !== 1 || !Number.isSafeInteger(state.offset) || state.offset < 0
      || ![state.sessions, state.entries, state.pending, state.requests, state.calls].every(record)) throw new ConfigError(t('reply.invalidState'));
    const now = Date.now();
    for (const section of [state.sessions, state.entries, state.pending, state.requests, state.calls]) for (const [key, value] of Object.entries(section)) {
      if (!record(value) || typeof value.updated !== 'number' || !Number.isFinite(value.updated)
        || value.updated > now + 60000 || now - value.updated > TTL) delete section[key];
    }
    for (const [key, value] of Object.entries(state.sessions)) {
      if (value.session !== key || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.birth !== 'string'
        || typeof value.tty !== 'string' || typeof value.working !== 'boolean') delete state.sessions[key];
    }
    for (const [key, value] of Object.entries(state.entries)) {
      if (typeof value.session !== 'string' || typeof value.epoch !== 'string') delete state.entries[key];
    }
    for (const [key, value] of Object.entries(state.pending)) {
      if (typeof value.epoch !== 'string' || !/^[1-9][0-9]*$/.test(value.chat) || typeof value.id !== 'string'
        || !['queued', 'submitted', 'unknown'].includes(value.phase)) delete state.pending[key];
    }
    for (const [key, value] of Object.entries(state.requests)) {
      if (value.id !== key || !['question', 'permission'].includes(value.kind) || !record(value.input)
        || !Array.isArray(value.questions) || !record(value.answers) || !Array.isArray(value.selected)
        || !Number.isFinite(value.expires)) delete state.requests[key];
    }
    const result = await work(state);
    await atomicJson(path.join(directory, 'state.json'), state);
    return result;
  });
}
export async function configureReplies(file: string, prompts: Prompts, env: Env = process.env): Promise<boolean> {
  if (!await replyHooksReady(file, { env })) throw new ConfigError(t('reply.setupHooksFirst'));
  const config = await loadConfig(file, true, env);
  if (!ready(config, 'telegram')) throw new ConfigError(t('reply.setupTelegramFirst'));
  const available = config.telegram.chatIds.filter(id => /^[1-9][0-9]*$/.test(id));
  if (!available.length) throw new ConfigError(t('reply.setupPrivateOnly'));
  const before = await readJson(policyPath(file));
  prompts.out(t('reply.setupNoticeInput'));
  prompts.out(t('reply.setupNoticeBridge'));
  prompts.out(t('reply.setupNoticePlatform'));
  prompts.out(t('reply.setupNoticeUnsupported'));
  prompts.out(t('reply.setupAvailable', { users: joinList(available) }));
  const text = await prompts.text(t('reply.setupPrompt'));
  if (!text.trim()) return false;
  const users = [...new Set(text.split(',').map(id => id.trim()))];
  if (users.some(id => !available.includes(id))) throw new ConfigError(t('reply.setupInvalidUser'));
  prompts.out(t('reply.setupAuthorizing', { users: joinList(users) }));
  prompts.out(t('reply.setupSensitive'));
  const permissions = /^(y|yes)$/i.test(await prompts.text(t('reply.setupPermissionsPrompt')));
  if (!/^(y|yes)$/i.test(await prompts.text(t('reply.setupConfirm')))) return false;
  await locked(policyPath(file) + '.lock', async () => {
    if (JSON.stringify(before) !== JSON.stringify(await readJson(policyPath(file)))) throw new ConfigError(t('reply.setupChanged'));
    const effective = await loadConfig(file, true, env);
    if (botKey(effective) !== botKey(config) || users.some(id => !effective.telegram.chatIds.includes(id))) throw new ConfigError(t('reply.setupConfigChanged'));
    await atomicJson(policyPath(file), { version: 1, enabled: true, bot: botKey(config), users, permissions, generation: randomBytes(16).toString('hex') } satisfies ReplyPolicy);
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
