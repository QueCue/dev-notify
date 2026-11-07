import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { UI_ERROR_CODES } from '../dist/error-codes.js';
import { t as translate, setLocale } from '../dist/i18n.js';
import { main } from '../dist/cli.js';
import { startBridge, runBridge, bridgeStatus } from '../dist/reply-bridge.js';
import { atomicJson, policyPath, replyDirectory, botKey, accessReplies, stateTransaction } from '../dist/reply-state.js';
import { configureClaudeCode } from '../dist/claude-code.js';
import { parseConfig } from '../dist/config.js';
import { TelegramConnectionResetError } from '../dist/notification-diagnostics.js';

globalThis.fetch = async () => assert.fail('禁止真实网络');
const OWNER = 'a'.repeat(32), OLD = 'b'.repeat(32);
async function fixture(test) {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-ui-codes-'));
  test.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json'), env = { DEV_NOTIFY_HOME: path.join(root, 'app'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), TELEGRAM_BOT_TOKEN: '123:FAKE_ONLY', FEISHU_WEBHOOK: '', FEISHU_SECRET: '' };
  const config = { version: 1, telegram: { enabled: true, chat_ids: ['111'] }, feishu: { enabled: false } };
  await atomicJson(file, config);
  await configureClaudeCode(file, 'install', { out() {}, text: async () => 'y', secret: async () => assert.fail('不读取秘密') }, { env });
  await atomicJson(policyPath(file), { version: 1, enabled: true, users: ['111'], permissions: false,
    bot: botKey(parseConfig(config, env)), generation: 'c'.repeat(32) });
  const access = await accessReplies(file, env);
  await stateTransaction(access, state => { state.offset = 10; });
  return { root, file, env, lease: path.join(replyDirectory(file), 'bridge.json') };
}
async function cli(f, args, lang = 'zh', overrides = {}) {
  const output = [], errors = [];
  const exit = await main([...args, '--lang', lang, '--config', f.file], { env: f.env,
    out: text => output.push(text), err: text => errors.push(text), ...overrides });
  return { exit, output, errors, text: [...output, ...errors].join('\n') };
}
for (const lang of ['zh', 'en']) test(`${lang} 所有登记错误码在用户可见翻译中一致且不丢失`, () => {
  setLocale(lang);
  try {
    for (const [key, code] of Object.entries(UI_ERROR_CODES)) {
      assert.match(code, /^DN-[A-Z0-9-]+$/);
      assert.ok(translate(key, { stage: 'getMe', reason: 'safe', detail: 'safe', channel: 'telegram', sent: 0, planned: 1 }).startsWith(`[${code}] `), key);
    }
    assert.doesNotMatch(translate('cli.bridgeReady'), /DN-/);
    assert.doesNotMatch(translate('cli.replyStartNotReady'), /reply status or reply run|reply status 或 reply run/);
  } finally { setLocale('zh'); }
});
for (const lang of ['zh', 'en']) test(`${lang} status展示白名单错误码和阶段，但不显示原异常/配置/Token`, async test => {
  const f = await fixture(test);
  await atomicJson(f.lease, { pid: process.pid, owner: OWNER, ready: false, updated: Date.now(),
    error: 'PRIVATE_ERROR https://fake.invalid/bot123', problem: { key: 'bridge.failureReset', stage: 'getWebhookInfo' } });
  const result = await cli(f, ['reply', 'status'], lang);
  assert.equal(result.exit, 1);
  assert.match(result.text, /DN-BRIDGE-CONNECTION-RESET.*getWebhookInfo/);
  assert.match(result.text, lang === 'zh' ? /不代表故障当前仍在发生/ : /not proof of an ongoing fault/);
  assert.doesNotMatch(result.text, /PRIVATE|fake\.invalid|bot123|FAKE_ONLY/);
});
for (const problem of [undefined, { key: 'PRIVATE_KEY', stage: 'getMe' }, { key: 'bridge.failureReset', stage: 'PRIVATE_STAGE' }])
test('旧版或损坏租约安全显示兜底错误码，不拼入任意字段', async test => {
  const f = await fixture(test);
  await atomicJson(f.lease, { pid: process.pid, owner: OWNER, ready: false, updated: Date.now(), error: 'PRIVATE_ERROR', problem });
  const result = await cli(f, ['reply', 'status']);
  assert.match(result.text, /DN-BRIDGE-UNKNOWN/); assert.doesNotMatch(result.text, /PRIVATE/);
});
test('恢复ready后不再把旧失败记录或旧元数据当作当前错误展示', async test => {
  const f = await fixture(test);
  await atomicJson(f.lease, { pid: process.pid, owner: OWNER, ready: true, updated: Date.now(),
    problem: { key: 'bridge.failureReset', stage: 'getWebhookInfo' } });
  await atomicJson(path.join(replyDirectory(f.file), 'bridge-failures', 'worker.json'), { reason: 'PRIVATE_HISTORICAL_ERROR' });
  const result = await cli(f, ['reply', 'status']);
  assert.equal(result.exit, 0); assert.match(result.text, /已就绪/);
  assert.doesNotMatch(result.text, /DN-|PRIVATE/);
});
test('已有未就绪进程时直接给错误码，不启动第二个消费者也不套用旧worker原因', async test => {
  const f = await fixture(test);
  await atomicJson(f.lease, { pid: process.pid, owner: OWNER, ready: false, updated: Date.now(), error: 'PRIVATE_ERROR',
    problem: { key: 'bridge.failureReset', stage: 'getWebhookInfo' } });
  const result = await cli(f, ['reply', 'start']);
  assert.equal(result.exit, 1); assert.match(result.text, /DN-BRIDGE-EXISTING-UNREADY/);
  assert.doesNotMatch(result.text, /DN-BRIDGE-CONNECTION-RESET|PRIVATE/);
});
test('父启动进程直接收到本次worker的白名单阶段与故障码', async test => {
  const f = await fixture(test), reports = [];
  const child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
  assert.equal(await startBridge(f.file, f.env, { spawn: () => child, onFailure: value => reports.push(value),
    sleep: async () => {
      await atomicJson(f.lease, { pid: process.pid, owner: OWNER, ready: false, updated: Date.now(), error: 'PRIVATE_ERROR',
        problem: { key: 'bridge.failureReset', stage: 'getWebhookInfo' } });
    } }), false);
  assert.deepEqual(reports, [{ key: 'bridge.failureReset', stage: 'getWebhookInfo' }]);
  const d = JSON.parse(await readFile(path.join(replyDirectory(f.file), 'bridge-failures', 'start.json'), 'utf8'));
  assert.equal(d.errorCode, 'DN-BRIDGE-CONNECTION-RESET');
  assert.doesNotMatch(JSON.stringify(d), /PRIVATE/);
});
test('没有本次worker故障细节时不借用历史记录猜原因；等待超时明确结果未确认', async test => {
  const f = await fixture(test), reports = [];
  const child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
  await atomicJson(path.join(replyDirectory(f.file), 'bridge-failures', 'worker.json'), { stage: 'getMe', errorCode: 'DN-BRIDGE-CONNECTION-RESET' });
  assert.equal(await startBridge(f.file, f.env, { spawn: () => child, sleep: async () => {}, onFailure: value => reports.push(value) }), false);
  assert.deepEqual(reports, [{ key: 'bridge.startTimedOut', stage: 'wait-timeout' }]);
  const d = JSON.parse(await readFile(path.join(replyDirectory(f.file), 'bridge-failures', 'start.json'), 'utf8'));
  assert.equal(d.outcome, 'unconfirmed'); assert.equal(d.errorCode, 'DN-BRIDGE-START-TIMEOUT');
});
test('父进程不采用属于其他owner的旧租约故障', async test => {
  const f = await fixture(test), reports = [];
  // PID确定不存在的旧租约；正常的活锁检查仍由既有实现执行。
  const { spawnSync } = await import('node:child_process');
  const departed = spawnSync(process.execPath, ['-e', '']).pid;
  await atomicJson(f.lease, { pid: departed, owner: OLD, ready: false, updated: Date.now(), error: 'PRIVATE',
    problem: { key: 'bridge.failureReset', stage: 'getMe' } });
  const child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
  assert.equal(await startBridge(f.file, f.env, { spawn: () => child, onFailure: value => reports.push(value),
    sleep: async () => child.emit('exit', 1) }), false);
  assert.deepEqual(reports, [{ key: 'bridge.startExited', stage: 'child-exit' }]);
});
test('worker连续reset把最终阶段错误码写入租约，已有重试恢复则保持ready无当前错误', async test => {
  const f = await fixture(test); let attempts = 0;
  await assert.rejects(runBridge(f.file, { env: f.env, sleep: async () => {}, api: () => async () => {
    attempts++; throw new TelegramConnectionResetError();
  } }), TelegramConnectionResetError);
  assert.equal(attempts, 2);
  assert.deepEqual((await bridgeStatus(f.file)).problem, { key: 'bridge.failureReset', stage: 'getWebhookInfo' });
  const result = await cli(f, ['reply', 'status']);
  assert.match(result.text, /DN-BRIDGE-CONNECTION-RESET/);
  let first = true;
  await runBridge(f.file, { env: f.env, maxIterations: 1, sleep: async () => {}, api: () => async method => {
    if (first) { first = false; throw new TelegramConnectionResetError(); }
    if (method === 'getUpdates') {
      const current = await cli(f, ['reply', 'status']);
      assert.equal(current.exit, 0); assert.doesNotMatch(current.text, /DN-BRIDGE-CONNECTION-RESET/);
      return [];
    }
    return { username: 'FakeTestBot' };
  } });
});
for (const lang of ['zh', 'en']) test(`${lang} 普通send失败直观显示渠道/确认段数/错误码，不转发任意错误文本`, async test => {
  const f = await fixture(test); let sends = 0;
  const result = await cli(f, ['send', '--title', '测试', '--channel', 'telegram'], lang, {
    send: async () => { sends++; return { ok: false, channel: 'telegram', sent: 0, planned: 1, error: 'PRIVATE_TOKEN https://fake.invalid' }; },
  });
  assert.equal(sends, 1); assert.equal(result.exit, 1);
  assert.match(result.text, /DN-NOTIFY-INCOMPLETE.*telegram/); assert.match(result.text, /0\/1/);
  assert.doesNotMatch(result.text, /PRIVATE|fake\.invalid/);
});
test('错误展示回调异常不改变启动失败结果或额外创建进程', async test => {
  const f = await fixture(test); let starts = 0, reports = 0;
  const child = Object.assign(new EventEmitter(), { pid: process.pid, unref() {} });
  const ready = await startBridge(f.file, f.env, {
    spawn: () => { starts++; return child; }, sleep: async () => child.emit('exit', 1),
    onFailure: () => { reports++; throw new Error('PRIVATE_OUTPUT_ERROR'); },
  });
  assert.equal(ready, false); assert.equal(starts, 1); assert.equal(reports, 1);
  const d = await readFile(path.join(replyDirectory(f.file), 'bridge-failures', 'start.json'), 'utf8');
  assert.doesNotMatch(d, /PRIVATE/);
});
test('README展示的操作性错误码均能在当前代码中找到', async () => {
  const known = new Set(Object.values(UI_ERROR_CODES));
  for (const lang of ['', '.en']) {
    const text = await readFile(new URL(`../README${lang}.md`, import.meta.url), 'utf8');
    for (const [, code] of text.matchAll(/`(DN-[A-Z0-9-]+)`/g)) assert.ok(known.has(code), code);
  }
});
test('CLI未细分校验错误与未知异常也有稳定代码，未知异常不泄漏', async test => {
  const f = await fixture(test);
  const invalid = await cli(f, ['send']);
  assert.match(invalid.text, /\[DN-CONFIG\]/);
  const failed = await cli(f, ['send', '--title', '测试'], 'zh', { send: async () => { throw new Error('PRIVATE'); } });
  assert.match(failed.text, /DN-UNKNOWN/); assert.doesNotMatch(failed.text, /PRIVATE/);
});
