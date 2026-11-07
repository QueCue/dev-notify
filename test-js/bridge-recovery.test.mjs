import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireBotLock, processState } from '../dist/reply-lock.js';
import { bridgeStatus, startBridge, runBridge } from '../dist/reply-bridge.js';
import { atomicJson, policyPath, replyDirectory, botKey, accessReplies, stateTransaction } from '../dist/reply-state.js';
import { configureClaudeCode } from '../dist/claude-code.js';
import { parseConfig, appPaths } from '../dist/config.js';
import { TransportError } from '../dist/channels.js';

globalThis.fetch = async () => assert.fail('测试禁止真实网络');
const OWNER = 'a'.repeat(32), OLD = 'b'.repeat(32);
const departed = spawnSync(process.execPath, ['-e', ''], { timeout: 10000 }).pid;
async function temp(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-bridge-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, lock: path.join(root, 'bot.lock') };
}
async function fixture(t) {
  const { root } = await temp(t);
  const file = path.join(root, 'config.json');
  const env = { DEV_NOTIFY_HOME: path.join(root, 'app'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    TELEGRAM_BOT_TOKEN: '123:FAKE_ONLY', FEISHU_WEBHOOK: '', FEISHU_SECRET: '' };
  const config = { version: 1, telegram: { enabled: true, chat_ids: ['111'] }, feishu: { enabled: false } };
  await atomicJson(file, config);
  await configureClaudeCode(file, 'install', { out() {}, text: async () => 'y', secret: async () => assert.fail('不读取秘密') }, { env });
  await atomicJson(policyPath(file), { version: 1, enabled: true, users: ['111'], permissions: false,
    bot: botKey(parseConfig(config, env)), generation: 'c'.repeat(32) });
  const access = await accessReplies(file, env);
  await stateTransaction(access, state => { state.offset = 10; });
  return { root, file, env, lease: path.join(replyDirectory(file), 'bridge.json') };
}

test('正常探测和ESRCH不依赖Windows回退，无效PID不执行探测', () => {
  const options = { platform: 'win32', windowsQuery: () => assert.fail('不应执行回退') };
  assert.equal(processState(123, { ...options, signal: () => true }), 'alive');
  assert.equal(processState(123, { ...options, signal: () => { throw Object.assign(new Error(), { code: 'ESRCH' }); } }), 'dead');
  for (const pid of [0, -1, NaN, Infinity, 1.5]) assert.equal(processState(pid, { signal: () => assert.fail('非法PID') }), 'unknown');
});
for (const code of ['EPERM', 'EACCES']) for (const found of [true, false])
test(`Windows ${code} 只读PID枚举${found ? '确认存活' : '无结果仍未知'}`, () => {
  let queries = 0;
  assert.equal(processState(123, { platform: 'win32', signal: () => { throw Object.assign(new Error('PRIVATE'), { code }); },
    windowsQuery: pid => { assert.equal(pid, 123); queries++; return found; } }), found ? 'alive' : 'unknown');
  assert.equal(queries, 1);
});
test('非Windows权限不足不调用Windows程序，也不推断死亡', () => {
  assert.equal(processState(123, { platform: 'darwin', signal: () => { throw Object.assign(new Error(), { code: 'EPERM' }); },
    windowsQuery: () => assert.fail('不得调用Windows程序') }), 'unknown');
});
test('Windows只读查询异常仍未知，不将故障当死亡', () => {
  assert.equal(processState(123, { platform: 'win32', signal: () => { throw Object.assign(new Error(), { code: 'EPERM' }); },
    windowsQuery: () => { throw new Error('PRIVATE'); } }), 'unknown');
});
test('Windows实际tasklist只读回退让权限受限观察者识别就绪桥接且不新起消费者', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await atomicJson(f.lease, { pid: process.pid, owner: OWNER, ready: true, updated: Date.now() });
  const original = process.kill;
  process.kill = (pid, signal) => {
    if (pid === process.pid && signal === 0) throw Object.assign(new Error('模拟跨提权等级拒绝'), { code: 'EPERM' });
    return original(pid, signal);
  };
  try {
    assert.equal(processState(process.pid), 'alive');
    assert.deepEqual(await bridgeStatus(f.file), { running: true, ready: true, error: undefined });
    assert.equal(await startBridge(f.file, f.env, { spawn: () => assert.fail('不能启动第二个消费者') }), true);
  } finally { process.kill = original; }
});

