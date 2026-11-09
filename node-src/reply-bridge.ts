import { spawn } from 'node:child_process';
import { mkdir, unlink, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { appPaths, ConfigError, readConfigLanguage, type Env } from './config.js';
import { resolveLocale, setLocale, t } from './i18n.js';
import { accessReplies, replyAccesses, channelAccess, atomicJson, readJson, replyDirectory, stateTransaction, replyChannel, digest, type ReplyAccess, type ReplyChannel } from './reply-state.js';
import { telegramApi, type TelegramApi } from './reply-telegram.js';
import { replyApi } from './reply-api.js';
import { acquireBotLock, processState } from './reply-lock.js';
import { drainReplies, drainFeishuInbox, processUpdate } from './reply-engine.js';
import { feishuClient, feishuReplyApi, enqueueFeishuMessage, type FeishuFactory } from './reply-feishu.js';
import { drainInteractionFeedback } from './reply-outcomes.js';
import { refreshFeishuReplyCards, type CardRefreshOptions } from './feishu-card-status.js';
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
  identity?: string; botUsername?: string; problem?: BridgeProblem;
  channels?: { telegram?: boolean; feishu?: boolean } }
const leasePath = (file: string) => path.join(replyDirectory(file), 'bridge.json');
const controlPath = (file: string) => path.join(replyDirectory(file), 'stop.json');
function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  // 权限不足不能当作已退出，否则升级维护可能提前启动第二个消费者。
  return processState(Number(pid)) !== 'dead';
}
function statusOf(lease: Lease | null, channel?: ReplyChannel): { running: boolean; ready: boolean; error?: string } {
  const running = !!lease && alive(lease.pid);
  const fresh = !!lease && Number.isFinite(lease.updated) && Date.now() - lease.updated < 30000 && lease.updated <= Date.now() + 10000;
  const ready = channel && lease?.channels ? lease.channels[channel] === true : lease?.ready === true
    && (!lease.channels || lease.channels.telegram === true && lease.channels.feishu === true);
  return { running, ready: !!lease && ready && running && fresh && !lease.error && processState(lease.pid) === 'alive'
    && (!lease.channels || /^[a-f0-9]{32}$/.test(lease.owner)), error: lease?.error };
}
function leaseMatches(lease: Lease | null, access: ReplyAccess): boolean {
  const dual = replyAccesses(access).length > 1;
  return !!lease && (!dual || !!lease.channels) && (lease.identity ? lease.identity === access.identity : !dual && replyChannel(access) === 'telegram');
}
function statusFor(lease: Lease | null, access?: ReplyAccess) {
  const status = statusOf(lease, access?.view);
  if (access && !leaseMatches(lease, access)) status.ready = false;
  return status;
}
async function leaseReady(file: string, lease: Lease | null, access?: ReplyAccess): Promise<boolean> {
  if (!statusFor(lease, access).ready) return false;
  if (!lease?.channels) return true;
  // 两路状态只属于这一个 owner；不能把换代租约或已经收到的停止请求当作就绪。
  if ((await readJson(controlPath(file)))?.owner === lease.owner) return false;
  const current = await readJson(leasePath(file)) as Lease | null;
  return current?.owner === lease.owner && current.pid === lease.pid && statusFor(current, access).ready;
}
export async function bridgeStatus(file: string, access?: ReplyAccess): Promise<{ running: boolean; ready: boolean; error?: string; problem?: BridgeProblem }> {
  const lease = await readJson(leasePath(file)) as Lease | null;
  const status = statusFor(lease, access);
  if (status.ready) status.ready = await leaseReady(file, lease, access);
  const problem = !status.ready && lease?.error ? leaseProblem(lease.problem) : undefined;
  return { ...status, ...(problem ? { problem } : {}) };
}
export async function bridgeBotUsername(file: string, identity: string): Promise<string | null> {
  const lease = await readJson(leasePath(file)) as Lease | null;
  // 仅复用当前授权下、同一活跃租约的初始化结果；旧租约不提供兜底身份。
  if (!lease || !statusOf(lease, 'telegram').ready || lease.identity !== identity || !/^[a-f0-9]{32}$/.test(lease.owner)
    || typeof lease.botUsername !== 'string' || !/^[A-Za-z0-9_]{5,64}$/.test(lease.botUsername)) return null;
  if ((await readJson(controlPath(file)))?.owner === lease.owner) return null;
  const current = await readJson(leasePath(file)) as Lease | null;
  if (!current || current.owner !== lease.owner || current.identity !== identity
    || current.botUsername !== lease.botUsername || !statusOf(current, 'telegram').ready) return null;
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
  const existing = statusFor(previous, access);
  if (existing.running) {
    const ready = existing.ready && await leaseReady(file, previous, access);
    if (!ready) attempt.stage = 'existing-unready';
    return ready;
  }
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
    if (lease?.pid === child.pid && lease?.owner !== previous?.owner && await leaseReady(file, lease, access)) return true;
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
  feishuFactory?: FeishuFactory;
  cardInspect?: CardRefreshOptions['inspect'];
  cardRefreshMs?: number;
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
  const views = replyAccesses(access), dual = views.length > 1;
  const lockPaths = [...new Set(views.map(view => {
    const key = replyChannel(view) === 'feishu' ? digest(JSON.stringify(['feishu', view.config.feishu.appId])) : view.policy.bot;
    return path.join(botDirectory, key + '.lock');
  }))].sort();
  const owner = randomBytes(16).toString('hex');
  const locks: Awaited<ReturnType<typeof acquireBotLock>>[] = [];
  attempt.stage = 'bot-lock';
  try { for (const lockPath of lockPaths) locks.push(await acquireBotLock(lockPath, owner)); }
  catch (error) {
    // 固定顺序拿锁，第二把失败时撤回本次已经持有的锁，不留下半个双渠道 worker。
    await Promise.allSettled(locks.reverse().map(lock => lock.release()));
    throw error;
  }
  const lease: Lease = { pid: process.pid, owner, ready: false, updated: Date.now(), identity: access.identity,
    ...(dual ? { channels: { telegram: false, feishu: false } } : {}) };
  let stopping = false, telegramReady = false, leasePublished = false;
  let client: ReturnType<typeof feishuClient> | undefined;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const isStopped = async () => {
    if (stopping || options.stopped?.() === true || (await readJson(controlPath(file)))?.owner === owner) return true;
    return dual && leasePublished && (await readJson(leasePath(file)))?.owner !== owner;
  };
  const fresh = async () => {
    if (await isStopped()) { stopping = true; return null; }
    const current = await accessReplies(file, env);
    if (!current || current.identity !== initialAccess.identity || await isStopped()) { stopping = true; return null; }
    return current;
  };
  const freshChannel = (channel: ReplyChannel) => async () => {
    const current = await fresh();
    return current ? channelAccess(current, channel) : null;
  };
  const freshTelegram = freshChannel('telegram'), freshFeishu = freshChannel('feishu');
  const log = options.log ?? (() => {});
  let lastActivity = Date.now();
  let writes = Promise.resolve();
  const saveLease = () => {
    if (dual) {
      lease.channels = { telegram: telegramReady && !stopping, feishu: client?.state === 'connected' && !stopping };
      lease.ready = lease.channels.telegram === true && lease.channels.feishu === true;
    }
    lease.updated = Date.now();
    const snapshot = { ...lease };
    const next = writes.then(async () => {
      if (dual && leasePublished && (await readJson(leasePath(file)))?.owner !== owner) { stopping = true; return; }
      await atomicJson(leasePath(file), snapshot);
      leasePublished = true;
    });
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
    const initialFeishu = channelAccess(access, 'feishu');
    let clientStart: Promise<void> | undefined, clientFailed = false;
    if (initialFeishu) {
      client = feishuClient(initialFeishu.config, {
        onMessage: async event => {
          const current = await freshFeishu();
          if (!current || stopping || await isStopped()) return;
          await enqueueFeishuMessage(current, event);
          lastActivity = Date.now();
        },
        onError: () => { log(t('feishu.failed')); },
      }, options.feishuFactory);
      attempt.stage = 'ready';
      // 同一 worker 中先启动 WS；TG 初始化期间只允许 FS view 校验并持久入队。
      clientStart = client.start();
      void clientStart.catch(() => { clientFailed = true; }); // 初始化先失败时仍由 finally 停止连接，不留下未处理拒绝。
    }
    const apiFor = (view: ReplyAccess): TelegramApi => options.api?.(view) ?? (replyChannel(view) === 'feishu'
      ? feishuReplyApi(view.config, client) : telegramApi(view.config.telegram.token));
    const refreshMs = options.cardRefreshMs ?? 10000;
    if (client && (!Number.isSafeInteger(refreshMs) || refreshMs < 10)) throw new ConfigError(t('reply.bridgeFailed'));
    let lastCardRefresh = 0;
    const refreshCards = async (view: ReplyAccess) => {
      const active = client;
      if (!active || active.state !== 'connected' || Date.now() - lastCardRefresh < refreshMs) return;
      lastCardRefresh = Date.now();
      await refreshFeishuReplyCards(view, (id, content) => active.updateMessage(id, content), {
        fresh: freshFeishu, inspect: options.cardInspect, env, log,
      }).catch(() => log(t('feishu.replyRefreshFailed')));
    };
    if (!channelAccess(access, 'telegram')) {
      const active = client!;
      await clientStart;
      lease.ready = active.state === 'connected'; await saveLease();
      const api = apiFor(initialFeishu!);
      let iteration = 0;
      while (!await isStopped() && iteration++ < (options.maxIterations ?? Infinity)) {
        setLocale(resolveLocale(options.lang, env, await readConfigLanguage(file)));
        const current = await fresh();
        if (!current) break;
        access = current;
        const view = channelAccess(access, 'feishu')!;
        lease.ready = active.state === 'connected'; await saveLease();
        if (active.state === 'failed' || active.state === 'stopped') throw new ConfigError(t('feishu.failed'));
        const context = { api, fresh, validate: options.validate, inject: options.inject };
        attempt.stage = 'polling';
        try { await drainFeishuInbox(view, { ...context, fresh: freshFeishu }); }
        catch { log(t('reply.handleFailedLog')); }
        await drainReplies(access, context);
        await drainInteractionFeedback(access, api, fresh, log);
        await refreshCards(view);
        await (options.sleep ?? delay)(250);
      }
      if (heartbeatFailed) throw new ConfigError(t('reply.bridgeFailed'));
      return;
    }
    let api = apiFor(channelAccess(access, 'telegram')!);
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
    if (!await fresh()) return;
    if (dual && (clientFailed || client?.state === 'failed' || client?.state === 'stopped')) throw new ConfigError(t('feishu.failed'));
    attempt.stage = 'ready';
    telegramReady = true;
    lease.identity = access.identity; lease.ready = true; await saveLease();
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
      access = current;
      const telegram = channelAccess(access, 'telegram')!;
      api = apiFor(telegram);
      const businessApi = dual ? replyApi(access, view => replyChannel(view) === 'telegram' ? api : apiFor(view)) : api;
      const context = { api: businessApi, fresh, validate: options.validate, inject: options.inject };
      if (dual) {
        await saveLease();
        if (clientFailed || client?.state === 'failed' || client?.state === 'stopped') throw new ConfigError(t('feishu.failed'));
        const feishu = channelAccess(access, 'feishu')!;
        try { await drainFeishuInbox(feishu, { ...context, fresh: freshFeishu }); }
        catch { log(t('reply.handleFailedLog')); }
        await refreshCards(feishu);
      }
      await drainReplies(access, context);
      await drainInteractionFeedback(access, businessApi, fresh, log);
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
        try { await processUpdate(telegram, update, { ...context, fresh: freshTelegram }); }
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
    try { client?.stop(); }
    finally {
      await writes;
      process.off('SIGTERM', stop); process.off('SIGINT', stop);
      try {
        const current = await readJson(leasePath(file)).catch(() => null);
        if (current?.owner === owner && !lease.error) await unlink(leasePath(file)).catch(() => {});
      } finally { await Promise.all(locks.reverse().map(lock => lock.release())); }
    }
  }
}
