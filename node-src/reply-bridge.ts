import { spawn } from 'node:child_process';
import { mkdir, open, unlink, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { appPaths, ConfigError, readConfigLanguage, type Env } from './config.js';
import { resolveLocale, setLocale, t } from './i18n.js';
import { accessReplies, atomicJson, readJson, replyDirectory, stateTransaction, type ReplyAccess } from './reply-state.js';
import { telegramApi, type TelegramApi } from './reply-telegram.js';
import { drainReplies, processUpdate } from './reply-engine.js';
import { drainInteractionFeedback } from './reply-outcomes.js';

interface Lease { pid: number; owner: string; ready: boolean; updated: number; error?: string }
const leasePath = (file: string) => path.join(replyDirectory(file), 'bridge.json');
const controlPath = (file: string) => path.join(replyDirectory(file), 'stop.json');
function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
export async function bridgeStatus(file: string): Promise<{ running: boolean; ready: boolean; error?: string }> {
  const lease = await readJson(leasePath(file)) as Lease | null;
  const running = !!lease && alive(lease.pid) && Date.now() - lease.updated < 30000;
  return { running, ready: !!lease?.ready && running, error: lease?.error };
}
export async function stopBridge(file: string): Promise<boolean> {
  const lease = await readJson(leasePath(file)) as Lease | null;
  if (!lease || !alive(lease.pid)) return true;
  // 不按可复用 PID 杀进程；只有持有本次 owner 的桥接响应此控制文件。
  await atomicJson(controlPath(file), { owner: lease.owner });
  for (let attempt = 0; attempt < 16; attempt++) {
    await delay(250);
    const current = await readJson(leasePath(file)) as Lease | null;
    if (!current || current.owner !== lease.owner || !alive(current.pid)) return true;
  }
  return false;
}
export async function startBridge(file: string, env: Env = process.env): Promise<boolean> {
  const access = await accessReplies(file, env);
  if (!access) throw new ConfigError(t('reply.bridgeAuthFirst'));
  const existing = await bridgeStatus(file);
  if (existing.running) return existing.ready;
  const node = await realpath(process.execPath), cli = await realpath(fileURLToPath(new URL('./cli.js', import.meta.url)));
  // 无 shell、无命令行秘密、无系统开机自启；worker 自己持有排他锁。
  const child = spawn(node, [cli, 'reply', 'run', '--config', path.resolve(file)], {
    detached: true, windowsHide: true, shell: false, stdio: 'ignore', env: { ...process.env, ...env },
  });
  let failed = false; child.once('error', () => { failed = true; }); child.unref();
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(150);
    if (failed) return false;
    const status = await bridgeStatus(file);
    if (status.ready) return true;
    if (status.error) return false;
  }
  return false;
}
export interface BridgeOptions {
  env?: Env;
  lang?: string;
  api?: (access: ReplyAccess) => TelegramApi;
  sleep?: (ms: number) => Promise<unknown>;
  stopped?: () => boolean;
  maxIterations?: number;
  validate?: Parameters<typeof processUpdate>[2]['validate'];
  inject?: Parameters<typeof processUpdate>[2]['inject'];
  log?: (text: string) => void;
}
export async function runBridge(file: string, options: BridgeOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  let access = await accessReplies(file, env);
  if (!access) throw new ConfigError(t('reply.bridgeNotAuthorized'));
  const directory = replyDirectory(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const botDirectory = path.join(appPaths(process.platform, env).data, 'reply-bots');
  await mkdir(botDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(botDirectory, access.policy.bot + '.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new ConfigError(t('reply.bridgeLocked')); }
  const owner = randomBytes(16).toString('hex'), lease: Lease = { pid: process.pid, owner, ready: false, updated: Date.now() };
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const fresh = async () => await isStopped() ? null : accessReplies(file, env);
  const log = options.log ?? (() => {});
  let lastActivity = Date.now();
  const isStopped = async () => stopping || options.stopped?.() === true || (await readJson(controlPath(file)))?.owner === owner;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, owner }));
    await atomicJson(leasePath(file), lease);
    let api = (options.api ?? (value => telegramApi(value.config.telegram.token)))(access);
    const webhook = await api('getWebhookInfo', {});
    if (webhook?.url) throw new ConfigError(t('reply.webhookConflict'));
    await api('getMe', {});
    const currentState = await stateTransaction(access, state => ({ offset: state.offset, empty: Object.keys(state.entries).length === 0 }));
    if (!currentState.offset && currentState.empty) {
      const old = await api('getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message', 'callback_query'] });
      if (Array.isArray(old) && old.length) await stateTransaction(access, state => {
        const id = old[old.length - 1]?.update_id;
        if (Number.isSafeInteger(id)) state.offset = Math.max(state.offset, id + 1);
      });
    }
    lease.ready = true; lease.updated = Date.now(); await atomicJson(leasePath(file), lease);
    let iteration = 0, failures = 0;
    while (!await isStopped() && iteration++ < (options.maxIterations ?? Infinity)) {
      // 桥接是长驻进程，语言切换后要跟着配置文件走；否则后续消息会和 hook 进程的语言不一致。
      setLocale(resolveLocale(options.lang, env, await readConfigLanguage(file)));
      const current = await fresh();
      if (!current) break;
      if (current.identity !== access.identity) {
        // 修改授权或 Bot 必须重启并重新核验，丢弃旧长轮询结果。
        break;
      }
      access = current; api = (options.api ?? (value => telegramApi(value.config.telegram.token)))(access);
      const context = { api, fresh, validate: options.validate, inject: options.inject };
      await drainReplies(access, context);
      await drainInteractionFeedback(access, api, fresh, log);
      if (await isStopped()) break;
      const offset = await stateTransaction(access, state => state.offset);
      let updates;
      try { updates = await api('getUpdates', { offset, timeout: 2, allowed_updates: ['message', 'callback_query'] }); }
      catch (error) {
        if (error instanceof ConfigError && /冲突|conflict/i.test(error.message)) throw error;
        log(t('reply.pollFailedLog'));
        if (++failures >= 5) throw new ConfigError(t('reply.pollFailedFatal'));
        lease.updated = Date.now(); await atomicJson(leasePath(file), lease);
        await (options.sleep ?? delay)(3000); continue;
      }
      failures = 0;
      const after = await fresh();
      if (!after || after.identity !== access.identity || await isStopped()) break;
      if (!Array.isArray(updates)) throw new ConfigError(t('reply.updatesInvalid'));
      for (const update of updates) {
        if (await isStopped()) break;
        try { await processUpdate(access, update, context); }
        catch { log(t('reply.handleFailedLog')); }
      }
      if (updates.length) lastActivity = Date.now();
      lease.updated = Date.now(); await atomicJson(leasePath(file), lease);
      if (Date.now() - lastActivity > 24 * 60 * 60 * 1000) break;
    }
  } catch (error) {
    lease.ready = false; lease.error = error instanceof ConfigError ? error.message : t('reply.bridgeFailed');
    await atomicJson(leasePath(file), lease).catch(() => {});
    throw error;
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    const current = await readJson(leasePath(file)).catch(() => null);
    if (current?.owner === owner && !lease.error) await unlink(leasePath(file)).catch(() => {});
    await lock.close(); await unlink(lockPath);
  }
}
