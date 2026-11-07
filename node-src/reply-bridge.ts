import { spawn } from 'node:child_process';
import { mkdir, unlink, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { appPaths, ConfigError, readConfigLanguage, type Env } from './config.js';
import { resolveLocale, setLocale, t } from './i18n.js';
import { accessReplies, atomicJson, readJson, replyDirectory, stateTransaction, type ReplyAccess } from './reply-state.js';
import { telegramApi, type TelegramApi } from './reply-telegram.js';
import { acquireBotLock, processState } from './reply-lock.js';
import { drainReplies, processUpdate } from './reply-engine.js';
import { drainInteractionFeedback } from './reply-outcomes.js';
import { saveBridgeFailure, safeFailureReason, TelegramConnectionResetError, type BridgeDiagnosticStage } from './notification-diagnostics.js';

interface BridgeAttempt {
  started: number; stage: BridgeDiagnosticStage;
  failure?: { stage: BridgeDiagnosticStage; reason: string };
}
async function recordFailure(file: string, source: 'start' | 'worker', attempt: BridgeAttempt, error?: unknown): Promise<void> {
  const failure = attempt.failure;
  await saveBridgeFailure(file, source, { version: 1, updated: Date.now(), pid: process.pid,
    stage: failure?.stage ?? attempt.stage, elapsedMs: Math.max(0, Math.round(performance.now() - attempt.started)),
    outcome: source === 'worker' || error !== undefined || ['spawn-error', 'child-exit', 'worker-error'].includes(attempt.stage) ? 'failed' : 'unconfirmed',
    ...(failure ? { reason: failure.reason } : error !== undefined ? { reason: safeFailureReason(error) } : {}),
  }).catch(() => {}); // 诊断写入失败不能改变启动结果或触发重试。
}

interface Lease { pid: number; owner: string; ready: boolean; updated: number; error?: string }
const leasePath = (file: string) => path.join(replyDirectory(file), 'bridge.json');
const controlPath = (file: string) => path.join(replyDirectory(file), 'stop.json');
function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  // 权限不足不能当作已退出，否则升级维护可能提前启动第二个消费者。
  return processState(Number(pid)) !== 'dead';
}
function statusOf(lease: Lease | null): { running: boolean; ready: boolean; error?: string } {
  const running = !!lease && alive(lease.pid);
  const fresh = !!lease && Number.isFinite(lease.updated) && Date.now() - lease.updated < 30000 && lease.updated <= Date.now() + 10000;
  return { running, ready: lease?.ready === true && running && fresh && !lease.error && processState(lease.pid) === 'alive', error: lease?.error };
}
export async function bridgeStatus(file: string): Promise<{ running: boolean; ready: boolean; error?: string }> {
  return statusOf(await readJson(leasePath(file)) as Lease | null);
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
export interface BridgeStartDependencies {
  spawn?: typeof spawn;
  sleep?: (ms: number) => Promise<unknown>;
}
export async function startBridge(file: string, env: Env = process.env, deps: BridgeStartDependencies = {}): Promise<boolean> {
  const attempt: BridgeAttempt = { started: performance.now(), stage: 'authorization' };
  try {
    const ready = await startBridgeAttempt(file, env, deps, attempt);
    if (!ready) await recordFailure(file, 'start', attempt);
    return ready;
  } catch (error) { await recordFailure(file, 'start', attempt, error); throw error; }
}
async function startBridgeAttempt(file: string, env: Env, deps: BridgeStartDependencies, attempt: BridgeAttempt): Promise<boolean> {
  const access = await accessReplies(file, env);
  if (!access) throw new ConfigError(t('reply.bridgeAuthFirst'));
  attempt.stage = 'lease-read';
  const previous = await readJson(leasePath(file)) as Lease | null;
  const existing = statusOf(previous);
  if (existing.running) { if (!existing.ready) attempt.stage = 'existing-unready'; return existing.ready; }
  attempt.stage = 'runtime-paths';
  const node = await realpath(process.execPath), cli = await realpath(fileURLToPath(new URL('./cli.js', import.meta.url)));
  // 无 shell、无命令行秘密、无系统开机自启；worker 自己持有排他锁。
  attempt.stage = 'spawn';
  const child = (deps.spawn ?? spawn)(node, [cli, 'reply', 'run', '--config', path.resolve(file)], {
    detached: true, windowsHide: true, shell: false, stdio: 'ignore', env: { ...process.env, ...env },
  });
  let failed = false, exited = false;
  child.once('error', () => { failed = true; });
  child.once('exit', () => { exited = true; });
  child.unref();
  attempt.stage = 'wait-ready';
  // 实际网络启动可能超过3秒；只等待有界15秒，不因旧进程留下的error提前放弃。
  for (let waitAttempt = 0; waitAttempt < 100; waitAttempt++) {
    await (deps.sleep ?? delay)(150);
    const lease = await readJson(leasePath(file)) as Lease | null;
    if (statusOf(lease).ready) return true;
    if (failed || exited || lease?.pid === child.pid && lease?.owner !== previous?.owner && lease?.error) {
      attempt.stage = failed ? 'spawn-error' : exited ? 'child-exit' : 'worker-error';
      return false;
    }
  }
  attempt.stage = 'wait-timeout';
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
  /** 测试用心跳间隔；正常运行默认5秒。 */
  heartbeatMs?: number;
}
export async function runBridge(file: string, options: BridgeOptions = {}): Promise<void> {
  const attempt: BridgeAttempt = { started: performance.now(), stage: 'authorization' };
  try { await runBridgeAttempt(file, options, attempt); }
  catch (error) { await recordFailure(file, 'worker', attempt, error); throw error; }
}
async function runBridgeAttempt(file: string, options: BridgeOptions, attempt: BridgeAttempt): Promise<void> {
  const env = options.env ?? process.env;
  const initialAccess = await accessReplies(file, env);
  if (!initialAccess) throw new ConfigError(t('reply.bridgeNotAuthorized'));
  let access: ReplyAccess = initialAccess;
  const heartbeatMs = options.heartbeatMs ?? 5000;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 10000) throw new ConfigError(t('reply.bridgeFailed'));
  attempt.stage = 'storage';
  const directory = replyDirectory(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const botDirectory = path.join(appPaths(process.platform, env).data, 'reply-bots');
  await mkdir(botDirectory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(botDirectory, access.policy.bot + '.lock');
  const owner = randomBytes(16).toString('hex');
  attempt.stage = 'bot-lock';
  const lock = await acquireBotLock(lockPath, owner);
  const lease: Lease = { pid: process.pid, owner, ready: false, updated: Date.now() };
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const fresh = async () => await isStopped() ? null : accessReplies(file, env);
  const log = options.log ?? (() => {});
  let lastActivity = Date.now();
  const isStopped = async () => stopping || options.stopped?.() === true || (await readJson(controlPath(file)))?.owner === owner;
  let writes = Promise.resolve();
  const saveLease = () => {
    lease.updated = Date.now();
    const snapshot = { ...lease };
    const next = writes.then(() => atomicJson(leasePath(file), snapshot));
    writes = next.catch(() => {});
    return next;
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let beating = false, heartbeatFailed = false;
  const stopHeartbeat = () => { stopping = true; if (heartbeat) clearInterval(heartbeat); };
  try {
    attempt.stage = 'lease-write';
    await saveLease();
    heartbeat = setInterval(() => {
      if (beating || stopping) return;
      beating = true;
      void saveLease().catch(() => { heartbeatFailed = true; stopping = true; }).finally(() => { beating = false; });
    }, heartbeatMs);
    heartbeat.unref();
    let api = (options.api ?? (value => telegramApi(value.config.telegram.token)))(access);
    let retriedInitialization = false;
    const initialize = async (method: 'getWebhookInfo' | 'getMe'): Promise<any> => {
      try { return await api(method, {}); }
      catch (error) {
        // 仅本次初始化共用一次重试额度，不重发通知、不重新消费更新或提交输入。
        if (!(error instanceof TelegramConnectionResetError) || retriedInitialization) throw error;
        retriedInitialization = true;
        await recordFailure(file, 'worker', attempt, error);
        log(t('reply.initConnectionReset'));
        await (options.sleep ?? delay)(500);
        const after = await fresh();
        if (!after || after.identity !== access.identity || await isStopped() || heartbeatFailed) throw error;
        return await api(method, {});
      }
    };
    attempt.stage = 'getWebhookInfo';
    const webhook = await initialize('getWebhookInfo');
    if (webhook?.url) throw new ConfigError(t('reply.webhookConflict'));
    attempt.stage = 'getMe';
    await initialize('getMe');
    attempt.stage = 'state-read';
    const currentState = await stateTransaction(access, state => ({ offset: state.offset, empty: Object.keys(state.entries).length === 0 }));
    if (!currentState.offset && currentState.empty) {
      attempt.stage = 'initial-getUpdates';
      const old = await api('getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message', 'callback_query'] });
      if (Array.isArray(old) && old.length) {
        attempt.stage = 'state-write';
        await stateTransaction(access, state => {
          const id = old[old.length - 1]?.update_id;
          if (Number.isSafeInteger(id)) state.offset = Math.max(state.offset, id + 1);
        });
      }
    }
    attempt.stage = 'ready';
    lease.ready = true; await saveLease();
    attempt.stage = 'polling';
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
        await saveLease();
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
      await saveLease();
      if (Date.now() - lastActivity > 24 * 60 * 60 * 1000) break;
    }
    if (heartbeatFailed) throw new ConfigError(t('reply.bridgeFailed'));
  } catch (error) {
    attempt.failure = { stage: attempt.stage, reason: safeFailureReason(error) };
    stopHeartbeat();
    lease.ready = false; lease.error = error instanceof ConfigError ? error.message : t('reply.bridgeFailed');
    await saveLease().catch(() => {});
    throw error;
  } finally {
    attempt.stage = 'cleanup';
    stopHeartbeat();
    await writes;
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    try {
      const current = await readJson(leasePath(file)).catch(() => null);
      if (current?.owner === owner && !lease.error) await unlink(leasePath(file)).catch(() => {});
    } finally { await lock.release(); }
  }
}
