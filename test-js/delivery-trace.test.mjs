import { test } from 'node:test';
import assert from 'node:assert/strict';
import dc from 'node:diagnostics_channel';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { TransportError } from '@quecue/notify-core';
import { createDeliveryTracer, safeErrorCodes, connectFailure, attemptedFamilies, MAX_TRACE_UNITS, MAX_TRACE_STAGES, MAX_RECONNECTS } from '../dist/delivery-trace.js';
import { deliver, makePlan } from '../dist/channels.js';
import { dispatchClaudeHook } from '../dist/claude-hook.js';
import { TelegramConnectionResetError } from '../dist/notification-diagnostics.js';

// 仅本地回环用例使用原生 fetch；其余一律禁止真实网络。
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('禁止真实网络请求'); };
const NO_RETRY = { reconnectDelays: [] };
const TOKEN = '123456:FAKE_PRIVATE_TOKEN';
const CONFIG = chatIds => ({ telegram: { enabled: true, token: TOKEN, chatIds }, feishu: { enabled: false } });
const message = (content = '私密正文PRIVATE_BODY') => ({ title: '完成', level: 'success', content, footer: '会话：PRIVATE_SESSION' });
const TG = { origin: 'https://api.telegram.org' };
const PARAMS = { hostname: 'api.telegram.org', host: 'PRIVATE_HOST', port: 443 };

// 伪事件总线：按真实 undici 事件顺序发布，验证关联逻辑而不触网。
function bus() {
  const listeners = new Map();
  return { listeners, subscribe: (name, fn) => listeners.set(name, fn), unsubscribe: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
    publish: (name, value) => listeners.get(name.startsWith('net.') ? name : 'undici:' + name)?.(value) };
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
      // 模拟 undici 建连时创建的 TLS 套接字：TCP connect 后再 secureConnect。
      const raw = Object.assign(new EventEmitter(), { remoteFamily: 'IPv6', remoteAddress: 'PRIVATE_IP',
        autoSelectFamilyAttemptedAddresses: ['2001:db8::1:443', '192.0.2.1:443'] });
      events.publish('net.client.socket', { socket: raw });
      if (plan.tcp !== false) raw.emit('connect');
      if (plan.connectError) {
        const error = plan.connectErrorValue ?? Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read', address: 'PRIVATE_IP' });
        events.publish('client:connectError', { connectParams: PARAMS, error });
        events.publish('request:error', { request, error: new TypeError('fetch failed', { cause: error }) });
        throw new TelegramConnectionResetError();
      }
      raw.emit('secureConnect');
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
  assert.deepEqual(first.stages, ['create', 'connect', 'tcp-connected', 'tls-secure', 'connected', 'headers-sent', 'body-sent', 'response']);
  assert.equal(first.socket, 'new'); assert.equal(first.family, 4); assert.equal(first.status, 200);
  assert.deepEqual(second.stages, ['create', 'headers-sent', 'body-sent', 'error']);
  assert.equal(second.socket, 'reused'); assert.equal(second.socketUses, 1); assert.equal(second.outcome, 'reset');
  assert.deepEqual(second.errorCodes, ['UND_ERR_SOCKET', 'ECONNRESET']);
  assert.equal(events.listeners.size, 0, '关闭后必须退订');
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE|111|222|https:|bot123|tok/);
});

