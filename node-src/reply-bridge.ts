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
import { CONNECTION_RESET_RETRY_DELAYS, saveBridgeFailure, safeFailureReason, TelegramConnectionResetError, isBridgeDiagnosticStage, type BridgeDiagnosticStage } from './notification-diagnostics.js';
/** 两种初始化查询合计的 reset 重试上限。 */
export const INIT_RESET_RETRIES = 3;
import { UI_ERROR_CODES, isBridgeFailureKey, type BridgeFailureKey } from './error-codes.js';

export interface BridgeProblem { key: BridgeFailureKey; stage: BridgeDiagnosticStage }
function problemAt(stage: BridgeDiagnosticStage, error?: unknown): BridgeProblem {
  const key: BridgeFailureKey = error instanceof TelegramConnectionResetError ? 'bridge.failureReset'
    : stage === 'spawn' || stage === 'spawn-error' || stage === 'runtime-paths' ? 'bridge.startSpawnFailed'
    : stage === 'wait-timeout' ? 'bridge.startTimedOut'
    : stage === 'existing-unready' ? 'bridge.existingUnready'
    : stage === 'child-exit' || stage === 'worker-error' ? 'bridge.startExited'
    : ['getWebhookInfo', 'getMe', 'initial-getUpdates'].includes(stage) ? 'bridge.failureInit' : 'bridge.failureOther';
  return { key, stage };
}
function leaseProblem(value: unknown): BridgeProblem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const problem = value as BridgeProblem;
  return isBridgeFailureKey(problem.key) && isBridgeDiagnosticStage(problem.stage)
    ? { key: problem.key, stage: problem.stage } : undefined;
}

interface BridgeAttempt {
  started: number; stage: BridgeDiagnosticStage;
  failure?: { stage: BridgeDiagnosticStage; reason: string };
  problem?: BridgeProblem;
}
async function recordFailure(file: string, source: 'start' | 'worker', attempt: BridgeAttempt, error?: unknown): Promise<void> {
  const failure = attempt.failure;
  await saveBridgeFailure(file, source, { version: 1, updated: Date.now(), pid: process.pid,
    stage: failure?.stage ?? attempt.stage, elapsedMs: Math.max(0, Math.round(performance.now() - attempt.started)),
    outcome: source === 'worker' || error !== undefined || ['spawn-error', 'child-exit', 'worker-error'].includes(attempt.stage) ? 'failed' : 'unconfirmed',
    ...(failure ? { reason: failure.reason } : error !== undefined ? { reason: safeFailureReason(error) } : {}),
    errorCode: UI_ERROR_CODES[(attempt.problem ?? problemAt(failure?.stage ?? attempt.stage, error)).key],
  }).catch(() => {}); // 诊断写入失败不能改变启动结果或触发重试。
}

interface Lease { pid: number; owner: string; ready: boolean; updated: number; error?: string;
  identity?: string; botUsername?: string; problem?: BridgeProblem }
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
export async function bridgeStatus(file: string): Promise<{ running: boolean; ready: boolean; error?: string; problem?: BridgeProblem }> {
  const lease = await readJson(leasePath(file)) as Lease | null;
  const status = statusOf(lease), problem = !status.ready && lease?.error ? leaseProblem(lease.problem) : undefined;
  return { ...status, ...(problem ? { problem } : {}) };
}
export async function bridgeBotUsername(file: string, identity: string): Promise<string | null> {
  const lease = await readJson(leasePath(file)) as Lease | null;
  // 仅复用当前授权下、同一活跃租约的初始化结果；旧租约不提供兜底身份。
  if (!lease || !statusOf(lease).ready || lease.identity !== identity || !/^[a-f0-9]{32}$/.test(lease.owner)
    || typeof lease.botUsername !== 'string' || !/^[A-Za-z0-9_]{5,64}$/.test(lease.botUsername)) return null;
  if ((await readJson(controlPath(file)))?.owner === lease.owner) return null;
  const current = await readJson(leasePath(file)) as Lease | null;
  if (!current || current.owner !== lease.owner || current.identity !== identity
    || current.botUsername !== lease.botUsername || !statusOf(current).ready) return null;
  return lease.botUsername;
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
  onFailure?: (problem: BridgeProblem) => void;
}
export async function startBridge(file: string, env: Env = process.env, deps: BridgeStartDependencies = {}): Promise<boolean> {
  const attempt: BridgeAttempt = { started: performance.now(), stage: 'authorization' };
  try {
    const ready = await startBridgeAttempt(file, env, deps, attempt);
    if (!ready) {
      await recordFailure(file, 'start', attempt);
      try { deps.onFailure?.(attempt.problem ?? problemAt(attempt.stage)); }
      catch { /* 展示失败不改变原启动结果或触发新请求。 */ }
    }
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
      // 只采用本次子进程的新租约，不拿历史 worker 失败冒充当前启动原因。
      if (lease && lease.pid === child.pid && lease.owner !== previous?.owner && lease.error) attempt.problem = leaseProblem(lease.problem);
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
    let initializationRetries = 0;
    const initialize = async (method: 'getWebhookInfo' | 'getMe'): Promise<any> => {
      for (let retry = 0; ; retry++) {
        try { return await api(method, {}); }
        catch (error) {
          // 只读初始化查询：明确 reset 时每个方法最多 2 次、两方法合计最多 3 次延迟重试（最坏耗时仍在父进程 15 秒等待内）；
          // 不重发通知、不重新消费更新或提交输入。
          if (!(error instanceof TelegramConnectionResetError) || retry >= CONNECTION_RESET_RETRY_DELAYS.length
            || initializationRetries >= INIT_RESET_RETRIES) throw error;
          initializationRetries++;
          await recordFailure(file, 'worker', attempt, error);
          log(t('reply.initConnectionReset'));
          await (options.sleep ?? delay)(CONNECTION_RESET_RETRY_DELAYS[retry]);
          const after = await fresh();
          if (!after || after.identity !== access.identity || await isStopped() || heartbeatFailed) throw error;
        }
      }
    };
    attempt.stage = 'getWebhookInfo';
    const webhook = await initialize('getWebhookInfo');
    if (webhook?.url) throw new ConfigError(t('reply.webhookConflict'));
    attempt.stage = 'getMe';
    const bot = await initialize('getMe');
    if (typeof bot?.username === 'string' && /^[A-Za-z0-9_]{5,64}$/.test(bot.username)) {
      lease.identity = access.identity; lease.botUsername = bot.username;
    }
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
    attempt.problem = problemAt(attempt.stage, error);
    stopHeartbeat();
    lease.ready = false; lease.error = error instanceof ConfigError ? error.message : t('reply.bridgeFailed');
    lease.problem = attempt.problem;
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
