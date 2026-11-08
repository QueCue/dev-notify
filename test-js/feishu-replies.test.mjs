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
  assert.equal(await configureReplies(ctx.file, ui([USER, 'n', 'y']), ctx.env), true);
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
  assert.equal(await configureReplies(ctx.file, ui(['2', USER, 'n', 'y']), env), true);
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
