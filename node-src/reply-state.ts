import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigError, decodeUtf8, loadConfig, ready, type Config, type Env } from './config.js';
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
export interface InteractionResult { kind: 'applied' | 'not-applied' | 'unknown'; text: string }
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
    throw new ConfigError('无法读取回复配置或状态。为了不覆盖现有数据，远程输入没有启用。');
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
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConfigError('无法获取回复状态写入锁。');
      if (attempt === 99) throw new ConfigError('回复状态锁正忙。请确认相关进程已经退出，再处理残留锁。');
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
    throw new ConfigError('回复授权配置无效，远程输入已停用。');
  }
  if (!await replyHooksReady(file, { env })) throw new ConfigError('回复所需的 hooks 缺失、时序不安全或已禁用。请重新运行 integration claude-code install，并在 /hooks 中确认加载。');
  const config = await loadConfig(file, true, env);
  if (!ready(config, 'telegram') || botKey(config) !== policy.bot) throw new ConfigError('Telegram Bot 已变更或不可用，请重新运行 reply setup 授权。');
  const users = policy.users.filter((id: string) => config.telegram.chatIds.includes(id));
  if (!users.length) throw new ConfigError('授权用户不在当前 Telegram 接收名单中，远程输入已停用。');
  const effective = { ...policy, users } as ReplyPolicy;
  return { file, config, policy: effective, identity: digest(JSON.stringify([policy.bot, policy.generation, users, policy.permissions === true])) };
}
export async function stateTransaction<T>(access: ReplyAccess, work: (state: ReplyState) => Promise<T> | T): Promise<T> {
  const directory = replyDirectory(access.file);
  return locked(path.join(directory, 'state.lock'), async () => {
    const policy = await readJson(policyPath(access.file));
    if (!policy?.enabled || policy.bot !== access.policy.bot || policy.generation !== access.policy.generation
      || (policy.permissions === true) !== (access.policy.permissions === true)) throw new ConfigError('回复授权已撤销或发生变化，没有写入旧状态。');
    let state = await readJson(path.join(directory, 'state.json')) as ReplyState | null;
    if (!state || state.identity !== access.identity) state = { version: 1, identity: access.identity, offset: 0, sessions: {}, entries: {}, pending: {}, requests: {}, calls: {} };
    const record = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
    state.requests ??= {};
    state.calls ??= {};
    if (state.version !== 1 || !Number.isSafeInteger(state.offset) || state.offset < 0
      || ![state.sessions, state.entries, state.pending, state.requests, state.calls].every(record)) throw new ConfigError('回复状态结构无效，远程输入已停用。');
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
  if (!await replyHooksReady(file, { env })) throw new ConfigError('请先运行 integration claude-code install，安装绑定此通知配置的完整 hooks，再配置回复。');
  const config = await loadConfig(file, true, env);
  if (!ready(config, 'telegram')) throw new ConfigError('回复 Claude 需要先配置 Telegram Bot 和私聊接收人。');
  const available = config.telegram.chatIds.filter(id => /^[1-9][0-9]*$/.test(id));
  if (!available.length) throw new ConfigError('远程回复仅支持 Telegram 私聊用户，不支持群聊。');
  const before = await readJson(policyPath(file));
  prompts.out('远程回复等同于在本机 Claude Code 终端输入并提交内容。它可以提交 Claude 命令，但不会自动批准工具权限。请只授权给可信用户。');
  prompts.out('飞书按钮会跳转到 Telegram，不直接接收飞书消息。这个功能需要独占 Bot 的 getUpdates，请不要与旧版桥接或其他机器共用同一个 Bot。');
  prompts.out('Windows 使用系统 PowerShell / 控制台 API；macOS 使用 Ghostty 或 tmux，需要相应的系统权限。');
  prompts.out('目前不支持 VS Code 集成终端、WSL 和 SSH。目标不确定或会话已经切换时，会拒绝输入。');
  prompts.out('通知接收人不会自动获得输入权限。可选择的私聊 chat_id：' + available.join('、'));
  const text = await prompts.text('请输入要授权的私聊 chat_id（逗号分隔；留空取消）：');
  if (!text.trim()) return false;
  const users = [...new Set(text.split(',').map(id => id.trim()))];
  if (users.some(id => !available.includes(id))) throw new ConfigError('只能授权当前通知名单中的私聊用户。');
  prompts.out('将授权以下用户远程输入：' + users.join('、'));
  prompts.out('结构化问题会展示真实选项，也支持自定义回答；普通回复会在本轮结束后输入。问题、选项和工具请求参数可能包含敏感信息，会发送到授权私聊和已配置的飞书。');
  const permissions = /^(y|yes)$/i.test(await prompts.text('是否允许这些用户逐次批准或拒绝工具权限？这不会修改永久规则。[y/N] '));
  if (!/^(y|yes)$/i.test(await prompts.text('确认启用远程回复并接受上述权限范围？[y/N] '))) return false;
  await locked(policyPath(file) + '.lock', async () => {
    if (JSON.stringify(before) !== JSON.stringify(await readJson(policyPath(file)))) throw new ConfigError('回复授权已被其他进程修改，请重试。');
    const effective = await loadConfig(file, true, env);
    if (botKey(effective) !== botKey(config) || users.some(id => !effective.telegram.chatIds.includes(id))) throw new ConfigError('通知配置在授权期间发生了变化，请重试。');
    await atomicJson(policyPath(file), { version: 1, enabled: true, bot: botKey(config), users, permissions, generation: randomBytes(16).toString('hex') } satisfies ReplyPolicy);
  });
  prompts.out('授权已保存。旧消息的回复映射不会保留；请从启用后的任务完成通知进入。');
  return true;
}
export async function disableReplies(file: string, prompts: Prompts): Promise<boolean> {
  const before = await readJson(policyPath(file));
  if (!before?.enabled) { prompts.out('远程回复尚未启用。'); return true; }
  if (!/^(y|yes)$/i.test(await prompts.text('确认禁用远程回复？通知和凭据都会保留。[y/N] '))) return false;
  await locked(policyPath(file) + '.lock', async () => {
    if (JSON.stringify(before) !== JSON.stringify(await readJson(policyPath(file)))) throw new ConfigError('回复授权发生了变化，请重试。');
    await atomicJson(policyPath(file), { ...before, enabled: false });
  });
  prompts.out('远程回复已禁用。正在进行的操作无法撤回，桥接会在下次检查时退出。');
  return true;
}
