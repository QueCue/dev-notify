import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFeishuClient } from '@quecue/notify-core';
import { parseConfig, ready } from '../dist/config.js';
import { encodeBundle, decodeBundle } from '../dist/credentials.js';
import { wizard } from '../dist/setup.js';
import { configureClaudeCode } from '../dist/claude-code.js';
import { accessReplies, atomicJson, botKey, configureReplies, messageKey, policyPath, stateTransaction, targetEpoch, replyDirectory } from '../dist/reply-state.js';
import { enqueueFeishuMessage, feishuReplyApi, parseFeishuMessage } from '../dist/reply-feishu.js';
import { drainFeishuInbox, drainReplies, processUpdate } from '../dist/reply-engine.js';
import { attachReply, interactionHook, lifecycleHook, mapReplies } from '../dist/reply-hooks.js';
import { createInteraction, showInteraction, waitInteraction } from '../dist/reply-interactions.js';
import { bridgeStatus, runBridge, startBridge } from '../dist/reply-bridge.js';
import { deliverFeishuPlan, makePlan } from '../dist/channels.js';
import { dispatchClaudeHook } from '../dist/claude-hook.js';
import { getLocale, setLocale } from '../dist/i18n.js';
import { refreshFeishuReplyCards } from '../dist/feishu-card-status.js';
import { SessionLookupError, validateTarget } from '../dist/reply-platform.js';
import { callKey, registerToolCall } from '../dist/reply-outcomes.js';

globalThis.fetch = async () => { throw new Error('禁止真实网络'); };
const USER = 'ou_FAKE_USER', OTHER = 'ou_OTHER_USER';
const APP = 'cli_0123456789abcdef';
const RAW = { telegram: { enabled: false }, feishu: { mode: 'app', open_ids: [USER] } };
const TARGET = { session: 'feishu-test', pid: 12345, birth: 'FAKE', tty: 'FAKE', title: '隔离测试', cwd: 'C:/fake', tracked: true, working: false, updated: Date.now() };
const QUESTION = { question: '选择框架？', header: '框架', options: [{ label: 'React', description: '组件' }, { label: 'Vue', description: '渐进式' }] };
const prompts = (answers = [], secrets = []) => ({ output: [], out(text) { this.output.push(text); },
  text: async () => { assert.ok(answers.length, '意外询问'); return answers.shift(); },
  secret: async () => { assert.ok(secrets.length, '意外询问凭据'); return secrets.shift(); } });
// out 作为回调传递，使用闭包而不是依赖 this。
function ui(answers = [], secrets = []) { const value = prompts(answers, secrets); value.out = text => value.output.push(text); return value; }
async function fixture(t, raw = RAW) {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-feishu-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { DEV_NOTIFY_HOME: path.join(root, 'app'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    FEISHU_APP_ID: APP, FEISHU_APP_SECRET: 'FAKE_ONLY_SECRET' };
  const file = path.join(root, 'config.json');
  await atomicJson(file, raw);
  await configureClaudeCode(file, 'install', ui(['y']), { env });
  const config = parseConfig(raw, env);
  const policy = { version: 1, enabled: true, channel: 'feishu', bot: botKey(config, 'feishu'), users: [USER], permissions: true, generation: 'a'.repeat(32) };
  await atomicJson(policyPath(file), policy);
  const access = await accessReplies(file, env);
  const sent = [], inputs = [];
  let id = 0;
  const client = { sendMessage: async message => { sent.push(message); return { messageId: 'om_sent_' + ++id }; },
    replyMessage: async (messageId, message) => { sent.push({ replyTo: messageId, ...message }); return { messageId: 'om_sent_' + ++id }; } };
  const api = feishuReplyApi(config, client);
  const context = { api, fresh: () => accessReplies(file, env), validate: async () => true, inject: async (target, text) => inputs.push({ target, text }) };
  await stateTransaction(access, state => {
    state.sessions[TARGET.session] = { ...TARGET, updated: Date.now() };
    state.entries[messageKey(access, USER, 'om_notice')] = { session: TARGET.session, epoch: targetEpoch(TARGET), updated: Date.now() };
  });
  return { root, file, raw, env, policy, config, access, sent, inputs, client, api, context };
}
function event(id = 'om_input', text = '继续', parent = 'om_notice') {
  return { event_id: 'event_' + id, event_type: 'im.message.receive_v1', sender: { sender_id: { open_id: USER }, sender_type: 'user' },
    message: { message_id: id, chat_id: 'oc_private', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), create_time: String(Date.now()), parent_id: parent } };
}
const snapshot = access => stateTransaction(access, state => structuredClone(state));
async function receive(ctx, value) { await enqueueFeishuMessage(ctx.access, value); await drainFeishuInbox(ctx.access, ctx.context); }

