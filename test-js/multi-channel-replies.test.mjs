import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configureClaudeCode } from '../dist/claude-code.js';
import { parseConfig, appPaths } from '../dist/config.js';
import { atomicJson, accessReplies, botKey, channelAccess, replyAccesses, configureReplies, disableReplies, policyPath, stateTransaction, targetEpoch, messageKey, replyDirectory, digest } from '../dist/reply-state.js';
import { replyApi } from '../dist/reply-api.js';
import { feishuReplyApi, enqueueFeishuMessage } from '../dist/reply-feishu.js';
import { processUpdate, drainFeishuInbox, drainReplies } from '../dist/reply-engine.js';
import { createInteraction, showInteraction, waitInteraction } from '../dist/reply-interactions.js';
import { callKey, registerToolCall, drainInteractionFeedback, finishInteraction } from '../dist/reply-outcomes.js';
import { dispatchClaudeHook } from '../dist/claude-hook.js';
import { lifecycleHook, interactionHook } from '../dist/reply-hooks.js';
import { runBridge, bridgeStatus } from '../dist/reply-bridge.js';
import { acquireBotLock } from '../dist/reply-lock.js';
import { getLocale, setLocale } from '../dist/i18n.js';

globalThis.fetch = async () => { throw new Error('禁止真实网络'); };
const USER = 'ou_FAKE_USER';
const TARGET = { session: 'dual-session', pid: 12345, birth: 'FAKE_BIRTH', tty: 'FAKE_TTY', title: '双渠道隔离测试', cwd: 'C:/fake', tracked: true, working: false, updated: Date.now() };
const QUESTION = { question: '选哪个？', header: '选择', options: [{ label: 'A', description: '选项A' }, { label: 'B', description: '选项B' }] };
function ui(answers = []) { const output = [], questions = []; return { output, questions, out: text => output.push(text), secret: async () => assert.fail('不询问凭据'),
  text: async prompt => { questions.push(prompt); assert.ok(answers.length, '意外询问'); return answers.shift(); } }; }
async function fixture(t, permissions = { telegram: true, feishu: true }) {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-dual-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json'), env = { DEV_NOTIFY_HOME: path.join(root, 'data'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    TELEGRAM_BOT_TOKEN: '123:FAKE_TOKEN', FEISHU_APP_ID: 'cli_0123456789abcdef', FEISHU_APP_SECRET: 'FAKE_SECRET' };
  const raw = { telegram: { chat_ids: ['111', '222'] }, feishu: { mode: 'app', open_ids: [USER, 'ou_OTHER'] } };
  await atomicJson(file, raw); await configureClaudeCode(file, 'install', ui(['y']), { env });
  const config = parseConfig(raw, env), policy = { version: 2, enabled: true, generation: 'a'.repeat(32), channels: {
    telegram: { bot: botKey(config), users: ['111'], permissions: permissions.telegram },
    feishu: { bot: botKey(config, 'feishu'), users: [USER], permissions: permissions.feishu },
  } };
  await atomicJson(policyPath(file), policy);
  const access = await accessReplies(file, env), tg = channelAccess(access, 'telegram'), fs = channelAccess(access, 'feishu');
  const telegram = [], feishu = [], inputs = [];
  let tgId = 1000, fsId = 0;
  const tgApi = async (method, payload) => { telegram.push({ method, payload });
    if (method === 'getMe') return { username: 'FakeTestBot' };
    if (method === 'sendMessage') return { message_id: ++tgId };
    if (method === 'getUpdates') return [];
    return {};
  };
  const client = { sendMessage: async message => { feishu.push(message); return { messageId: 'om_sent_' + ++fsId }; },
    replyMessage: async (id, message) => { feishu.push({ replyTo: id, ...message }); return { messageId: 'om_sent_' + ++fsId }; } };
  const fsApi = feishuReplyApi(config, client), factory = view => view.policy.channel === 'feishu' ? fsApi : tgApi;
  const api = replyApi(access, factory);
  const context = view => ({ api, fresh: async () => { const current = await accessReplies(file, env); return current && view ? channelAccess(current, view.policy.channel) : current; },
    validate: async () => true, inject: async (_target, text) => inputs.push(text) });
  await stateTransaction(access, state => {
    state.sessions[TARGET.session] = { ...TARGET, updated: Date.now() };
    const entry = { session: TARGET.session, epoch: targetEpoch(TARGET), updated: Date.now() };
    state.entries['tg:111:100'] = entry; state.entries[`fs:${USER}:om_notice`] = entry;
  });
  return { root, file, env, raw, config, policy, access, tg, fs, telegram, feishu, inputs, api, factory, tgApi, fsApi, client, context };
}
const snapshot = ctx => stateTransaction(ctx.access, state => structuredClone(state));
const tgMessage = (id, text, replyTo = 100) => ({ update_id: id, message: { message_id: id + 10000, date: Math.floor(Date.now() / 1000), text,
  from: { id: 111 }, chat: { id: 111, type: 'private' }, reply_to_message: { message_id: replyTo } } });