test('同一接收人两段：第2段建连失败；首段失败时后续段记为跳过（关闭重连）', async () => {
  const events = bus(), tracer = createDeliveryTracer(() => 0, events, NO_RETRY);
  const config = CONFIG(['111']), plan = makePlan('telegram', message(), config);
  plan.items.push({ ...structuredClone(plan.items[0]), plain: plan.items[0].plain + '2', payload: { ...plan.items[0].payload, text: 'part2' } });
  const traced = tracer.telegram(plan, network(events, index => index === 1 ? { connect: true, connectError: true } : {}));
  const result = await deliver(plan, config, traced.request, async () => {});
  assert.deepEqual([result.sent, result.planned], [1, 2]);
  const trace = traced.finish();
  assert.deepEqual(trace.units.map(unit => [unit.recipient, unit.part, unit.parts, unit.outcome]), [[1, 1, 2, 'accepted'], [1, 2, 2, 'failed']]);
  assert.deepEqual(trace.units[1].attempts[0].stages, ['create', 'connect', 'tcp-connected', 'connect-error', 'error']);
  assert.equal(trace.units[1].attempts[0].connectFailure, 'read');
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
  assert.ok(trace.units.every(unit => unit.attempts[0].stages.length <= MAX_TRACE_STAGES));
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

test('建连失败且请求未写出：同一单元按 1s/3s 最多重连 2 次，成功后计入已确认', async () => {
  const events = bus(), waits = [], tracer = createDeliveryTracer(() => 0, events, { sleep: async ms => { waits.push(ms); } });
  const config = CONFIG(['111']), plan = makePlan('telegram', message(), config);
  let calls = 0;
  const traced = tracer.telegram(plan, network(events, index => { calls++; return index < 2 ? { connect: true, connectError: true } : { connect: true }; }));
  const result = await deliver(plan, config, traced.request, async () => {});
  assert.deepEqual([result.ok, result.sent, calls], [true, 1, 3]);
  assert.deepEqual(waits, [1000, 3000]);
  const [unit] = traced.finish().units;
  assert.equal(unit.outcome, 'accepted');
  assert.deepEqual(unit.attempts.map(value => [value.kind, value.outcome]), [['initial', 'reset'], ['reconnect', 'reset'], ['reconnect', 'accepted']]);
  const failed = unit.attempts[0];
  assert.deepEqual(failed.stages, ['create', 'connect', 'tcp-connected', 'connect-error', 'error']);
  assert.deepEqual([failed.connectFailure, failed.family, failed.attemptedFamilies], ['read', 6, [6, 4]]);
  assert.deepEqual(unit.attempts[2].stages, ['create', 'connect', 'tcp-connected', 'tls-secure', 'connected', 'headers-sent', 'body-sent', 'response']);
  assert.doesNotMatch(JSON.stringify(unit), /PRIVATE|2001|192\.0|111/);
  tracer.close();
});

test('重连额度：每单元最多 2 次、每条通知最多 4 次，耗尽后按原错误失败', async () => {
  const events = bus(), waits = [], tracer = createDeliveryTracer(() => 0, events, { sleep: async ms => { waits.push(ms); } });
  const config = CONFIG(['111', '222', '333']), plan = makePlan('telegram', message(), config);
  const refused = Object.assign(new Error('connect ECONNREFUSED PRIVATE_IP:443'), { code: 'ECONNREFUSED', syscall: 'connect', address: 'PRIVATE_IP' });
  let calls = 0;
  const traced = tracer.telegram(plan, network(events, () => { calls++; return { connect: true, connectError: true, tcp: false, connectErrorValue: refused }; }));
  const result = await deliver(plan, config, traced.request, async () => {});
  assert.deepEqual([result.sent, result.planned, calls], [0, 3, 7]);
  assert.equal(MAX_RECONNECTS, 4);
  assert.deepEqual(waits, [1000, 3000, 1000, 3000]);
  const units = traced.finish().units;
  assert.deepEqual(units.map(unit => unit.attempts.length), [3, 3, 1]);
  assert.ok(units.every(unit => unit.outcome === 'failed'));
  assert.deepEqual(units[0].attempts[0].stages, ['create', 'connect', 'connect-error', 'error']);
  assert.equal(units[0].attempts[0].connectFailure, 'tcp');
  assert.doesNotMatch(JSON.stringify(units), /PRIVATE/);
  tracer.close();
});

test('已写出请求、收到响应、非网络错误、未观察到建连失败或已关闭时绝不重连', async () => {
  const connectError = events => events.publish('client:connectError', { connectParams: PARAMS, error: { code: 'ECONNRESET' } });
  const cases = [
    (events, request) => { connectError(events); events.publish('client:sendHeaders', { request, socket: {} }); throw new TelegramConnectionResetError(); },
    (events, request) => { connectError(events); events.publish('request:bodySent', { request }); throw new TransportError('x'); },
    (events, request) => { connectError(events); events.publish('request:headers', { request, response: { statusCode: 502 } }); throw new TransportError('x'); },
    events => { connectError(events); throw new Error('PRIVATE'); },
    () => { throw new TelegramConnectionResetError(); },
  ];
  for (const [index, body] of cases.entries()) {
    const events = bus(), waits = [], tracer = createDeliveryTracer(() => 0, events, { sleep: async ms => { waits.push(ms); } });
    const config = CONFIG(['111']), plan = makePlan('telegram', message(), config);
    let calls = 0;
    const traced = tracer.telegram(plan, async () => {
      calls++;
      const request = { ...TG, path: '/botFAKE/sendMessage' };
      events.publish('request:create', { request });
      return body(events, request);
    });
    await deliver(plan, config, traced.request, async () => {});
    assert.deepEqual([calls, waits.length], [1, 0], '用例 ' + index);
    tracer.close();
  }
  // 运行时没有任何诊断事件（请求未被观察到创建）时同样不重连。
  const silent = createDeliveryTracer(() => 0, bus(), { sleep: async () => assert.fail('不应等待') });
  const config = CONFIG(['111']), plan = makePlan('telegram', message(), config);
  let calls = 0;
  const quiet = silent.telegram(plan, async () => { calls++; throw new TelegramConnectionResetError(); });
  await deliver(plan, config, quiet.request, async () => {});
  assert.equal(calls, 1);
  silent.close();
  const events = bus(), closed = createDeliveryTracer(() => 0, events, { sleep: async () => assert.fail('不应等待') });
  const traced = closed.telegram(plan, network(events, () => ({ connect: true, connectError: true })));
  closed.close();
  await deliver(plan, config, traced.request, async () => {});
});

test('建连失败分类与地址族只保留枚举值', () => {
  assert.equal(connectFailure({ code: 'ECONNREFUSED', syscall: 'connect', address: 'PRIVATE' }), 'tcp');
  assert.equal(connectFailure({ code: 'ECONNRESET', syscall: 'read' }), 'read');
  assert.equal(connectFailure({ code: 'EPIPE', syscall: 'write' }), 'write');
  assert.equal(connectFailure({ code: 'ECONNRESET', message: 'Client network socket disconnected before secure TLS connection was established' }), 'tls-closed');
  assert.equal(connectFailure({ code: 'UND_ERR_CONNECT_TIMEOUT' }), 'timeout');
  assert.equal(connectFailure(new AggregateError([{ syscall: 'connect' }, { syscall: 'connect' }])), 'tcp');
  assert.equal(connectFailure(new AggregateError([{ syscall: 'connect' }, { syscall: 'read' }])), 'other');
  assert.equal(connectFailure(null), 'other');
  assert.deepEqual(attemptedFamilies({ autoSelectFamilyAttemptedAddresses: ['2001:db8::1:443', '192.0.2.1:443', '[::1]:443', 'junk'] }), [6, 4, 6, 4]);
  assert.equal(attemptedFamilies({}), undefined);
  assert.equal(attemptedFamilies({ get autoSelectFamilyAttemptedAddresses() { throw new Error('x'); } }), undefined);
});

test('真实 undici 回环：TCP 被拒且未写出时重连成功；TLS 阶段收到 RST 分类为 read 并按额度重连', async t => {
  // 取空闲端口后关闭：首个请求必然 ECONNREFUSED；重连等待期间在同端口启动服务。
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = http.createServer((request, response) => { request.resume(); request.on('end', () => response.end('{"ok":true,"result":{}}')); });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const config = CONFIG(['111']);
  const tracer = createDeliveryTracer(undefined, undefined, { host: '127.0.0.1',
    sleep: () => new Promise(resolve => server.listen(port, '127.0.0.1', resolve)) });
  const plan = makePlan('telegram', message(), config);
  const traced = tracer.telegram(plan, async (url, payload) => {
    try {
      const response = await nativeFetch('http://127.0.0.1:' + port + '/botFAKE/sendMessage', { method: 'POST', body: JSON.stringify(payload) });
      return await response.json();
    } catch { throw new TransportError('network'); }
  });
  const result = await deliver(plan, config, traced.request, async () => {});
  const [unit] = traced.finish().units;
  tracer.close();
  assert.equal(result.ok, true);
  assert.deepEqual(unit.attempts.map(value => value.kind), ['initial', 'reconnect']);
  assert.deepEqual(unit.attempts[0].stages, ['create', 'connect', 'connect-error', 'error']);
  assert.equal(unit.attempts[0].connectFailure, 'tcp');
  assert.deepEqual(unit.attempts[1].stages.slice(0, 3), ['create', 'connect', 'tcp-connected']);
  assert.ok(unit.attempts[1].stages.includes('headers-sent') && unit.attempts[1].stages.includes('response'));
  assert.equal(unit.attempts[1].family, 4);

  const rst = net.createServer(socket => socket.once('data', () => socket.resetAndDestroy()));
  await new Promise(resolve => rst.listen(0, '127.0.0.1', resolve));
  t.after(() => rst.close());
  let calls = 0;
  const tls = createDeliveryTracer(undefined, undefined, { host: '127.0.0.1', sleep: async () => {} });
  const tlsPlan = makePlan('telegram', message(), config);
  const tlsTraced = tls.telegram(tlsPlan, async () => {
    calls++;
    try { await nativeFetch('https://127.0.0.1:' + rst.address().port + '/botFAKE/sendMessage', { method: 'POST', body: '{}' }); }
    catch { throw new TransportError('network'); }
  });
  const failed = await deliver(tlsPlan, config, tlsTraced.request, async () => {});
  const [tlsUnit] = tlsTraced.finish().units;
  tls.close();
  assert.deepEqual([failed.sent, calls], [0, 3]);
  assert.deepEqual(tlsUnit.attempts[0].stages, ['create', 'connect', 'tcp-connected', 'connect-error', 'error']);
  assert.deepEqual([tlsUnit.attempts[0].connectFailure, tlsUnit.attempts[0].family], ['read', 4]);
});

test('真实 Stop hook：建连失败未写出时重连后送达，诊断记录重连过程', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-reconnect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '111', FEISHU_WEBHOOK: '', FEISHU_SECRET: '',
    DEV_NOTIFY_HOME: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
  const file = path.join(env.DEV_NOTIFY_HOME, 'config', 'config.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, telegram: { enabled: true, chat_ids: [] }, feishu: { enabled: false } }));
  let calls = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async url => {
    const request = { origin: new URL(url).origin, path: new URL(url).pathname };
    const index = calls++;
    dc.channel('undici:request:create').publish({ request });
    dc.channel('undici:client:beforeConnect').publish({ connectParams: PARAMS });
    if (!index) {
      const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' });
      dc.channel('undici:client:connectError').publish({ connectParams: PARAMS, error });
      dc.channel('undici:request:error').publish({ request, error });
      throw new TypeError('fetch failed', { cause: error });
    }
    const socket = { remoteFamily: 'IPv4' };
    dc.channel('undici:client:connected').publish({ connectParams: PARAMS, socket });
    dc.channel('undici:client:sendHeaders').publish({ request, socket });
    dc.channel('undici:request:headers').publish({ request, response: { statusCode: 200 } });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = previous; });
  const waits = [];
  const hook = { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'PRIVATE_BODY', session_id: 'reconnect-session', cwd: '/PRIVATE' };
  await dispatchClaudeHook(Buffer.from(JSON.stringify(hook)), file, { env, err: () => {}, send: deliver,
    deliveryTrace: { sleep: async ms => { waits.push(ms); } } });
  assert.deepEqual([calls, waits], [2, [1000]]);
  const diagnostic = JSON.parse(await readFile(path.join(file + '.reply-data', 'notification-diagnostics', 'reconnect-session.json'), 'utf8'));
  const telegram = diagnostic.channels.telegram;
  assert.deepEqual([telegram.status, telegram.sent, telegram.planned], ['complete', 1, 1]);
  assert.deepEqual(telegram.trace.units[0].attempts.map(value => [value.kind, value.outcome, value.connectFailure]),
    [['initial', 'reset', 'read'], ['reconnect', 'accepted', undefined]]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE|111|FAKE_PRIVATE_TOKEN/);
});