async function dispatchCompletion(ctx, reply = {}, content = '测试完成正文') {
  const plans = [], errors = [];
  await dispatchClaudeHook(Buffer.from(JSON.stringify({ hook_event_name: 'Stop', session_id: TARGET.session,
    last_assistant_message: content })), ctx.file, {
    env: ctx.env, err: text => errors.push(text),
    reply: { session: async () => TARGET, bridge: async () => true, ...reply },
    send: async plan => {
      plans.push(plan);
      for (let index = 0; index < plan.items.length; index++) await plan.onSent?.(plan.items[index], { result: { message_id: plan.channel === 'telegram' ? 500 + index : 'om_status_' + index } });
      return { channel: plan.channel, sent: plan.items.length, planned: plan.items.length, ok: true };
    },
  });
  return { plans, errors };
}
test('飞书完成卡片顶部按接收人显示可回复，未授权通知接收人明确不可回复', async t => {
  const ctx = await fixture(t, { ...RAW, feishu: { ...RAW.feishu, open_ids: [USER, OTHER] } });
  const { plans } = await dispatchCompletion(ctx);
  assert.equal(plans.length, 1);
  const enabled = plans[0].items.find(item => item.recipient === USER);
  const disabled = plans[0].items.find(item => item.recipient === OTHER);
  assert.match(enabled.payload.card.header.title.content, /^🟡 回复准备中｜/);
  assert.equal(enabled.payload.card.header.template, 'yellow');
  assert.equal(disabled.payload.card.header.template, 'grey');
  assert.match(enabled.payload.card.elements.find(element => element.tag === 'note').elements[0].content, /^正在保存回复关联/);
  assert.match(disabled.payload.card.header.title.content, /^⚪ 不可回复｜/);
  assert.match(disabled.payload.card.elements.find(element => element.tag === 'note').elements[0].content, /^此通知接收人未获飞书远程回复授权/);
  assert.doesNotMatch(JSON.stringify(disabled.payload), /在飞书中引用这条消息回复/);
  const state = await snapshot(ctx.access);
  assert.ok(state.entries[messageKey(ctx.access, USER, 'om_status_0')]);
  assert.equal(state.entries[messageKey(ctx.access, OTHER, 'om_status_1')], undefined);
});
for (const scenario of ['disabled', 'bridge', 'unverified', 'unobserved', 'failed'])
test(`飞书不可回复卡片明确说明原因：${scenario}`, async t => {
  const ctx = await fixture(t);
  const options = {};
  const expected = { disabled: /远程回复尚未启用/, bridge: /回复桥接尚未就绪/,
    unverified: /当前会话无法可靠核验/, unobserved: /输入/, failed: /回复就绪检查未通过/ };
  if (scenario === 'disabled') await atomicJson(policyPath(ctx.file), { ...ctx.policy, enabled: false });
  if (scenario === 'bridge') options.bridge = async () => false;
  if (scenario === 'unverified') options.session = async () => null;
  if (scenario === 'unobserved') await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].tracked = false; });
  if (scenario === 'failed') options.bridge = async () => { throw new Error('FAKE_SECRET'); };
  const { plans } = await dispatchCompletion(ctx, options);
  const item = plans[0].items[0];
  assert.match(item.payload.card.header.title.content, /^⚪ 不可回复｜/);
  assert.match(item.payload.card.elements.find(element => element.tag === 'note').elements[0].content, expected[scenario]);
  assert.doesNotMatch(JSON.stringify(item.payload), /FAKE_SECRET|在飞书中引用这条消息回复/);
  assert.equal(plans[0].onSent, undefined);
});
test('回复渠道为 Telegram 时飞书卡片明确指引去 Telegram，不误标可回复', async t => {
  const ctx = await fixture(t, { ...RAW, telegram: { enabled: true, chat_ids: ['111'] } });
  ctx.env.TELEGRAM_BOT_TOKEN = '123:FAKE';
  const config = parseConfig(ctx.raw, ctx.env);
  await atomicJson(policyPath(ctx.file), { ...ctx.policy, channel: 'telegram', users: ['111'], bot: botKey(config) });
  const access = await accessReplies(ctx.file, ctx.env);
  await stateTransaction(access, state => { state.sessions[TARGET.session] = { ...TARGET, updated: Date.now() }; });
  const { plans } = await dispatchCompletion(ctx, { api: () => async method => {
    assert.equal(method, 'getMe'); return { username: 'FakeTestBot' };
  } });
  const card = plans.find(plan => plan.channel === 'feishu').items[0].payload.card;
  assert.match(card.header.title.content, /^⚪ 不可回复/);
  assert.match(card.elements.find(element => element.tag === 'note').elements[0].content, /当前远程回复渠道为 Telegram/);
  assert.deepEqual((await snapshot(access)).feishuCards ?? {}, {});
});
test('飞书长通知每段标题都有回复状态，正文与每段映射保留', async t => {
  const ctx = await fixture(t);
  const content = '唯一正文片段😀'.repeat(6000);
  const { plans } = await dispatchCompletion(ctx, {}, content);
  assert.ok(plans[0].items.length > 1);
  assert.ok(plans[0].items.every(item => item.payload.card.header.title.content.startsWith('🟡 回复准备中｜')));
  const body = plans[0].items.flatMap(item => item.payload.card.elements.filter(element => element.tag === 'markdown').map(element => element.content)).join('');
  assert.ok(body.includes('唯一正文片段😀'));
  for (let i = 0; i < plans[0].items.length; i++) assert.ok((await snapshot(ctx.access)).entries[messageKey(ctx.access, USER, 'om_status_' + i)]);
});
test('飞书回复状态双语一致，普通等待通知与手动发送不带完成回复状态', async t => {
  const ctx = await fixture(t), previous = getLocale();
  try {
    setLocale('en');
    const { plans } = await dispatchCompletion(ctx);
    assert.match(plans[0].items[0].payload.card.header.title.content, /^🟡 Preparing replies/);
    await atomicJson(policyPath(ctx.file), { ...ctx.policy, enabled: false });
    const disabled = await dispatchCompletion(ctx);
    assert.match(disabled.plans[0].items[0].payload.card.header.title.content, /^⚪ Reply disabled/);
    assert.match(disabled.plans[0].items[0].payload.card.elements.find(element => element.tag === 'note').elements[0].content, /not enabled/);
  } finally { setLocale(previous); }
  const notices = [];
  await dispatchClaudeHook(Buffer.from(JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt',
    session_id: TARGET.session, message: '等待用户处理' })), ctx.file, {
    env: ctx.env, err() {}, send: async plan => { notices.push(plan); return { channel: plan.channel, ok: true, sent: plan.items.length, planned: plan.items.length }; },
  });
  assert.equal(notices.length, 1);
  assert.doesNotMatch(JSON.stringify(notices[0]), /可回复|不可回复/);
  const manual = makePlan('feishu', { title: '手动通知', content: '正文', level: 'info', footer: '' }, ctx.config);
  assert.equal(manual.items[0].payload.card.header.title.content, '手动通知');
});
async function refreshCards(ctx, options = {}, update) {
  const updates = [];
  await refreshFeishuReplyCards(ctx.access, update ?? (async (id, content) => { updates.push({ id, card: JSON.parse(content) }); }), {
    fresh: ctx.context.fresh, inspect: async () => ({ status: 'found', target: TARGET }), now: Date.now() + 60000, ...options,
  });
  return updates;
}
test('实际发送及更新卡片均显式启用共享更新，保留原配置和正文', async t => {
  const ctx = await fixture(t);
  const { plans } = await dispatchCompletion(ctx);
  const payload = plans[0].items[0].payload.card;
  assert.equal(payload.config.update_multi, true);
  assert.equal(payload.config.wide_screen_mode, true);
  const result = await deliverFeishuPlan(plans[0], { sendMessage: async message => {
    const content = JSON.parse(message.content);
    assert.equal(content.config.update_multi, true);
    assert.equal(content.elements[0].content, '测试完成正文');
    return { messageId: 'om_platform_contract' };
  } }, async () => {});
  assert.equal(result.ok, true);
  const updates = await refreshCards(ctx);
  assert.ok(updates.every(update => update.card.config.update_multi === true));
});
test('保存映射并核验后原卡片才变为可回复，映射缺失不能显示绿色', async t => {
  const ctx = await fixture(t); await dispatchCompletion(ctx);
  assert.equal((await snapshot(ctx.access)).feishuCards.om_status_0.status, 'preparing');
  const enabled = await refreshCards(ctx);
  assert.match(enabled[0].card.header.title.content, /^🟢 可回复/);
  assert.equal(enabled[0].card.header.template, 'green');
  await stateTransaction(ctx.access, state => { delete state.entries[messageKey(ctx.access, USER, 'om_status_0')]; });
  const paused = await refreshCards(ctx);
  assert.match(paused[0].card.header.title.content, /^🟡 核验暂停/);
});
test('动态卡片在工作中与恢复空闲时更新原消息，不重发正文或输入', async t => {
  const ctx = await fixture(t);
  await dispatchCompletion(ctx);
  const original = (await snapshot(ctx.access)).feishuCards.om_status_0;
  assert.ok(original); assert.ok(original.expires > Date.now());
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = true; });
  const now = Date.now() + 60000;
  const working = await refreshCards(ctx, { now });
  assert.equal(working.length, 1); assert.equal(working[0].id, 'om_status_0');
  assert.match(working[0].card.header.title.content, /工作中·回复将排队/);
  assert.match(working[0].card.elements.find(element => element.tag === 'note').elements[0].content, /待本轮结束后/);
  assert.equal(working[0].card.elements[0].content, original.card.elements[0].content);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = false; });
  const ready = await refreshCards(ctx, { now: now + 31000 });
  assert.match(ready[0].card.header.title.content, /^🟢 可回复/);
  assert.equal(ctx.inputs.length, 0); assert.equal(ctx.sent.length, 0);
});
test('关联超时后原卡片变为已过期，正文保留且不重复更新终态', async t => {
  const ctx = await fixture(t); await dispatchCompletion(ctx);
  const value = (await snapshot(ctx.access)).feishuCards.om_status_0;
  const updates = await refreshCards(ctx, { now: value.expires + 1, inspect: async () => assert.fail('过期不查进程') });
  assert.match(updates[0].card.header.title.content, /^⚪ 已过期/);
  assert.match(updates[0].card.elements.find(element => element.tag === 'note').elements[0].content, /回复关联已过期/);
  assert.equal((await refreshCards(ctx, { now: value.expires + 60000 })).length, 0);
  assert.equal(ctx.inputs.length, 0);
});
for (const scenario of ['hook-close', 'process-exit', 'switch', 'missing-alive', 'lookup-failed'])
test(`会话状态动态更新且不将核验失败猜成关闭：${scenario}`, async t => {
  const ctx = await fixture(t); await dispatchCompletion(ctx);
  const options = {};
  if (scenario === 'hook-close') await lifecycleHook({ hook_event_name: 'SessionEnd', session_id: TARGET.session }, ctx.file, { env: ctx.env });
  if (scenario === 'process-exit') { options.inspect = async () => ({ status: 'missing' }); options.process = () => 'dead'; }
  if (scenario === 'switch') options.inspect = async () => ({ status: 'found', target: { ...TARGET, birth: 'NEW' } });
  if (scenario === 'missing-alive') { options.inspect = async () => ({ status: 'missing' }); options.process = () => 'alive'; }
  if (scenario === 'lookup-failed') options.inspect = async () => ({ status: 'unavailable' });
  const updates = await refreshCards(ctx, options);
  assert.equal(updates.length, 1);
  assert.match(updates[0].card.header.title.content, scenario === 'switch' ? /会话已切换/
    : scenario === 'hook-close' || scenario === 'process-exit' ? /会话已关闭/ : /核验暂停/);
  assert.equal(ctx.inputs.length, 0);
});
test('核验暂停可恢复，保留卡片发送时语言，长消息共享一次会话查询', async t => {
  const ctx = await fixture(t); const previous = getLocale();
  try {
    setLocale('en'); await dispatchCompletion(ctx, {}, '长正文'.repeat(12000));
    setLocale('zh');
    const now = Date.now() + 60000; let lookups = 0;
    const updates = await refreshCards(ctx, { now, inspect: async () => { lookups++; return { status: 'unavailable' }; } });
    assert.ok(updates.length > 1); assert.equal(lookups, 1);
    assert.ok(updates.every(value => value.card.header.title.content.startsWith('🟡 Verification paused')));
    const resumed = await refreshCards(ctx, { now: now + 31000 });
    assert.ok(resumed.every(value => value.card.header.title.content.startsWith('🟢 Reply enabled')));
    assert.equal(getLocale(), 'zh');
  } finally { setLocale(previous); }
});
test('状态更新失败不重发正文，失败退避，撤权后不修改旧卡片', async t => {
  const ctx = await fixture(t); await dispatchCompletion(ctx);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = true; });
  const now = Date.now() + 60000, logs = []; let attempts = 0;
  const fail = async () => { attempts++; throw new Error('FAKE_SECRET'); };
  await refreshCards(ctx, { now, log: text => logs.push(text) }, fail);
  assert.equal(attempts, 1); assert.doesNotMatch(logs.join(), /FAKE_SECRET/);
  await refreshCards(ctx, { now: now + 1000 }, fail); assert.equal(attempts, 1);
  await refreshCards(ctx, { now: now + 31000 });
  await atomicJson(policyPath(ctx.file), { ...ctx.policy, enabled: false });
  await refreshCards(ctx, { now: now + 62000 }, async () => assert.fail('撤权后不得更新旧卡片'));
  assert.equal(ctx.inputs.length, 0); assert.equal(ctx.sent.length, 0);
});
test('生命周期同终端切换会话会标记旧卡片失效，不改变新会话', async t => {
  const ctx = await fixture(t); await dispatchCompletion(ctx);
  const target = { ...TARGET, session: 'new-session' };
  await lifecycleHook({ hook_event_name: 'SessionStart', session_id: target.session }, ctx.file, { env: ctx.env, session: async () => target });
  const value = (await snapshot(ctx.access)).feishuCards.om_status_0;
  assert.equal(value.invalidated, 'switched');
  const updates = await refreshCards(ctx, { inspect: async () => assert.fail('明确切换不再猜测进程') });
  assert.match(updates[0].card.header.title.content, /会话已切换/);
  assert.ok((await snapshot(ctx.access)).sessions[target.session]);
});
test('动态状态每轮更新有界且活动卡片达到上限时不再误标准备就绪', async t => {
  const ctx = await fixture(t); await dispatchCompletion(ctx);
  await stateTransaction(ctx.access, state => {
    const original = state.feishuCards.om_status_0;
    state.feishuCards = Object.fromEntries(Array.from({ length: 256 }, (_, index) => {
      const message = 'om_fill_' + index;
      state.entries[messageKey(ctx.access, USER, message)] = { ...state.entries[messageKey(ctx.access, USER, 'om_status_0')] };
      return [message, { ...structuredClone(original), message }];
    }));
  });
  const updates = await refreshCards(ctx);
  assert.equal(updates.length, 8);
  const { plans } = await dispatchCompletion(ctx);
  assert.match(plans[0].items[0].payload.card.header.title.content, /^⚪ 不可回复/);
  assert.equal(plans[0].onSent, undefined);
  assert.equal(Object.keys((await snapshot(ctx.access)).feishuCards).length, 256);
});
test('飞书应用配置：环境变量优先且显式空名单撤销，不读取 Webhook 和明文密钥', () => {
  const config = parseConfig(RAW, { FEISHU_APP_ID: APP, FEISHU_APP_SECRET: 'FAKE', FEISHU_WEBHOOK: 'ignored' });
  assert.equal(ready(config, 'feishu'), true); assert.equal(config.feishu.webhook, '');
  assert.deepEqual(parseConfig(RAW, { FEISHU_OPEN_IDS: '' }).feishu.openIds, []);
  assert.equal(ready(parseConfig(RAW, { FEISHU_APP_ID: APP, FEISHU_APP_SECRET: '' }), 'feishu'), false);
  for (const feishu of [{ mode: 'invalid' }, { mode: 'app', app_secret: 'FAKE' }, { mode: 'app', open_ids: ['123'] }]) {
    assert.throws(() => parseConfig({ feishu }, {}));
  }
  const bundle = { feishu_app_id: APP, feishu_app_secret: 'FAKE_SECRET' };
  assert.deepEqual(decodeBundle(encodeBundle(bundle)), bundle);
});
test('飞书向导：应用凭据仅写 keyring 引用，支持重复运行保留凭据', async t => {
  const ctx = await fixture(t);
  await rm(ctx.file);
  const items = new Map();
  const store = { create: (id, values) => items.set(id, values), read: id => items.get(id) ?? null, remove: id => items.delete(id) };
  const output = ui(['2', '2', USER, ''], [APP, 'FAKE_ONLY_SECRET']);
  assert.equal(await wizard(ctx.file, { prompts: output, store, env: {} }), true);
  const raw = await readFile(ctx.file, 'utf8');
  assert.doesNotMatch(raw, /FAKE_ONLY_SECRET|cli_0123456789abcdef/);
  assert.doesNotMatch(output.output.join(), /FAKE_ONLY_SECRET/);
  const saved = JSON.parse(raw);
  assert.equal(saved.feishu.mode, 'app');
  assert.equal(parseConfig(saved, {}, ref => store.read(ref.id)).feishu.appSecret, 'FAKE_ONLY_SECRET');
  assert.equal(await wizard(ctx.file, { prompts: ui(['', '', '', ''], ['', '']), store, env: {} }), true);
  assert.equal(items.size, 1);
});
test('飞书独立授权：只允许名单中 open_id，凭据或名单变化撤销旧路由', async t => {
  const ctx = await fixture(t);
  assert.equal(await configureReplies(ctx.file, ui([USER, 'n']), ctx.env), true);
  const access = await accessReplies(ctx.file, ctx.env);
  assert.equal(access.policy.channel, 'feishu'); assert.equal(access.policy.permissions, false);
  assert.notEqual(access.identity, ctx.access.identity);
  assert.deepEqual((await snapshot(access)).entries, {});
  await assert.rejects(accessReplies(ctx.file, { ...ctx.env, FEISHU_APP_SECRET: 'changed' }));
  await assert.rejects(accessReplies(ctx.file, { ...ctx.env, FEISHU_OPEN_IDS: '' }));
  await assert.rejects(configureReplies(ctx.file, ui([OTHER]), ctx.env));
});
test('双渠道通知保留，但 reply setup 明确选择一个回复渠道', async t => {
  const raw = { ...RAW, telegram: { enabled: true, chat_ids: ['111'] } };
  const ctx = await fixture(t, raw);
  const env = { ...ctx.env, TELEGRAM_BOT_TOKEN: '123:FAKE' };
  assert.equal(await configureReplies(ctx.file, ui(['2', USER, 'n']), env), true);
  assert.equal((await accessReplies(ctx.file, env)).policy.channel, 'feishu');
});
test('入站过滤：拒绝群聊、机器人、未授权、陈旧、非文本和畸形事件', async t => {
  const ctx = await fixture(t);
  const values = [
    value => { value.sender.sender_type = 'app'; },
    value => { value.sender.sender_id.open_id = OTHER; },
    value => { value.message.chat_type = 'group'; },
    value => { value.message.message_type = 'image'; },
    value => { value.message.create_time = String(Date.now() - 301000); },
    value => { value.message.create_time = String(Date.now() + 61000); },
    value => { value.message.content = '{'; },
    value => { value.message.content = '{"text":123}'; },
    value => { value.message.message_id = 'bad:id'; },
    value => { value.event_type = 'card.action.trigger'; },
  ];
  for (const change of values) { const value = event(); change(value); assert.equal(parseFeishuMessage(value, ctx.access), null); await enqueueFeishuMessage(ctx.access, value); }
  assert.deepEqual((await snapshot(ctx.access)).feishuInbox ?? {}, {});
  assert.equal(ctx.inputs.length, 0);
});
test('回调只持久入队：事件 ID 和消息 ID 双重去重，重启后也不能重放', async t => {
  const ctx = await fixture(t), value = event();
  await enqueueFeishuMessage(ctx.access, value);
  assert.equal(ctx.inputs.length, 0); assert.equal(ctx.sent.length, 0);
  await enqueueFeishuMessage(ctx.access, { ...value, event_id: 'other_event' });
  await enqueueFeishuMessage(ctx.access, { ...event('om_other'), event_id: value.event_id });
  assert.equal(Object.keys((await snapshot(ctx.access)).feishuInbox).length, 1);
  await drainFeishuInbox(ctx.access, ctx.context);
  assert.deepEqual(ctx.inputs.map(input => input.text), ['继续']);
  await stateTransaction(ctx.access, state => { delete state.pending[TARGET.session]; });
  await enqueueFeishuMessage(await accessReplies(ctx.file, ctx.env), value);
  await drainFeishuInbox(ctx.access, ctx.context);
  assert.equal(ctx.inputs.length, 1);
  assert.equal((await snapshot(ctx.access)).pending[TARGET.session], undefined);
});
test('飞书入队快速拒绝锁竞争、队列有界，失败不提交去重标记', async t => {
  const ctx = await fixture(t), value = event();
  const lock = path.join(replyDirectory(ctx.file), 'state.lock');
  await writeFile(lock, '测试占用');
  await assert.rejects(enqueueFeishuMessage(ctx.access, value));
  await rm(lock);
  await stateTransaction(ctx.access, state => {
    state.feishuInbox = Object.fromEntries(Array.from({ length: 100 }, (_, i) => {
      const message = parseFeishuMessage(event('om_fill_' + i), ctx.access);
      return [message.id, message];
    }));
  });
  await assert.rejects(enqueueFeishuMessage(ctx.access, value));
  await stateTransaction(ctx.access, state => { state.feishuInbox = {}; });
  await enqueueFeishuMessage(ctx.access, value);
  assert.equal(Object.keys((await snapshot(ctx.access)).feishuInbox).length, 1);
});
test('飞书过期收件箱正文会清理，不在后续会话重放', async t => {
  const ctx = await fixture(t);
  await stateTransaction(ctx.access, state => {
    state.feishuInbox = { om_old: { ...parseFeishuMessage(event('om_old'), ctx.access), created: Date.now() - 301000 } };
  });
  await drainFeishuInbox(ctx.access, ctx.context);
  assert.deepEqual((await snapshot(ctx.access)).feishuInbox, {});
  assert.equal(ctx.inputs.length, 0);
});
test('飞书引用路由：不猜测未引用或他人消息，不接收 Telegram 更新', async t => {
  const ctx = await fixture(t);
  const missing = event('om_missing'); delete missing.message.parent_id;
  await receive(ctx, missing);
  await receive(ctx, event('om_unknown', '继续', 'om_other_notice'));
  await stateTransaction(ctx.access, state => { state.entries[messageKey(ctx.access, OTHER, 'om_other')] = { session: TARGET.session, epoch: targetEpoch(TARGET), updated: Date.now() }; });
  await receive(ctx, event('om_cross_user', '继续', 'om_other'));
  await processUpdate(ctx.access, { update_id: 1, message: { text: '伪造', message_id: 2 } }, ctx.context);
  assert.equal(ctx.inputs.length, 0);
});
test('完成通知映射每段飞书消息且不创建 Telegram 按钮，回执关联 UserPromptSubmit', async t => {
  const ctx = await fixture(t), message = { title: '完成', content: '正文'.repeat(10000), footer: '', level: 'info' };
  const binding = await attachReply(message, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file,
    { env: ctx.env, session: async () => TARGET, bridge: async () => true, api: () => assert.fail('不应查询 Telegram 身份') });
  assert.ok(binding); assert.equal(message.reply, undefined);
  const plan = makePlan('feishu', message, ctx.config); mapReplies(plan, binding);
  assert.ok(plan.items.length > 1); assert.ok(plan.items.every(item => item.recipient === USER));
  assert.ok(plan.items.every(item => !JSON.stringify(item.payload).includes('t.me')));
  const result = await deliverFeishuPlan(plan, ctx.client, async () => {});
  assert.equal(result.ok, true);
  const state = await snapshot(ctx.access);
  assert.ok(state.entries[messageKey(ctx.access, USER, 'om_sent_1')]);
  await receive(ctx, event('om_continue', '下一步', 'om_sent_1'));
  assert.equal(ctx.inputs[0].text, '下一步');
  await lifecycleHook({ hook_event_name: 'UserPromptSubmit', session_id: TARGET.session, prompt: '下一步' }, ctx.file,
    { env: ctx.env, session: async () => TARGET, api: () => ctx.api });
  assert.equal((await snapshot(ctx.access)).pending[TARGET.session], undefined);
  assert.ok(ctx.sent.some(message => JSON.parse(message.content).text?.includes('已收到')));
});
test('飞书工作中排队、新本地输入取消、失效目标不注入', async t => {
  const ctx = await fixture(t);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = true; });
  await receive(ctx, event()); assert.equal(ctx.inputs.length, 0);
  assert.equal((await snapshot(ctx.access)).pending[TARGET.session].phase, 'queued');
  await lifecycleHook({ hook_event_name: 'UserPromptSubmit', session_id: TARGET.session, prompt: '本地输入' }, ctx.file,
    { env: ctx.env, session: async () => TARGET, api: () => ctx.api });
  assert.equal((await snapshot(ctx.access)).pending[TARGET.session], undefined);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = false; });
  ctx.context.validate = async () => false;
  await receive(ctx, event('om_stale_target'));
  assert.equal(ctx.inputs.length, 0);
});
test('未知输入结果及 HTTP 结果都不自动重试，状态正文不保留', async t => {
  const ctx = await fixture(t);
  let calls = 0;
  ctx.context.inject = async () => { calls++; throw new Error('FAKE_SECRET'); };
  await receive(ctx, event()); await drainReplies(ctx.access, ctx.context);
  const pending = (await snapshot(ctx.access)).pending[TARGET.session];
  assert.equal(calls, 1); assert.equal(pending.phase, 'unknown'); assert.equal(pending.text, undefined);
  let sends = 0;
  const api = feishuReplyApi(ctx.config, { ...ctx.client, sendMessage: async () => { sends++; throw new Error('FAKE_SECRET'); } });
  await assert.rejects(api('sendMessage', { chat_id: USER, text: '测试' }), error => !error.message.includes('FAKE_SECRET'));
  assert.equal(sends, 1);
});
async function boundFeishuQuestion(ctx, questions = [QUESTION]) {
  await registerToolCall(ctx.access, TARGET, { tool_use_id: 'feishu-question-call', tool_name: 'AskUserQuestion', tool_input: { questions } });
  return createInteraction(ctx.access, TARGET, 'question', { questions }, callKey(TARGET.session, 'feishu-question-call'));
}
async function dispatchPermissionReminder(ctx, extra = {}, reply = {}) {
  const plans = [];
  await dispatchClaudeHook(Buffer.from(JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt',
    session_id: TARGET.session, message: 'Claude needs your permission', ...extra })), ctx.file, {
    env: ctx.env, err() {}, reply: { session: async () => TARGET, ...reply },
    send: async plan => { plans.push(plan); return { ok: true, channel: plan.channel, sent: plan.items.length, planned: plan.items.length }; },
  });
  return plans;
}
const feishuRecipients = plans => plans.filter(plan => plan.channel === 'feishu').flatMap(plan => plan.items.map(item => item.recipient));
test('飞书已投递题目按接收人去重通用提醒，未授权接收人仍收到明确不可回答的兜底', async t => {
  const ctx = await fixture(t, { ...RAW, feishu: { ...RAW.feishu, open_ids: [USER, OTHER] } });
  const request = await boundFeishuQuestion(ctx);
  await showInteraction(ctx.access, request.id, USER, ctx.api);
  const plans = await dispatchPermissionReminder(ctx);
  assert.deepEqual(feishuRecipients(plans), [OTHER]);
  assert.match(plans[0].items[0].payload.card.header.title.content, /通用权限提醒/);
  assert.match(JSON.stringify(plans[0].items[0].payload.card), /不能引用作答/);
  assert.deepEqual((await snapshot(ctx.access)).requests[request.id].notified.feishuUsers, [USER]);
});
test('飞书题目送达后临时核验暂停也不重复发送通用提醒，但不能因此执行答案', async t => {
  const ctx = await fixture(t), request = await boundFeishuQuestion(ctx);
  await showInteraction(ctx.access, request.id, USER, ctx.api);
  assert.deepEqual(await dispatchPermissionReminder(ctx, {}, { sessionLookup: async () => ({ status: 'unavailable' }) }), []);
  assert.equal((await snapshot(ctx.access)).sessions[TARGET.session].unverified, true);
  ctx.context.validate = async () => { throw new SessionLookupError(); };
  await receive(ctx, event('om_paused_question', '1', 'om_sent_1'));
  assert.equal((await snapshot(ctx.access)).requests[request.id].response, undefined);
});
for (const scenario of ['missing', 'send-failed', 'mapping-failed', 'partial', 'retry-failed', 'expired', 'different-call', 'parallel', 'disabled'])
test(`飞书不能用未投递或其他题目吞掉通用权限提醒：${scenario}`, async t => {
  const ctx = await fixture(t);
  const questions = scenario === 'partial' ? [{ ...QUESTION, question: '长题'.repeat(3000) }] : [QUESTION];
  const request = await boundFeishuQuestion(ctx, questions);
  if (['expired', 'different-call', 'parallel', 'disabled', 'retry-failed'].includes(scenario)) await showInteraction(ctx.access, request.id, USER, ctx.api);
  if (scenario === 'send-failed' || scenario === 'retry-failed') await assert.rejects(showInteraction(ctx.access, request.id, USER, async () => { throw new Error('FAKE_ONLY'); }));
  if (scenario === 'mapping-failed') await assert.rejects(showInteraction(ctx.access, request.id, USER, async () => ({})));
  if (scenario === 'partial') {
    let count = 0;
    const api = feishuReplyApi(ctx.config, { sendMessage: async message => {
      if (++count > 1) throw new Error('FAKE_ONLY'); return ctx.client.sendMessage(message);
    } });
    await assert.rejects(showInteraction(ctx.access, request.id, USER, api));
    assert.equal(count, 2);
  }
  if (scenario === 'expired') await stateTransaction(ctx.access, state => { state.requests[request.id].expires = Date.now() - 1; });
  if (scenario === 'parallel') await registerToolCall(ctx.access, TARGET, { tool_use_id: 'parallel', tool_name: 'Bash', tool_input: { command: 'pwd' } });
  if (scenario === 'disabled') await atomicJson(policyPath(ctx.file), { ...ctx.policy, enabled: false });
  assert.deepEqual(feishuRecipients(await dispatchPermissionReminder(ctx, scenario === 'different-call' ? { tool_use_id: 'different' } : {})), [USER]);
});
test('飞书核验暂停期间观察到新工具后清除旧题覆盖，不吞掉新权限提醒', async t => {
  const ctx = await fixture(t), request = await boundFeishuQuestion(ctx);
  await showInteraction(ctx.access, request.id, USER, ctx.api);
  const paused = { sessionLookup: async () => ({ status: 'unavailable' }) };
  assert.deepEqual(await dispatchPermissionReminder(ctx, {}, paused), []);
  await interactionHook({ hook_event_name: 'PreToolUse', session_id: TARGET.session, tool_use_id: 'paused-bash', tool_name: 'Bash', tool_input: { command: 'pwd' } }, ctx.file,
    { env: ctx.env, api: () => assert.fail('不能联网'), bridge: async () => assert.fail('不能启动桥接') });
  const state = await snapshot(ctx.access);
  assert.equal(state.sessions[TARGET.session].latestCall, undefined);
  assert.equal(Object.values(state.calls).some(call => call.id === 'paused-bash'), false);
  assert.deepEqual(feishuRecipients(await dispatchPermissionReminder(ctx, {}, paused)), [USER]);
});
test('飞书题目发送期间保留兜底，发送与关联均成功后才去重', async t => {
  const ctx = await fixture(t), request = await boundFeishuQuestion(ctx);
  await showInteraction(ctx.access, request.id, USER, async (method, payload) => {
    assert.deepEqual(feishuRecipients(await dispatchPermissionReminder(ctx)), [USER]);
    return ctx.api(method, payload);
  });
  assert.deepEqual(await dispatchPermissionReminder(ctx), []);
});
test('完整PermissionRequest链路：无需工具批准权，题目去重后可恢复引用并仅回传官方JSON', async t => {
  const ctx = await fixture(t);
  await atomicJson(policyPath(ctx.file), { ...ctx.policy, permissions: false });
  ctx.access = await accessReplies(ctx.file, ctx.env);
  const data = { session_id: TARGET.session, tool_use_id: 'full-question', tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION] } };
  let response;
  const options = { env: ctx.env, session: async () => TARGET, bridge: async () => true, api: () => ctx.api,
    response: value => { response = value; },
    wait: async (access, request, fresh) => {
      assert.deepEqual(await dispatchPermissionReminder(ctx, {}, { sessionLookup: async () => ({ status: 'unavailable' }) }), []);
      const state = await snapshot(ctx.access);
      const parent = state.requests[request.id].messages.find(message => message.chat === USER).message;
      assert.equal(state.sessions[TARGET.session].unverified, true);
      await receive(ctx, event('om_full_answer', '1', parent));
      return waitInteraction(access, request, fresh, { timeout: 100 });
    } };
  await interactionHook({ ...data, hook_event_name: 'PreToolUse' }, ctx.file, options);
  await interactionHook({ ...data, hook_event_name: 'PermissionRequest' }, ctx.file, options);
  assert.equal(response?.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(response?.hookSpecificOutput.decision.updatedInput.answers[QUESTION.question], 'React');
  assert.equal(ctx.inputs.length, 0);
});
test('题目发出后Notification临时核验失败，原题在真实核验恢复后可直接作答', async t => {
  const ctx = await fixture(t);
  const request = await boundFeishuQuestion(ctx);
  await showInteraction(ctx.access, request.id, USER, ctx.api);
  await lifecycleHook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: TARGET.session }, ctx.file,
    { env: ctx.env, sessionLookup: async () => ({ status: 'unavailable' }) });
  assert.equal((await snapshot(ctx.access)).sessions[TARGET.session].unverified, true);
  let validated = 0;
  ctx.context.validate = async target => { validated++; assert.notEqual(target.unverified, true); return targetEpoch(target) === targetEpoch(TARGET); };
  await receive(ctx, event('om_recovered_answer', '1', 'om_sent_1'));
  const response = await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
  assert.equal(response?.hookSpecificOutput.decision.updatedInput.answers[QUESTION.question], 'React');
  assert.equal(validated, 1);
  assert.equal((await snapshot(ctx.access)).sessions[TARGET.session].unverified, undefined);
  assert.equal(ctx.inputs.length, 0);
});
for (const verification of ['matched', 'background', 'birth', 'tty', 'pid'])
test(`Mac结构化问答恢复仍核对进程身份与前台组：${verification}`, async t => {
  const ctx = await fixture(t), target = { ...TARGET, birth: 'Mon Nov 9 14:00:00 2026', tty: '/dev/ttys001' };
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session] = { ...target, updated: Date.now() }; });
  const request = await createInteraction(ctx.access, target, 'question', { questions: [QUESTION] });
  await showInteraction(ctx.access, request.id, USER, ctx.api);
  await lifecycleHook({ hook_event_name: 'Notification', session_id: TARGET.session }, ctx.file,
    { env: ctx.env, sessionLookup: async () => ({ status: 'unavailable' }) });
  const pid = verification === 'pid' ? TARGET.pid + 1 : TARGET.pid;
  ctx.context.validate = value => validateTarget(value, { platform: 'darwin', strict: true,
    readDirectory: async () => [String(pid) + '.json'],
    readSessionFile: async () => Buffer.from(JSON.stringify({ sessionId: TARGET.session, pid })),
    runner: async (command, args) => {
      assert.equal(command, '/bin/ps');
      const birth = verification === 'birth' ? 'Mon Nov 9 15:00:00 2026' : target.birth;
      const tty = verification === 'tty' ? 'ttys002' : 'ttys001';
      return { code: 0, stdout: args.includes('lstart=') ? `${birth} ${tty} claude` : verification === 'background' ? '12345 99999' : '12345 12345' };
    } });
  await receive(ctx, event('om_mac_answer', '2', 'om_sent_1'));
  const state = await snapshot(ctx.access);
  assert.equal(state.requests[request.id].answers[QUESTION.question], verification === 'matched' ? 'Vue' : undefined);
  assert.equal(state.sessions[TARGET.session].unverified, verification === 'matched' ? undefined : true);
  assert.equal(ctx.inputs.length, 0);
});
for (const reason of ['unavailable', 'changed', 'expired', 'closed', 'race', 'newer-verification', 'claimed', 'call-ended', 'revoked'])
test(`问答恢复不得绕过身份或请求状态：${reason}`, async t => {
  const ctx = await fixture(t), request = await boundFeishuQuestion(ctx);
  await showInteraction(ctx.access, request.id, USER, ctx.api);
  await lifecycleHook({ hook_event_name: 'Notification', session_id: TARGET.session }, ctx.file,
    { env: ctx.env, sessionLookup: async () => ({ status: 'unavailable' }) });
  ctx.context.validate = async () => {
    if (reason === 'unavailable') throw new SessionLookupError();
    if (reason === 'changed') return false;
    if (reason === 'race') await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].birth = 'OTHER_PROCESS'; });
    if (reason === 'newer-verification') await lifecycleHook({ hook_event_name: 'Notification', session_id: TARGET.session }, ctx.file,
      { env: ctx.env, sessionLookup: async () => ({ status: 'unavailable' }) });
    if (reason === 'revoked') await atomicJson(policyPath(ctx.file), { ...ctx.policy, enabled: false });
    return true;
  };
  if (reason === 'expired') await stateTransaction(ctx.access, state => { state.requests[request.id].expires = Date.now() - 1; });
  if (reason === 'closed') await lifecycleHook({ hook_event_name: 'SessionEnd', session_id: TARGET.session }, ctx.file, { env: ctx.env });
  if (reason === 'claimed') await stateTransaction(ctx.access, state => { state.requests[request.id].claimed = true; });
  if (reason === 'call-ended') await stateTransaction(ctx.access, state => { state.calls[request.call].ended = true; });
  await receive(ctx, event('om_blocked_answer', '1', 'om_sent_1'));
  if (reason === 'revoked') await atomicJson(policyPath(ctx.file), ctx.policy);
  const state = await snapshot(ctx.access);
  assert.equal(state.requests[request.id].response, undefined);
  assert.deepEqual(state.requests[request.id].answers, {});
  if (['expired', 'claimed', 'call-ended'].includes(reason)) {
    assert.ok(ctx.sent.some(value => JSON.parse(value.content).text?.includes('交互已经失效')));
    assert.ok(!ctx.sent.some(value => JSON.parse(value.content).text?.includes('不代表题目已过期')));
  }
  assert.equal(ctx.inputs.length, 0);
});
test('问答暂停恢复不放开普通终端输入，且错误提示区分关联缺失与核验暂停', async t => {
  const ctx = await fixture(t), request = await createInteraction(ctx.access, TARGET, 'question', { questions: [QUESTION] });
  await showInteraction(ctx.access, request.id, USER, ctx.api);
  await lifecycleHook({ hook_event_name: 'Notification', session_id: TARGET.session }, ctx.file,
    { env: ctx.env, sessionLookup: async () => ({ status: 'unavailable' }) });
  await receive(ctx, event('om_plain_paused', '普通任务', 'om_notice'));
  assert.equal(ctx.inputs.length, 0);
  assert.ok(ctx.sent.some(value => JSON.parse(value.content).text?.includes('不代表题目已过期')));
  await receive(ctx, event('om_unmapped', '1', 'om_unknown_notice'));
  assert.ok(ctx.sent.some(value => JSON.parse(value.content).text?.includes('会话关联缺失')));
  assert.equal((await snapshot(ctx.access)).sessions[TARGET.session].unverified, true);
  ctx.context.validate = async () => true;
  await receive(ctx, event('om_original_question', '1', 'om_sent_1'));
  assert.equal((await snapshot(ctx.access)).requests[request.id].answers[QUESTION.question], 'React');
});
test('飞书问题按引用逐题回答，支持多选编号和自定义答案，旧题不能重放', async t => {
  const ctx = await fixture(t);
  const request = await createInteraction(ctx.access, TARGET, 'question', { questions: [QUESTION, { ...QUESTION, question: '多选？', multiSelect: true }] });
  await showInteraction(ctx.access, request.id, USER, ctx.api);
  await receive(ctx, event('om_answer1', '2', 'om_sent_1'));
  let state = await snapshot(ctx.access);
  assert.equal(state.requests[request.id].answers[QUESTION.question], 'Vue');
  const second = state.requests[request.id].messages.at(-1).message;
  await receive(ctx, event('om_old_answer', '1', 'om_sent_1'));
  assert.equal((await snapshot(ctx.access)).requests[request.id].index, 1);
  await receive(ctx, event('om_invalid_answer', '9', second));
  assert.equal((await snapshot(ctx.access)).requests[request.id].index, 1);
  await receive(ctx, event('om_answer2', '1,2', second));
  const response = await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
  assert.deepEqual(response.hookSpecificOutput.decision.updatedInput.answers, { [QUESTION.question]: 'Vue', '多选？': 'React,Vue' });
  assert.equal(ctx.inputs.length, 0);
  const custom = await createInteraction(ctx.access, TARGET, 'question', { questions: [QUESTION] });
  await showInteraction(ctx.access, custom.id, USER, ctx.api);
  const parent = (await snapshot(ctx.access)).requests[custom.id].messages.at(-1).message;
  await receive(ctx, event('om_custom_answer', '自定义', parent));
  assert.equal((await snapshot(ctx.access)).requests[custom.id].answers[QUESTION.question], '自定义');
});
test('飞书权限只能显式一次授权，其他文字拒绝，/close 不执行决定', async t => {
  for (const [text, behavior] of [['/allow', 'allow'], ['/deny', 'deny'], ['请一直允许', 'deny'], ['/close', null]]) {
    const ctx = await fixture(t), request = await createInteraction(ctx.access, TARGET, 'permission', { tool_name: 'Bash', tool_input: { command: 'pwd' } });
    await showInteraction(ctx.access, request.id, USER, ctx.api);
    await receive(ctx, event('om_decision', text, 'om_sent_1'));
    const actual = (await snapshot(ctx.access)).requests[request.id];
    assert.equal(actual.response?.hookSpecificOutput.decision.behavior ?? null, behavior);
    if (text === '/close') assert.equal(actual.result.kind, 'not-applied');
    assert.equal(ctx.inputs.length, 0);
  }
});
test('飞书权限未 opt-in、会话变更或授权撤销时不接受远程批准', async t => {
  const ctx = await fixture(t);
  await enqueueFeishuMessage(ctx.access, event());
  await atomicJson(policyPath(ctx.file), { ...ctx.policy, permissions: false });
  const access = await accessReplies(ctx.file, ctx.env);
  await assert.rejects(createInteraction(access, TARGET, 'permission', { tool_name: 'Bash' }));
  // 队列旧身份不能绕过最新授权。
  await drainFeishuInbox(ctx.access, ctx.context);
  assert.equal(ctx.inputs.length, 0);
});
test('飞书 PermissionRequest hook 使用官方结构化输出，不尝试 Telegram 或终端注入', async t => {
  const ctx = await fixture(t);
  const data = { session_id: TARGET.session, tool_use_id: 'question_1', tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION] } };
  const options = { env: ctx.env, session: async () => TARGET, api: () => ctx.api, bridge: async () => true };
  await interactionHook({ ...data, hook_event_name: 'PreToolUse' }, ctx.file, options);
  let response;
  await interactionHook({ ...data, hook_event_name: 'PermissionRequest' }, ctx.file, { ...options,
    wait: async (access, value, fresh, waitOptions) => {
      const parent = (await snapshot(access)).requests[value.id].messages.at(-1).message;
      await receive(ctx, event('om_hook_answer', '1', parent));
      return waitInteraction(access, value, fresh, { ...waitOptions, timeout: 100 });
    }, response: value => { response = value; } });
  assert.equal(response.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(response.hookSpecificOutput.decision.updatedInput.answers[QUESTION.question], 'React');
  assert.equal(ctx.inputs.length, 0);
});
test('飞书桥接等待真实 ready、持久入队后消费、更新租约并停止连接', async t => {
  const ctx = await fixture(t);
  let closed = 0, started = 0, checked = false;
  const factory = (credentials, options) => createFeishuClient(credentials, { ...options, adapterFactory: () => ({
    start: async handlers => { started++; handlers.onReady(); await handlers.onMessage(event()); },
    close: () => { closed++; },
    sendMessage: async message => ({ code: 0, data: { message_id: (await ctx.client.sendMessage(message)).messageId } }),
    replyMessage: async (id, message) => ({ code: 0, data: { message_id: (await ctx.client.replyMessage(id, message)).messageId } }),
  }) });
  await runBridge(ctx.file, { env: ctx.env, feishuFactory: factory, validate: ctx.context.validate, inject: ctx.context.inject,
    maxIterations: 1, sleep: async () => { checked = true; assert.equal((await bridgeStatus(ctx.file)).ready, true); } });
  assert.equal(started, 1); assert.equal(closed, 1); assert.equal(checked, true);
  assert.equal(ctx.inputs.length, 1); assert.equal((await bridgeStatus(ctx.file)).running, false);
});
test('切换回复授权后，旧桥接租约不能冒充新渠道 ready 或产生第二消费者', async t => {
  const ctx = await fixture(t), lease = path.join(replyDirectory(ctx.file), 'bridge.json');
  await atomicJson(lease, { pid: process.pid, owner: 'b'.repeat(32), ready: true, updated: Date.now(), identity: 'OLD_IDENTITY' });
  assert.equal((await bridgeStatus(ctx.file, ctx.access)).ready, false);
  assert.equal(await startBridge(ctx.file, ctx.env, { spawn: () => assert.fail('不能启动第二消费者') }), false);
  await atomicJson(lease, { pid: process.pid, owner: 'b'.repeat(32), ready: true, updated: Date.now() });
  assert.equal((await bridgeStatus(ctx.file, ctx.access)).ready, false);
});
test('桥接周期检查会调用 core 更新原卡片，不创建新通知', async t => {
  const ctx = await fixture(t); await dispatchCompletion(ctx);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = true; });
  const updates = []; let closed = false;
  const factory = () => ({ state: 'connected', start: async () => {}, stop: () => { closed = true; },
    sendMessage: async () => assert.fail('不应发送新通知'), replyMessage: async () => assert.fail('不应发送回复'),
    updateMessage: async (id, content) => { updates.push({ id, content: JSON.parse(content) }); } });
  await runBridge(ctx.file, { env: ctx.env, feishuFactory: factory, cardInspect: async () => ({ status: 'found', target: TARGET }),
    maxIterations: 1, sleep: async () => {} });
  assert.equal(updates.length, 1); assert.equal(updates[0].id, 'om_status_0');
  assert.match(updates[0].content.header.title.content, /工作中/); assert.equal(closed, true);
});
test('飞书桥接连接失败清理资源且不报告 ready，错误不包含凭据', async t => {
  const ctx = await fixture(t); let closed = 0;
  const factory = (credentials, options) => createFeishuClient(credentials, { ...options, adapterFactory: () => ({
    start: handlers => { handlers.onError(); }, close: () => { closed++; },
    sendMessage: async () => assert.fail(), replyMessage: async () => assert.fail(),
  }) });
  await assert.rejects(runBridge(ctx.file, { env: ctx.env, feishuFactory: factory }), error => !error.message.includes('FAKE_ONLY_SECRET'));
  assert.equal((await bridgeStatus(ctx.file)).ready, false); assert.ok(closed >= 1);
});
test('飞书消息规划复用 core 分段，部分失败只跳过该接收人且不重发', async t => {
  const ctx = await fixture(t), config = { ...ctx.config, feishu: { ...ctx.config.feishu, openIds: [USER, OTHER] } };
  const plan = makePlan('feishu', { title: '测试', content: '长内容'.repeat(20000), level: 'info', footer: '' }, config);
  const seen = []; let first = true;
  const result = await deliverFeishuPlan(plan, { sendMessage: async message => {
    seen.push(message.receiveId);
    if (first) { first = false; throw new Error('FAKE_SECRET'); }
    return { messageId: 'om_out' };
  } }, async () => {});
  assert.equal(result.ok, false); assert.equal(seen.filter(user => user === USER).length, 1);
  assert.equal(seen.filter(user => user === OTHER).length, plan.items.filter(item => item.recipient === OTHER).length);
  assert.ok(!result.error.includes('FAKE_SECRET'));
});