test('Bot锁正常持有与幂等释放，不删除别人的新owner', async t => {
  const f = await temp(t);
  const lock = await acquireBotLock(f.lock, OWNER);
  assert.equal(JSON.parse(await readFile(f.lock, 'utf8')).owner, OWNER);
  await writeFile(f.lock, JSON.stringify({ pid: process.pid, owner: OLD }));
  await lock.release(); await lock.release();
  assert.equal(JSON.parse(await readFile(f.lock, 'utf8')).owner, OLD);
});
test('确认死亡的有效Bot锁自动回收，清理恢复门闩', async t => {
  const f = await temp(t);
  await writeFile(f.lock, JSON.stringify({ pid: departed, owner: OLD }));
  const lock = await acquireBotLock(f.lock, OWNER);
  try {
    assert.equal(JSON.parse(await readFile(f.lock, 'utf8')).pid, process.pid);
    await assert.rejects(readFile(f.lock + '.recover'), { code: 'ENOENT' });
  } finally { await lock.release(); }
  await assert.rejects(readFile(f.lock), { code: 'ENOENT' });
});
for (const state of ['alive', 'unknown']) {
  test(`PID${state}（包含复用/权限未知）不能抢锁`, async t => {
    const f = await temp(t), original = JSON.stringify({ pid: departed, owner: OLD });
    await writeFile(f.lock, original);
    await assert.rejects(acquireBotLock(f.lock, OWNER, () => state), /同一个 Bot/);
    assert.equal(await readFile(f.lock, 'utf8'), original);
  });
}
test('坏锁和残留恢复门闩保守拒绝，不猜测删除', async t => {
  const f = await temp(t);
  await writeFile(f.lock, 'invalid-owner');
  await assert.rejects(acquireBotLock(f.lock, OWNER), /同一个 Bot/);
  assert.equal(await readFile(f.lock, 'utf8'), 'invalid-owner');
  await writeFile(f.lock, JSON.stringify({ pid: departed, owner: OLD }));
  await writeFile(f.lock + '.recover', 'existing-recovery');
  await assert.rejects(acquireBotLock(f.lock, OWNER), /同一个 Bot/);
  assert.equal(await readFile(f.lock + '.recover', 'utf8'), 'existing-recovery');
});
test('两个恢复者竞争死亡Bot锁，只能有一个持有者', async t => {
  const f = await temp(t);
  await writeFile(f.lock, JSON.stringify({ pid: departed, owner: OLD }));
  const results = await Promise.allSettled([acquireBotLock(f.lock, OWNER), acquireBotLock(f.lock, 'd'.repeat(32))]);
  const successful = results.filter(r => r.status === 'fulfilled');
  assert.equal(successful.length, 1);
  await successful[0].value.release();
});
test('真实隔离子进程被强杀后，下一实例可以恢复Bot锁', { timeout: 10000 }, async t => {
  const f = await temp(t);
  const module = new URL('../dist/reply-lock.js', import.meta.url).href;
  const script = `import { acquireBotLock } from ${JSON.stringify(module)}; await acquireBotLock(process.argv[1], ${JSON.stringify(OLD)}); console.log('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.lock], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  await once(child.stdout, 'data');
  child.kill('SIGKILL');
  await exited;
  assert.equal(processState(child.pid), 'dead');
  const lock = await acquireBotLock(f.lock, OWNER);
  await lock.release();
});
test('心跳过期只表示不健康，不能当作活进程已退出', async t => {
  const f = await fixture(t);
  await atomicJson(f.lease, { pid: process.pid, owner: OWNER, ready: true, updated: Date.now() - 60000 });
  const status = await bridgeStatus(f.file);
  assert.equal(status.running, true);
  assert.equal(status.ready, false);
});
test('上次已退出桥接的error不能让新启动过早失败，允许超过3秒的启动', async t => {
  const f = await fixture(t);
  await atomicJson(f.lease, { pid: departed, owner: OLD, ready: false, updated: Date.now(), error: 'OLD_TEST_ERROR' });
  let waits = 0;
  const child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
  const ready = await startBridge(f.file, f.env, {
    spawn: () => child,
    sleep: async () => {
      if (++waits === 25) await atomicJson(f.lease, { pid: process.pid, owner: OWNER, ready: true, updated: Date.now() });
    },
  });
  assert.equal(ready, true);
  assert.equal(waits, 25);
});
test('本次子进程明确启动失败时有界结束', async t => {
  const f = await fixture(t);
  const child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
  const ready = await startBridge(f.file, f.env, {
    spawn: () => child,
    sleep: async () => { await atomicJson(f.lease, { pid: process.pid, owner: OWNER, ready: false, updated: Date.now(), error: 'NEW_TEST_ERROR' }); },
  });
  assert.equal(ready, false);
});
for (const method of ['getWebhookInfo', 'getMe', 'initial-getUpdates'])
test(`桥接失败保留阶段 ${method}，成功恢复不覆盖`, async t => {
  const f = await fixture(t);
  if (method === 'initial-getUpdates') {
    const access = await accessReplies(f.file, f.env);
    await stateTransaction(access, state => { state.offset = 0; state.entries = {}; });
  }
  const failedMethod = method === 'initial-getUpdates' ? 'getUpdates' : method;
  await assert.rejects(runBridge(f.file, { env: f.env, maxIterations: 0, api: () => async name => {
    if (name === failedMethod) throw new TransportError('PRIVATE_ERROR https://fake.invalid/bot123');
    return name === 'getUpdates' ? [] : {};
  } }));
  const file = path.join(replyDirectory(f.file), 'bridge-failures', 'worker.json');
  const before = await readFile(file, 'utf8'), failure = JSON.parse(before);
  assert.equal(failure.stage, method); assert.equal(failure.outcome, 'failed');
  assert.ok(Number.isFinite(failure.elapsedMs) && failure.elapsedMs >= 0);
  assert.doesNotMatch(before, /PRIVATE_ERROR|fake\.invalid|bot123|123:FAKE_ONLY/);
  await runBridge(f.file, { env: f.env, maxIterations: 0, api: () => async name => name === 'getUpdates' ? [] : {} });
  assert.equal(await readFile(file, 'utf8'), before);
});
test('创建租约前的锁失败也有阶段记录且不泄露锁内容', async t => {
  const f = await fixture(t), access = await accessReplies(f.file, f.env);
  const directory = path.join(appPaths(process.platform, f.env).data, 'reply-bots');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, access.policy.bot + '.lock'), 'PRIVATE_LOCK');
  await assert.rejects(runBridge(f.file, { env: f.env }), /同一个 Bot/);
  await assert.rejects(readFile(f.lease), { code: 'ENOENT' });
  const text = await readFile(path.join(replyDirectory(f.file), 'bridge-failures', 'worker.json'), 'utf8');
  assert.equal(JSON.parse(text).stage, 'bot-lock'); assert.doesNotMatch(text, /PRIVATE_LOCK|FAKE_ONLY/);
});
test('启动等待超时记为未确认而非已退出，后续成功不删除诊断', async t => {
  const f = await fixture(t), child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
  assert.equal(await startBridge(f.file, f.env, { spawn: () => child, sleep: async () => {} }), false);
  const file = path.join(replyDirectory(f.file), 'bridge-failures', 'start.json');
  const before = await readFile(file, 'utf8'), failure = JSON.parse(before);
  assert.equal(failure.stage, 'wait-timeout'); assert.equal(failure.outcome, 'unconfirmed');
  assert.equal(await startBridge(f.file, f.env, { spawn: () => child, sleep: async () => {
    await atomicJson(f.lease, { pid: process.pid, owner: OWNER, ready: true, updated: Date.now() });
  } }), true);
  assert.equal(await readFile(file, 'utf8'), before);
});
for (const event of ['error', 'exit']) test(`子进程 ${event} 与等待超时分开记录`, async t => {
  const f = await fixture(t), child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
  assert.equal(await startBridge(f.file, f.env, { spawn: () => child, sleep: async () => {
    if (event === 'error') child.emit('error', new Error('PRIVATE_SPAWN'));
    else child.emit('exit', 1);
  } }), false);
  const text = await readFile(path.join(replyDirectory(f.file), 'bridge-failures', 'start.json'), 'utf8');
  const failure = JSON.parse(text);
  assert.equal(failure.stage, event === 'error' ? 'spawn-error' : 'child-exit');
  assert.equal(failure.outcome, 'failed'); assert.doesNotMatch(text, /PRIVATE_SPAWN/);
});
test('同步spawn异常也安全留存，不吞掉原异常', async t => {
  const f = await fixture(t);
  await assert.rejects(startBridge(f.file, f.env, { spawn: () => { throw new Error('PRIVATE_SPAWN'); } }), /PRIVATE_SPAWN/);
  const text = await readFile(path.join(replyDirectory(f.file), 'bridge-failures', 'start.json'), 'utf8');
  assert.equal(JSON.parse(text).stage, 'spawn'); assert.doesNotMatch(text, /PRIVATE_SPAWN/);
});

test('桥接诊断写入失败不覆盖原错误或触发重新启动', async t => {
  const f = await fixture(t);
  await writeFile(path.join(replyDirectory(f.file), 'bridge-failures'), '阻止创建诊断目录');
  let spawned = 0;
  await assert.rejects(startBridge(f.file, f.env, { spawn: () => { spawned++; throw new Error('ORIGINAL_FAILURE'); } }), /ORIGINAL_FAILURE/);
  assert.equal(spawned, 1);
  await assert.rejects(runBridge(f.file, { env: f.env, api: () => async () => { throw new TransportError('ORIGINAL_FAILURE'); } }), /ORIGINAL_FAILURE/);
});

test('耗时异步工作期间独立续心跳，退出后不会把已清理租约写回来', async t => {
  const f = await fixture(t);
  let advanced = false;
  await runBridge(f.file, { env: f.env, heartbeatMs: 10, maxIterations: 1, api: () => async method => {
    if (method !== 'getUpdates') return {};
    const before = JSON.parse(await readFile(f.lease, 'utf8')).updated;
    await delay(80);
    const after = JSON.parse(await readFile(f.lease, 'utf8')).updated;
    advanced = after > before;
    assert.equal((await bridgeStatus(f.file)).ready, true);
    return [];
  } });
  assert.equal(advanced, true);
  await delay(40);
  await assert.rejects(readFile(f.lease), { code: 'ENOENT' });
});
