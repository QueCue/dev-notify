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
    throw new ConfigError('无法读取回复配置或状态；未覆盖、未启用远程输入');
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
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConfigError('无法获取回复状态写入锁');
      if (attempt === 99) throw new ConfigError('回复状态锁繁忙；确认进程已退出后才能处理残留锁');
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
    throw new ConfigError('回复授权配置无效，拒绝远程输入');
  }
  if (!await replyHooksReady(file, { env })) throw new ConfigError('回复所需 hooks 缺失、异步时序不安全或已禁用；请先重新运行 integration claude-code install 并在 /hooks 确认加载');
  const config = await loadConfig(file, true, env);
  if (!ready(config, 'telegram') || botKey(config) !== policy.bot) throw new ConfigError('Telegram Bot 已变更或不可用，请重新运行 reply setup 授权');
  const users = policy.users.filter((id: string) => config.telegram.chatIds.includes(id));
  if (!users.length) throw new ConfigError('回复授权用户不在当前 Telegram 接收名单中，拒绝远程输入');
  const effective = { ...policy, users } as ReplyPolicy;
  return { file, config, policy: effective, identity: digest(JSON.stringify([policy.bot, policy.generation, users, policy.permissions === true])) };
}
export async function stateTransaction<T>(access: ReplyAccess, work: (state: ReplyState) => Promise<T> | T): Promise<T> {
  const directory = replyDirectory(access.file);
  return locked(path.join(directory, 'state.lock'), async () => {
    const policy = await readJson(policyPath(access.file));
    if (!policy?.enabled || policy.bot !== access.policy.bot || policy.generation !== access.policy.generation
      || (policy.permissions === true) !== (access.policy.permissions === true)) throw new ConfigError('回复授权已撤销或变化，拒绝写入旧状态');
    let state = await readJson(path.join(directory, 'state.json')) as ReplyState | null;
    if (!state || state.identity !== access.identity) state = { version: 1, identity: access.identity, offset: 0, sessions: {}, entries: {}, pending: {}, requests: {}, calls: {} };
    const record = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
    state.requests ??= {};
    state.calls ??= {};
    if (state.version !== 1 || !Number.isSafeInteger(state.offset) || state.offset < 0
      || ![state.sessions, state.entries, state.pending, state.requests, state.calls].every(record)) throw new ConfigError('回复状态结构无效，拒绝远程输入');
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
  if (!await replyHooksReady(file, { env })) throw new ConfigError('请先运行 integration claude-code install 安装绑定此通知配置的本版完整 hooks，再配置回复');
  const config = await loadConfig(file, true, env);
  if (!ready(config, 'telegram')) throw new ConfigError('回复 Claude 需要先配置 Telegram Bot 和私聊接收人');
  const available = config.telegram.chatIds.filter(id => /^[1-9][0-9]*$/.test(id));
  if (!available.length) throw new ConfigError('远程回复只允许 Telegram 私聊用户，不支持群聊');
  const before = await readJson(policyPath(file));
  prompts.out('远程回复等同向本机 Claude Code 终端输入并提交内容；不会自动批准工具权限，但可提交 Claude 命令。只授权可信用户。');
  prompts.out('飞书按钮跳转 Telegram；不直接接收飞书消息。需要独占 Bot 的 getUpdates：不得与旧 Python 桥接或另一台机器共用同一个 Bot。');
  prompts.out('Windows 使用系统 PowerShell / 控制台 API；macOS 使用 Ghostty 或 tmux，需要相应系统权限。不依赖 Python。');
  prompts.out('支持范围不含 VS Code 集成终端、WSL、SSH；不确定目标或会话已切换时拒绝输入。');
  prompts.out('通知接收人不会自动获得输入权限。当前可选择的私聊 chat_id：' + available.join('、'));
  const text = await prompts.text('输入本次明确授权的私聊 chat_id（逗号分隔，留空取消）：');
  if (!text.trim()) return false;
  const users = [...new Set(text.split(',').map(id => id.trim()))];
  if (users.some(id => !available.includes(id))) throw new ConfigError('只能授权当前通知名单中的明确私聊用户');
  prompts.out('将授权以下用户远程输入：' + users.join('、'));
  prompts.out('结构化问题将展示真实选项并允许自定义回答；普通回复只在本轮结束后输入。问题/选项及可选的工具请求参数可能含敏感信息，将发送到授权私聊和已配置的飞书渠道。');
  const permissions = /^(y|yes)$/i.test(await prompts.text('是否另外允许这些用户逐次点击批准/拒绝工具权限？不修改永久规则。[y/N] '));
  if (!/^(y|yes)$/i.test(await prompts.text('确认启用远程回复并接受上述权限范围？[y/N] '))) return false;
  await locked(policyPath(file) + '.lock', async () => {
    if (JSON.stringify(before) !== JSON.stringify(await readJson(policyPath(file)))) throw new ConfigError('回复授权已被其他进程修改，请重试');
    const effective = await loadConfig(file, true, env);
    if (botKey(effective) !== botKey(config) || users.some(id => !effective.telegram.chatIds.includes(id))) throw new ConfigError('通知配置在授权期间已变化，请重试');
    await atomicJson(policyPath(file), { version: 1, enabled: true, bot: botKey(config), users, permissions, generation: randomBytes(16).toString('hex') } satisfies ReplyPolicy);
  });
  prompts.out('回复授权已保存；旧消息映射不继承。新回复需从启用后的任务完成通知进入。');
  return true;
}
export async function disableReplies(file: string, prompts: Prompts): Promise<boolean> {
  const before = await readJson(policyPath(file));
  if (!before?.enabled) { prompts.out('远程回复未启用。'); return true; }
  if (!/^(y|yes)$/i.test(await prompts.text('确认禁用远程回复？通知和凭据保持不变。[y/N] '))) return false;
  await locked(policyPath(file) + '.lock', async () => {
    if (JSON.stringify(before) !== JSON.stringify(await readJson(policyPath(file)))) throw new ConfigError('回复授权已变化，请重试');
    await atomicJson(policyPath(file), { ...before, enabled: false });
  });
  prompts.out('远程回复已禁用；正在进行中的注入不能撤回，桥接下次检查授权时退出。');
  return true;
}