const fsMessage = (id, text, parent = 'om_notice') => ({ event_id: 'evt_' + id, sender: { sender_type: 'user', sender_id: { open_id: USER } },
  message: { message_id: id, chat_id: 'oc_private', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }), create_time: String(Date.now()), parent_id: parent } });
async function receiveFs(ctx, message) { await enqueueFeishuMessage(ctx.fs, message); await drainFeishuInbox(ctx.fs, ctx.context(ctx.fs)); }

for (const delivered of ['telegram', 'feishu', 'both'])
test(`双渠道通用提醒只对已送达题目的渠道与接收人去重：${delivered}`, async t => {
  const ctx = await fixture(t);
  await registerToolCall(ctx.access, TARGET, { tool_use_id: 'question-call', tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION] } });
  const request = await createInteraction(ctx.access, TARGET, 'question', { questions: [QUESTION] }, callKey(TARGET.session, 'question-call'));
  if (delivered !== 'feishu') await showInteraction(ctx.tg, request.id, '111', ctx.api);
  if (delivered !== 'telegram') await showInteraction(ctx.fs, request.id, USER, ctx.api);
  const plans = [];
  await dispatchClaudeHook(Buffer.from(JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt', session_id: TARGET.session })), ctx.file, {
    env: ctx.env, err() {}, reply: { session: async () => TARGET },
    send: async plan => { plans.push(plan); return { ok: true, channel: plan.channel, sent: plan.items.length, planned: plan.items.length }; },
  });
  assert.deepEqual(plans.filter(plan => plan.channel === 'telegram').flatMap(plan => plan.items.map(item => item.recipient)), delivered === 'feishu' ? ['111', '222'] : ['222']);
  assert.deepEqual(plans.filter(plan => plan.channel === 'feishu').flatMap(plan => plan.items.map(item => item.recipient)), delivered === 'telegram' ? [USER, 'ou_OTHER'] : ['ou_OTHER']);
});
test('reply setup 逐渠道询问工具权限，答完直接保存不再汇总确认', async t => {
  const ctx = await fixture(t), prompts = ui(['3', '111', 'n', USER, 'y']);
  assert.equal(await configureReplies(ctx.file, prompts, ctx.env), true);
  const access = await accessReplies(ctx.file, ctx.env), views = replyAccesses(access);
  assert.equal(views.length, 2); assert.equal(views[0].policy.permissions, false); assert.equal(views[1].policy.permissions, true);
  assert.equal(views[0].identity, views[1].identity); assert.equal(views[0].file, views[1].file);
  assert.deepEqual(views.map(view => view.policy.users), [['111'], [USER]]);
  assert.notEqual(access.identity, ctx.access.identity);
  assert.equal(prompts.questions.length, 5);
  assert.equal(prompts.questions.filter(prompt => prompt.includes('逐次批准或拒绝工具权限')).length, 2);
  assert.doesNotMatch(prompts.questions.join('\n'), /确认启用远程回复/);
});
for (const [name, selection, expectedChannels] of [['TG', '1', ['telegram']], ['飞书', '2', ['feishu']], ['双渠道', '3', ['telegram', 'feishu']]])
test(`${name}工具权限回车默认关闭，未再次确认也能保存回复授权`, async t => {
  const ctx = await fixture(t);
  const answers = selection === '3' ? ['3', '111', '', USER, ''] : selection === '1' ? ['1', '111', ''] : ['2', USER, ''];
  const prompts = ui(answers);
  assert.equal(await configureReplies(ctx.file, prompts, ctx.env), true);
  const access = await accessReplies(ctx.file, ctx.env);
  assert.deepEqual(replyAccesses(access).map(view => view.policy.channel ?? 'telegram'), expectedChannels);
  assert.ok(replyAccesses(access).every(view => view.policy.permissions === false));
  assert.equal(prompts.questions.length, selection === '3' ? 5 : 3);
  assert.equal(prompts.questions.filter(prompt => prompt.includes('逐次批准或拒绝工具权限')).length, expectedChannels.length);
});
test('双渠道配置中途取消或中断仍不保存任何部分授权', async t => {
  const ctx = await fixture(t), prompts = ui(['3', '111', 'y', USER]);
  const original = prompts.text;
  prompts.text = async prompt => {
    if (prompts.questions.length === 4) throw new Error('模拟用户中断');
    return original(prompt);
  };
  await assert.rejects(configureReplies(ctx.file, prompts, ctx.env), /模拟用户中断/);
  assert.equal((await accessReplies(ctx.file, ctx.env)).identity, ctx.access.identity);
});
for (const language of ['zh', 'en']) for (const selection of ['1', '2', '3'])
test(`授权输入只显示当前渠道ID类型：${language}／选项${selection}`, async t => {
  const ctx = await fixture(t), previous = getLocale();
  try {
    setLocale(language);
    const answers = selection === '3' ? ['3', '111', 'n', USER, 'n']
      : selection === '1' ? ['1', '111', 'n'] : ['2', USER, 'n'];
    const prompts = ui(answers);
    assert.equal(await configureReplies(ctx.file, prompts, ctx.env), true);
    const idPrompts = prompts.questions.filter(prompt => /chat_id|open_id/.test(prompt));
    assert.equal(idPrompts.length, selection === '3' ? 2 : 1);
    if (selection !== '2') {
      assert.match(idPrompts[0], /Telegram.*chat_id/);
      assert.doesNotMatch(idPrompts[0], /飞书|Feishu|open_id/);
    }
    if (selection !== '1') {
      const feishu = idPrompts.at(-1);
      assert.match(feishu, /(?:飞书|Feishu).*open_id/);
      assert.doesNotMatch(feishu, /Telegram|chat_id/);
    }
  } finally { setLocale(previous); }
});
for (const [name, separator] of [['英文逗号', ','], ['中文逗号', '，'], ['顿号', '、'], ['空格', ' '], ['英文分号', ';'], ['中文分号', '；'], ['换行', '\n'], ['制表符', '\t']])
test(`双渠道向导接受${name}分隔的用户名单并去重`, async t => {
  const ctx = await fixture(t);
  const prompts = ui(['3', ` 111${separator}222${separator}111 `, 'n', `${USER}${separator}ou_OTHER${separator}${USER}`, 'n']);
  assert.equal(await configureReplies(ctx.file, prompts, ctx.env), true);
  const access = await accessReplies(ctx.file, ctx.env);
  assert.deepEqual(channelAccess(access, 'telegram').policy.users, ['111', '222']);
  assert.deepEqual(channelAccess(access, 'feishu').policy.users, [USER, 'ou_OTHER']);
  assert.ok(prompts.output.some(text => text.includes('111, 222')));
  assert.ok(prompts.output.some(text => text.includes('当前远程回复渠道：Feishu')));
  assert.doesNotMatch(prompts.output.join('\n'), /飞书按钮会跳转到 Telegram|不直接接收飞书消息/);
});
test('分隔符兼容不扩大授权，空名单及非法ID仍拒绝且保留旧授权', async t => {
  const ctx = await fixture(t);
  for (const input of ['，、 ;；', '111、999', '111、ou_OTHER']) {
    await assert.rejects(configureReplies(ctx.file, ui(['3', input]), ctx.env));
    assert.equal((await accessReplies(ctx.file, ctx.env)).identity, ctx.access.identity);
  }
});
test('旧版单渠道授权不因两渠道均已配置而自动扩权', async t => {
  const ctx = await fixture(t);
  await atomicJson(policyPath(ctx.file), { version: 1, enabled: true, bot: botKey(ctx.config), users: ['111'], permissions: false, generation: 'b'.repeat(32) });
  const access = await accessReplies(ctx.file, ctx.env);
  assert.equal(replyAccesses(access).length, 1); assert.equal(channelAccess(access, 'feishu'), null);
  assert.equal(access.grants, undefined);
});
test('双渠道策略严格拒绝未知渠道、跨命名空间用户和非布尔权限', async t => {
  const ctx = await fixture(t);
  for (const alter of [policy => { policy.channels.other = policy.channels.telegram; },
    policy => { policy.channels.telegram.users = [USER]; }, policy => { policy.channels.feishu.permissions = 'true'; },
    policy => { policy.channels = []; }]) {
    const policy = structuredClone(ctx.policy); alter(policy); await atomicJson(policyPath(ctx.file), policy);
    await assert.rejects(accessReplies(ctx.file, ctx.env), /授权配置无效/);
  }
});
test('双渠道配置取消不覆盖旧授权，跨渠道用户 ID 不能混用', async t => {
  const ctx = await fixture(t);
  assert.equal(await configureReplies(ctx.file, ui(['3', '111', 'n', '']), ctx.env), false);
  assert.equal((await accessReplies(ctx.file, ctx.env)).identity, ctx.access.identity);
  await assert.rejects(configureReplies(ctx.file, ui(['3', USER]), ctx.env));
  assert.equal((await accessReplies(ctx.file, ctx.env)).identity, ctx.access.identity);
});
test('一侧凭据变更或名单撤销不会授权到另一侧，全部禁用同时生效', async t => {
  const ctx = await fixture(t);
  const changed = await accessReplies(ctx.file, { ...ctx.env, FEISHU_APP_SECRET: 'CHANGED' });
  assert.equal(channelAccess(changed, 'feishu'), null); assert.ok(channelAccess(changed, 'telegram'));
  assert.notEqual(changed.identity, ctx.access.identity);
  await assert.rejects(ctx.api('sendMessage', { chat_id: '222', text: '不得发送' }));
  await assert.rejects(ctx.api('sendMessage', { chat_id: 222, text: '不得发送' }));
  await assert.rejects(ctx.api('sendMessage', { chat_id: 'ou_OTHER', text: '不得发送' }));
  assert.equal(await disableReplies(ctx.file, ui(['y'])), true);
  assert.equal(await accessReplies(ctx.file, ctx.env), null);
  await assert.rejects(snapshot(ctx));
});
for (const first of ['telegram', 'feishu'])
test(`两渠道共用待提交槽：${first}先到，仅注入一次且回执归属正确`, async t => {
  const ctx = await fixture(t);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = true; });
  const fromTg = () => processUpdate(ctx.tg, tgMessage(1, 'TG任务'), ctx.context(ctx.tg));
  const fromFs = () => receiveFs(ctx, fsMessage('om_remote', '飞书任务'));
  if (first === 'telegram') { await fromTg(); await fromFs(); } else { await fromFs(); await fromTg(); }
  const queued = (await snapshot(ctx)).pending[TARGET.session];
  assert.equal(queued.text, first === 'telegram' ? 'TG任务' : '飞书任务');
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = false; });
  await Promise.all([drainReplies(ctx.access, ctx.context()), drainReplies(ctx.fs, ctx.context())]);
  assert.deepEqual(ctx.inputs, [queued.text]);
  await lifecycleHook({ hook_event_name: 'UserPromptSubmit', session_id: TARGET.session, prompt: queued.text }, ctx.file,
    { env: ctx.env, session: async () => TARGET, api: ctx.factory });
  assert.equal((await snapshot(ctx)).pending[TARGET.session], undefined);
  const receivedTg = ctx.telegram.some(item => item.method === 'sendMessage' && item.payload.text.includes('Claude 已收到'));
  const receivedFs = ctx.feishu.some(item => JSON.parse(item.content).text.includes('Claude 已收到'));
  assert.equal(receivedTg, first === 'telegram'); assert.equal(receivedFs, first === 'feishu');
});
test('同一完成通知同时生成 TG 按钮和飞书状态映射', async t => {
  const ctx = await fixture(t), plans = [];
  await dispatchClaudeHook(Buffer.from(JSON.stringify({ hook_event_name: 'Stop', session_id: TARGET.session, last_assistant_message: '完成' })), ctx.file, {
    env: ctx.env, err() {}, reply: { session: async () => TARGET, bridge: async () => true, api: ctx.factory },
    send: async plan => { plans.push(plan); for (const item of plan.items) await plan.onSent?.(item, { result: { message_id: plan.channel === 'telegram' ? 500 : 'om_done' } });
      return { ok: true, channel: plan.channel, sent: plan.items.length, planned: plan.items.length }; },
  });
  const tg = plans.find(plan => plan.channel === 'telegram').items.find(item => item.recipient === '111');
  const fs = plans.find(plan => plan.channel === 'feishu').items.find(item => item.recipient === USER);
  assert.ok(tg.payload.reply_markup.inline_keyboard); assert.match(fs.payload.card.header.title.content, /回复准备中/);
  const state = await snapshot(ctx);
  assert.equal(state.entries['tg:111:500'].session, state.entries[`fs:${USER}:om_done`].session);
  assert.ok(state.feishuCards.om_done);
});
test('同一问题跨渠道抢答只采纳第一份，逐题进度同步到另一渠道', async t => {
  const ctx = await fixture(t), request = await createInteraction(ctx.access, TARGET, 'question', { questions: [QUESTION, { ...QUESTION, question: '第二题？' }] });
  await Promise.all([showInteraction(ctx.tg, request.id, '111', ctx.api), showInteraction(ctx.fs, request.id, USER, ctx.api)]);
  const first = (await snapshot(ctx)).requests[request.id];
  const tgId = first.messages.find(message => message.chat === '111').message;
  const fsId = first.messages.find(message => message.chat === USER).message;
  await processUpdate(ctx.tg, { update_id: 1, callback_query: { id: 'cb1', from: { id: 111 }, data: `dn:q:${request.id}:0:o0`,
    message: { message_id: tgId, chat: { id: 111, type: 'private' } } } }, ctx.context(ctx.tg));
  await receiveFs(ctx, fsMessage('om_late', '2', fsId));
  assert.equal((await snapshot(ctx)).requests[request.id].answers[QUESTION.question], 'A');
  await drainInteractionFeedback(ctx.access, ctx.api, ctx.context().fresh);
  const next = (await snapshot(ctx)).requests[request.id];
  assert.equal(next.displayed[`feishu:${USER}`], 1);
  const nextFs = next.messages.filter(message => message.chat === USER).at(-1).message;
  await receiveFs(ctx, fsMessage('om_second', '2', nextFs));
  const result = await waitInteraction(ctx.access, request, ctx.context().fresh, { timeout: 100 });
  assert.deepEqual(result.hookSpecificOutput.decision.updatedInput.answers, { [QUESTION.question]: 'A', '第二题？': 'B' });
  await drainInteractionFeedback(ctx.access, ctx.api, ctx.context().fresh);
  assert.ok(ctx.telegram.some(item => item.method === 'editMessageReplyMarkup'));
  assert.ok(ctx.feishu.some(item => JSON.parse(item.content).text.includes('等待')));
});
test('双渠道后台同步不重复发题，TG多选的显式刷新仍显示勾选', async t => {
  const ctx = await fixture(t), request = await createInteraction(ctx.access, TARGET, 'question', { questions: [{ ...QUESTION, multiSelect: true }] });
  await showInteraction(ctx.tg, request.id, '111', ctx.api, true); await showInteraction(ctx.fs, request.id, USER, ctx.api, true);
  const before = ctx.telegram.filter(item => item.method === 'sendMessage').length;
  await drainInteractionFeedback(ctx.access, ctx.api, ctx.context().fresh);
  assert.equal(ctx.telegram.filter(item => item.method === 'sendMessage').length, before);
  const parent = (await snapshot(ctx)).requests[request.id].messages.find(message => message.chat === '111').message;
  await processUpdate(ctx.tg, { update_id: 1, callback_query: { id: 'multi', from: { id: 111 }, data: `dn:q:${request.id}:0:o0`,
    message: { message_id: parent, chat: { id: 111, type: 'private' } } } }, ctx.context(ctx.tg));
  const refreshed = ctx.telegram.filter(item => item.method === 'sendMessage').at(-1);
  assert.match(refreshed.payload.reply_markup.inline_keyboard[0][0].text, /☑/);
});
test('一侧交互投递失败不阻断另一侧回答，也不泄露底层异常', async t => {
  const ctx = await fixture(t), data = { session_id: TARGET.session, tool_use_id: 'partial', tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION] } };
  const errors = [], options = { env: ctx.env, session: async () => TARGET, bridge: async () => true,
    err: text => errors.push(text), api: view => view.policy.channel === 'feishu' ? async () => { throw new Error('FAKE_SECRET'); } : ctx.tgApi };
  await interactionHook({ ...data, hook_event_name: 'PreToolUse' }, ctx.file, options);
  let response;
  await interactionHook({ ...data, hook_event_name: 'PermissionRequest' }, ctx.file, { ...options,
    wait: async (access, request, fresh, waitOptions) => {
      const parent = (await snapshot(ctx)).requests[request.id].messages.find(message => message.chat === '111').message;
      await processUpdate(ctx.tg, { update_id: 1, callback_query: { id: 'partial-answer', from: { id: 111 }, data: `dn:q:${request.id}:0:o0`,
        message: { message_id: parent, chat: { id: 111, type: 'private' } } } }, ctx.context(ctx.tg));
      return waitInteraction(access, request, fresh, { ...waitOptions, timeout: 100 });
    }, response: value => { response = value; } });
  assert.equal(response.hookSpecificOutput.decision.updatedInput.answers[QUESTION.question], 'A');
  assert.ok(errors.length); assert.doesNotMatch(errors.join(), /FAKE_SECRET/);
});
test('工具权限逐渠道 opt-in：未授权渠道不能批准，另一渠道只回传一次', async t => {
  const ctx = await fixture(t, { telegram: false, feishu: true });
  const request = await createInteraction(ctx.fs, TARGET, 'permission', { tool_name: 'Bash', tool_input: { command: 'pwd' } });
  await showInteraction(ctx.tg, request.id, '111', ctx.api); assert.equal(ctx.telegram.length, 0);
  await showInteraction(ctx.fs, request.id, USER, ctx.api);
  const parent = (await snapshot(ctx)).requests[request.id].messages[0].message;
  await receiveFs(ctx, fsMessage('om_allow', '/allow', parent));
  const result = await waitInteraction(ctx.fs, request, ctx.context(ctx.fs).fresh, { timeout: 100 });
  assert.equal(result.hookSpecificOutput.decision.behavior, 'allow');
  await receiveFs(ctx, fsMessage('om_deny', '/deny', parent));
  assert.equal((await snapshot(ctx)).requests[request.id].response.hookSpecificOutput.decision.behavior, 'allow');
});
test('两渠道并发权限决定只登记一份，不允许后来决定覆盖', async t => {
  const ctx = await fixture(t), request = await createInteraction(ctx.access, TARGET, 'permission', { tool_name: 'Bash', tool_input: { command: 'pwd' } });
  await showInteraction(ctx.tg, request.id, '111', ctx.api); await showInteraction(ctx.fs, request.id, USER, ctx.api);
  const messages = (await snapshot(ctx)).requests[request.id].messages;
  await enqueueFeishuMessage(ctx.fs, fsMessage('om_decision', '/deny', messages.find(message => message.chat === USER).message));
  await Promise.all([drainFeishuInbox(ctx.fs, ctx.context(ctx.fs)), processUpdate(ctx.tg, { update_id: 1,
    callback_query: { id: 'allow1', from: { id: 111 }, data: `dn:q:${request.id}:0:a`,
      message: { message_id: messages.find(message => message.chat === '111').message, chat: { id: 111, type: 'private' } } } }, ctx.context(ctx.tg))]);
  const value = (await snapshot(ctx)).requests[request.id];
  assert.equal(value.receipts.length, 1); assert.ok(['allow', 'deny'].includes(value.response.hookSpecificOutput.decision.behavior));
  await waitInteraction(ctx.access, request, ctx.context().fresh, { timeout: 100 });
  assert.equal((await snapshot(ctx)).requests[request.id].claimed, true); assert.equal(ctx.inputs.length, 0);
});
test('双渠道 PermissionRequest hook 共用一个请求并通过官方 JSON 回传', async t => {
  const ctx = await fixture(t), data = { session_id: TARGET.session, tool_use_id: 'tool', tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION] } };
  const options = { env: ctx.env, session: async () => TARGET, bridge: async () => true, api: ctx.factory };
  await interactionHook({ ...data, hook_event_name: 'PreToolUse' }, ctx.file, options);
  let response;
  await interactionHook({ ...data, hook_event_name: 'PermissionRequest' }, ctx.file, { ...options,
    wait: async (access, request, fresh, waitOptions) => {
      const value = (await snapshot(ctx)).requests[request.id];
      assert.ok(value.messages.some(message => message.chat === USER)); assert.ok(value.messages.some(message => message.chat === '111'));
      await receiveFs(ctx, fsMessage('om_hook', '1', value.messages.find(message => message.chat === USER).message));
      return waitInteraction(access, request, fresh, { ...waitOptions, timeout: 100 });
    }, response: result => { response = result; } });
  assert.equal(response.hookSpecificOutput.decision.updatedInput.answers[QUESTION.question], 'A');
  assert.equal(Object.keys((await snapshot(ctx)).requests).length, 1); assert.equal(ctx.inputs.length, 0);
});
test('交互结束后 TG 清理按钮、飞书收到结束状态，未回答的一侧也可见', async t => {
  const ctx = await fixture(t), request = await createInteraction(ctx.access, TARGET, 'question', { questions: [QUESTION] });
  await showInteraction(ctx.tg, request.id, '111', ctx.api); await showInteraction(ctx.fs, request.id, USER, ctx.api);
  await stateTransaction(ctx.access, state => { finishInteraction(state.requests[request.id], { kind: 'not-applied', reason: 'closed', text: '本机已关闭' }); });
  await drainInteractionFeedback(ctx.access, ctx.api, ctx.context().fresh);
  assert.ok(ctx.telegram.some(item => item.method === 'editMessageReplyMarkup'));
  assert.ok(ctx.feishu.some(item => JSON.parse(item.content).text.includes('本机已关闭')));
});
test('第二把消费者锁冲突时释放第一把，不启动任何更新消费者', async t => {
  const ctx = await fixture(t);
  const directory = path.join(appPaths(process.platform, ctx.env).data, 'reply-bots');
  const paths = [path.join(directory, ctx.tg.policy.bot + '.lock'), path.join(directory, digest(JSON.stringify(['feishu', ctx.config.feishu.appId])) + '.lock')].sort();
  await mkdir(directory, { recursive: true });
  const held = await acquireBotLock(paths[1], 'b'.repeat(32));
  try {
    await assert.rejects(runBridge(ctx.file, { env: ctx.env, api: () => assert.fail('不能消费TG'), feishuFactory: () => assert.fail('不能消费FS') }));
    const reclaimed = await acquireBotLock(paths[0], 'c'.repeat(32)); await reclaimed.release();
  } finally { await held.release(); }
});
test('飞书临时重连时TG保持就绪，恢复后整体就绪，停止后旧WS回调无效', async t => {
  const ctx = await fixture(t); let receiver, state = 'connected', sleeps = 0;
  const factory = (_credentials, options) => { receiver = options.onMessage; return { get state() { return state; },
    start: async () => {}, stop: () => { state = 'stopped'; }, ...ctx.client, updateMessage: async () => {} };
  };
  await runBridge(ctx.file, { env: ctx.env, api: ctx.factory, feishuFactory: factory, maxIterations: 3, sleep: async () => {
    sleeps++;
    if (sleeps === 1) state = 'reconnecting';
    if (sleeps === 2) {
      assert.equal((await bridgeStatus(ctx.file, ctx.tg)).ready, true);
      assert.equal((await bridgeStatus(ctx.file, ctx.fs)).ready, false);
      assert.equal((await bridgeStatus(ctx.file, ctx.access)).ready, false);
      state = 'connected';
    }
    if (sleeps === 3) assert.equal((await bridgeStatus(ctx.file, ctx.access)).ready, true);
  } });
  await receiver(fsMessage('om_after_stop', '不得消费'));
  assert.deepEqual((await snapshot(ctx)).feishuInbox ?? {}, {});
});
test('同一个桥接同时初始化两渠道并消费飞书，按渠道报告就绪且全部清理', async t => {
  const ctx = await fixture(t); let options, state = 'idle', closed = false, stopped = false;
  const factory = (_credentials, value) => { options = value; return { get state() { return state; },
    start: async () => { state = 'connected'; await options.onMessage(fsMessage('om_bridge', '桥接测试')); },
    stop: () => { closed = true; state = 'stopped'; }, ...ctx.client, updateMessage: async () => {},
  }; };
  await runBridge(ctx.file, { env: ctx.env, api: ctx.factory, feishuFactory: factory, validate: async () => true,
    inject: async (_target, text) => ctx.inputs.push(text), maxIterations: 2, sleep: async () => {
      assert.equal((await bridgeStatus(ctx.file, ctx.tg)).ready, true); assert.equal((await bridgeStatus(ctx.file, ctx.fs)).ready, true);
      stopped = true;
    }, stopped: () => stopped });
  assert.ok(ctx.telegram.some(item => item.method === 'getUpdates'));
  assert.deepEqual(ctx.inputs, ['桥接测试']); assert.equal(closed, true);
  assert.equal((await bridgeStatus(ctx.file)).running, false);
});
