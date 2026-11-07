import { test } from 'node:test';
import assert from 'node:assert/strict';
import dc from 'node:diagnostics_channel';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeliveryTracer, safeErrorCodes, MAX_TRACE_UNITS } from '../dist/delivery-trace.js';
import { deliver, makePlan } from '../dist/channels.js';
import { dispatchClaudeHook } from '../dist/claude-hook.js';
import { TelegramConnectionResetError } from '../dist/notification-diagnostics.js';

globalThis.fetch = async () => { throw new Error('禁止真实网络请求'); };
const TOKEN = '123456:FAKE_PRIVATE_TOKEN';
const CONFIG = chatIds => ({ telegram: { enabled: true, token: TOKEN, chatIds }, feishu: { enabled: false } });
const message = (content = '私密正文PRIVATE_BODY') => ({ title: '完成', level: 'success', content, footer: '会话：PRIVATE_SESSION' });
const TG = { origin: 'https://api.telegram.org' };
const PARAMS = { hostname: 'api.telegram.org', host: 'PRIVATE_HOST', port: 443 };

// 伪事件总线：按真实 undici 事件顺序发布，验证关联逻辑而不触网。
function bus() {
  const listeners = new Map();
  return { listeners, subscribe: (name, fn) => listeners.set(name, fn), unsubscribe: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
    publish: (name, value) => listeners.get('undici:' + name)?.(value) };
}
function network(events, script) {
  // script(index, request) 返回 { connect?, connectError?, reset?, ok? }；每次请求创建新的 undici request 对象。
  let calls = 0;
  const sockets = [];
  return async (url, payload) => {
    const index = calls++, plan = script(index, payload) ?? {};
    const request = { ...TG, path: new URL(url).pathname, method: 'POST', body: JSON.stringify(payload) };
    events.publish('request:create', { request });
    if (plan.connect || !sockets.length) {
      events.publish('client:beforeConnect', { connectParams: PARAMS });
      if (plan.connectError) {
        const error = Object.assign(new Error('PRIVATE_CONNECT'), { code: 'ECONNRESET', address: 'PRIVATE_IP' });
        events.publish('client:connectError', { connectParams: PARAMS, error });
        events.publish('request:error', { request, error: new TypeError('fetch failed', { cause: error }) });
        throw new TelegramConnectionResetError();
      }
      sockets.push({ remoteFamily: 'IPv4', remoteAddress: 'PRIVATE_IP' });
      events.publish('client:connected', { connectParams: PARAMS, socket: sockets.at(-1) });
    }
    const socket = sockets.at(-1);
    events.publish('client:sendHeaders', { request, socket, headers: 'PRIVATE_HEADERS' });
    events.publish('request:bodySent', { request });
    if (plan.reset) {
      events.publish('request:error', { request, error: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET', cause: { code: 'ECONNRESET' } }) });
      throw new TelegramConnectionResetError();
    }
    events.publish('request:headers', { request, response: { statusCode: plan.status ?? 200, headers: 'PRIVATE_RESPONSE' } });
    events.publish('request:trailers', { request });
    return plan.response ?? { ok: true, result: { message_id: 1 } };
  };
}
function clock() { let value = 0; return { now: () => value, tick: ms => { value += ms; } }; }

test('两个接收人：第2个接收人在复用连接上写出请求后被重置，可区分单元与阶段', async () => {
  const events = bus(), time = clock(), tracer = createDeliveryTracer(time.now, events);
  const plan = makePlan('telegram', { ...message(), reply: { token: 'tok', users: ['222'] } }, CONFIG(['111', '222']));
  const fetcher = network(events, index => { time.tick(700); return index === 1 ? { reset: true } : {}; });
  const traced = tracer.telegram(plan, fetcher);
  const result = await deliver(plan, CONFIG(['111', '222']), traced.request, async () => {});
  const trace = traced.finish(); tracer.close();
  assert.deepEqual([result.sent, result.planned, result.ok], [1, 2, false]);
  assert.deepEqual(trace.units.map(unit => [unit.unit, unit.recipient, unit.part, unit.parts, unit.button, unit.outcome]),
    [[1, 1, 1, 1, false, 'accepted'], [2, 2, 1, 1, true, 'failed']]);
  const [first, second] = trace.units.map(unit => unit.attempts[0]);
  assert.deepEqual(first.stages, ['create', 'connect', 'connected', 'headers-sent', 'body-sent', 'response']);
  assert.equal(first.socket, 'new'); assert.equal(first.family, 4); assert.equal(first.status, 200);
  assert.deepEqual(second.stages, ['create', 'headers-sent', 'body-sent', 'error']);
  assert.equal(second.socket, 'reused'); assert.equal(second.socketUses, 1); assert.equal(second.outcome, 'reset');
  assert.deepEqual(second.errorCodes, ['UND_ERR_SOCKET', 'ECONNRESET']);
  assert.equal(events.listeners.size, 0, '关闭后必须退订');
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE|111|222|https:|bot123|tok/);
});

test('同一接收人两段：第2段建连失败；首段失败时后续段记为跳过', async () => {
  const events = bus(), tracer = createDeliveryTracer(() => 0, events);
  const config = CONFIG(['111']), plan = makePlan('telegram', message(), config);
  plan.items.push({ ...structuredClone(plan.items[0]), plain: plan.items[0].plain + '2', payload: { ...plan.items[0].payload, text: 'part2' } });
  const traced = tracer.telegram(plan, network(events, index => index === 1 ? { connect: true, connectError: true } : {}));
  const result = await deliver(plan, config, traced.request, async () => {});
  assert.deepEqual([result.sent, result.planned], [1, 2]);
  const trace = traced.finish();
  assert.deepEqual(trace.units.map(unit => [unit.recipient, unit.part, unit.parts, unit.outcome]), [[1, 1, 2, 'accepted'], [1, 2, 2, 'failed']]);
  assert.deepEqual(trace.units[1].attempts[0].stages, ['create', 'connect', 'connect-error', 'error']);
  assert.equal(trace.units[1].attempts[0].socket, undefined);
  assert.deepEqual(trace.units[1].attempts[0].errorCodes, ['ECONNRESET']);
  // 首段即失败：deliver 跳过同接收人的后续段，摘要明确为 skipped 而不是失败。
  const again = tracer.telegram(plan, network(events, () => ({ connect: true, connectError: true })));
  await deliver(plan, config, again.request, async () => {});
  assert.deepEqual(again.finish().units.map(unit => [unit.outcome, unit.attempts.length]), [['failed', 1], ['skipped', 0]]);
  tracer.close();
});

test('429 等待重发与纯文本回退按尝试类型记录，API 错误码只保留数值', async () => {
  const events = bus(), tracer = createDeliveryTracer(() => 0, events), config = CONFIG(['111']);
  const plan = makePlan('telegram', message(), config);
  const responses = [{ ok: false, error_code: 429, description: 'PRIVATE', parameters: { retry_after: 1 } },
    { ok: false, error_code: 400, description: "can't parse entities PRIVATE" }, { ok: true, result: {} }];
  const traced = tracer.telegram(plan, network(events, index => ({ response: responses[index], status: index < 2 ? 400 : 200 })));
  const result = await deliver(plan, config, traced.request, async () => {});
  assert.equal(result.ok, true);
  const [unit] = traced.finish().units;
  assert.deepEqual(unit.attempts.map(value => [value.kind, value.outcome, value.apiCode]),
    [['initial', 'rejected', 429], ['retry', 'rejected', 400], ['plain', 'accepted', undefined]]);
  assert.deepEqual(unit.attempts.map(value => value.socket), ['new', 'reused', 'reused']);
  assert.deepEqual(unit.attempts.map(value => value.socketUses), [undefined, 1, 2]);
  assert.doesNotMatch(JSON.stringify(unit), /PRIVATE|parse/);
  tracer.close();
});

test('观察开始前的连接只记复用；空闲时长按上次响应计算；身份查询不归入发送单元', async () => {
  const events = bus(), time = clock(), tracer = createDeliveryTracer(time.now, events);
  const preexisting = { remoteFamily: 'IPv6' }, getMe = { ...TG, path: '/botFAKE/getMe' };
  events.publish('request:create', { request: getMe });
  events.publish('client:connected', { connectParams: PARAMS, socket: preexisting });
  events.publish('client:sendHeaders', { request: getMe, socket: preexisting });
  events.publish('request:headers', { request: getMe, response: { statusCode: 200 } });
  time.tick(4200);
  const config = CONFIG(['111']), plan = makePlan('telegram', message(), config);
  const traced = tracer.telegram(plan, async (url, payload) => {
    const request = { ...TG, path: '/bot' + TOKEN + '/sendMessage' };
    events.publish('request:create', { request });
    events.publish('client:sendHeaders', { request, socket: preexisting });
    events.publish('request:error', { request, error: { code: 'ECONNRESET' } });
    throw new TelegramConnectionResetError();
  });
  await deliver(plan, config, traced.request, async () => {});
  const attempt = traced.finish().units[0].attempts[0];
  assert.deepEqual([attempt.socket, attempt.socketUses, attempt.idleMs, attempt.family], ['reused', 1, 4200, 6]);
  // 完全未见过的连接：确定是复用，但不猜次数/空闲。
  const unknown = tracer.telegram(plan, async () => {
    const request = { ...TG, path: '/botFAKE/sendMessage' };
    events.publish('request:create', { request });
    events.publish('client:sendHeaders', { request, socket: {} });
    return { ok: true, result: {} };
  });
  await deliver(plan, config, unknown.request, async () => {});
  const other = unknown.finish().units[0].attempts[0];
  assert.deepEqual([other.socket, other.socketUses, other.idleMs], ['reused', undefined, undefined]);
  tracer.close();
});

test('非 Telegram 事件、畸形事件、观察异常均不影响发送；单元与阶段有上限', async () => {
  const events = bus(), tracer = createDeliveryTracer(() => 0, events);
  for (const name of ['request:create', 'request:headers', 'client:connected', 'client:sendHeaders', 'request:error']) {
    assert.doesNotThrow(() => events.publish(name, null));
    assert.doesNotThrow(() => events.publish(name, { request: { origin: 'https://private.invalid', path: '/x' }, connectParams: { hostname: 'private.invalid' } }));
    assert.doesNotThrow(() => events.publish(name, { request: { get origin() { throw new Error('PRIVATE'); } } }));
  }
  const ids = Array.from({ length: MAX_TRACE_UNITS + 3 }, (_, index) => String(1000 + index));
  const config = CONFIG(ids), plan = makePlan('telegram', message(), config);
  const traced = tracer.telegram(plan, async () => {
    const request = { ...TG, path: '/botFAKE/sendMessage' };
    events.publish('request:create', { request });
    for (let i = 0; i < 30; i++) events.publish(i % 2 ? 'request:bodySent' : 'client:beforeConnect', { request, connectParams: PARAMS });
    return { ok: true, result: {} };
  });
  const result = await deliver(plan, config, traced.request, async () => {});
  assert.equal(result.sent, ids.length);
  const trace = traced.finish();
  assert.equal(trace.units.length, MAX_TRACE_UNITS); assert.equal(trace.omitted, 3);
  assert.ok(trace.units.every(unit => unit.attempts[0].stages.length <= 10));
  // 注入的发送器不调用包装请求时，不制造空摘要。
  assert.equal(tracer.telegram(plan).finish(), undefined);
  tracer.close();
  assert.deepEqual(safeErrorCodes({ code: 'E_PRIVATE', cause: { errors: [{ code: 'EPIPE' }] } }), ['EPIPE']);
});

test('真实诊断通道：订阅后能收到事件，关闭后完全退订', async () => {
  const tracer = createDeliveryTracer();
  const config = CONFIG(['111']), plan = makePlan('telegram', message(), config);
  const traced = tracer.telegram(plan, async () => {
    const request = { ...TG, path: '/botFAKE/sendMessage' };
    dc.channel('undici:request:create').publish({ request });
    dc.channel('undici:request:bodySent').publish({ request });
    return { ok: true, result: {} };
  });
  await deliver(plan, config, traced.request, async () => {});
  assert.deepEqual(traced.finish().units[0].attempts[0].stages, ['create', 'body-sent']);
  tracer.close();
  for (const name of ['undici:request:create', 'undici:client:sendHeaders']) assert.equal(dc.channel(name).hasSubscribers, false);
});

test('真实 Stop hook 把逐单元阶段写入诊断与失败记录，不含身份、正文或凭据', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-trace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '111,222', FEISHU_WEBHOOK: '', FEISHU_SECRET: '',
    DEV_NOTIFY_HOME: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
  const file = path.join(env.DEV_NOTIFY_HOME, 'config', 'config.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, telegram: { enabled: true, chat_ids: [] }, feishu: { enabled: false } }));
  let calls = 0;
  const previous = globalThis.fetch;
  // 模拟 Node fetch：通过真实 diagnostics_channel 发布 undici 事件，第2次请求在复用连接上被重置。
  const socket = { remoteFamily: 'IPv4' };
  globalThis.fetch = async (url, init) => {
    const request = { origin: new URL(url).origin, path: new URL(url).pathname };
    const index = calls++;
    dc.channel('undici:request:create').publish({ request });
    if (!index) dc.channel('undici:client:connected').publish({ connectParams: PARAMS, socket });
    dc.channel('undici:client:sendHeaders').publish({ request, socket });
    dc.channel('undici:request:bodySent').publish({ request });
    if (index === 1) {
      const error = Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' });
      dc.channel('undici:request:error').publish({ request, error });
      throw new TypeError('fetch failed', { cause: error });
    }
    dc.channel('undici:request:headers').publish({ request, response: { statusCode: 200 } });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = previous; });
  const errors = [];
  const hook = { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '私密正文PRIVATE_BODY', session_id: 'trace-session', cwd: '/PRIVATE/project' };
  await dispatchClaudeHook(Buffer.from(JSON.stringify(hook)), file, { env, err: text => errors.push(text), send: deliver });
  assert.equal(calls, 2, '不得新增重试或补发');
  const diagnostic = JSON.parse(await readFile(path.join(file + '.reply-data', 'notification-diagnostics', 'trace-session.json'), 'utf8'));
  const failure = JSON.parse(await readFile(path.join(file + '.reply-data', 'notification-failures', 'trace-session.json'), 'utf8'));
  assert.deepEqual(failure, diagnostic);
  const telegram = diagnostic.channels.telegram;
  assert.deepEqual([telegram.status, telegram.sent, telegram.planned], ['incomplete', 1, 2]);
  assert.deepEqual(telegram.trace.units.map(unit => [unit.recipient, unit.outcome, unit.attempts[0].socket, unit.attempts[0].outcome]),
    [[1, 'accepted', 'new', 'accepted'], [2, 'failed', 'reused', 'reset']]);
  assert.deepEqual(telegram.trace.units[1].attempts[0].stages, ['create', 'headers-sent', 'body-sent', 'error']);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE|111|222|FAKE_PRIVATE_TOKEN|https:|project/);
  assert.equal(dc.channel('undici:request:create').hasSubscribers, false);
  assert.ok(errors.some(text => /1\/2|1.*2/.test(text)));
});
