import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { accessReplies, configureReplies, disableReplies, atomicJson, stateTransaction, policyPath, replyDirectory, botKey, targetEpoch, TTL } from '../dist/reply-state.js';
import { parseConfig, appPaths } from '../dist/config.js';
import { processUpdate, drainReplies, textHash, resolveEntry } from '../dist/reply-engine.js';
import { lifecycleHook, attachReply, mapReplies, interactionHook, notificationCoverage } from '../dist/reply-hooks.js';
import { dispatchClaudeHook } from '../dist/claude-hook.js';
import { createInteraction, showInteraction, waitInteraction, questionsFrom, interactionContent } from '../dist/reply-interactions.js';
import { processIdentity, findSession, lookupSession, SessionLookupError, findSessionName, validateTarget, sanitizeReply, injectReply, runCommand } from '../dist/reply-platform.js';
import { telegramApi } from '../dist/reply-telegram.js';
import { runBridge, bridgeStatus, stopBridge } from '../dist/reply-bridge.js';
import { makePlan, deliver, TransportError } from '../dist/channels.js';
import { TelegramConnectionResetError, TelegramRequestError } from '../dist/notification-diagnostics.js';
import { main } from '../dist/cli.js';
import { configureClaudeCode, replyHooksReady } from '../dist/claude-code.js';
import { registerToolCall, matchingCall, callKey, completeToolCall, drainInteractionFeedback } from '../dist/reply-outcomes.js';

globalThis.fetch = async () => { throw new Error('禁止真实网络'); };
const CONFIG = { version: 1, telegram: { enabled: true, chat_ids: ['111', '222', '-333'] }, feishu: { enabled: false } };
const TARGET = { session: 'test-session', pid: 12345, birth: '1234567890', tty: '', title: '隔离测试', cwd: 'C:\\test', working: false, tracked: true, updated: Date.now() };
const QUESTION = { question: '选择框架？', header: '框架', multiSelect: false, options: [{ label: 'React', description: '组件' }, { label: 'Vue', description: '渐进式' }] };
function ui(answers = []) { const output = []; return { output, out: text => output.push(text), secret: async () => assert.fail('不得询问秘密'), text: async () => { assert.ok(answers.length, '意外询问'); return answers.shift(); } }; }
async function temp(t, enabled = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-reply-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { DEV_NOTIFY_HOME: path.join(root, 'app'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), TELEGRAM_BOT_TOKEN: '123:FAKE_ONLY', FEISHU_WEBHOOK: '', FEISHU_SECRET: '' };
  const file = path.join(root, 'config.json'); await atomicJson(file, CONFIG);
  const policy = { version: 1, enabled, users: ['111'], permissions: true, bot: botKey(parseConfig(CONFIG, env)), generation: 'a'.repeat(32) };
  await configureClaudeCode(file, 'install', ui(['y']), { env });
  await atomicJson(policyPath(file), policy);
  const access = enabled ? await accessReplies(file, env) : null;
  const calls = [], inputs = [];
  let messageId = 500;
  const api = async (method, payload) => { calls.push({ method, payload }); if (method === 'sendMessage') return { message_id: ++messageId }; if (method === 'getMe') return { username: 'FakeTestBot' }; if (method === 'getUpdates') return []; return {}; };
  const context = { api, fresh: () => accessReplies(file, env), validate: async () => true, inject: async (target, text) => inputs.push({ target, text }) };
  if (access) await stateTransaction(access, state => { state.sessions[TARGET.session] = { ...TARGET, updated: Date.now() }; state.entries['tg:111:100'] = { session: TARGET.session, epoch: targetEpoch(TARGET), updated: Date.now() }; });
  return { root, env, file, policy, access, calls, inputs, api, context };
}
function message(id, text, extra = {}) { return { update_id: id, message: { message_id: id + 1000, date: Math.floor(Date.now() / 1000), text, chat: { id: 111, type: 'private' }, from: { id: 111, is_bot: false }, reply_to_message: { message_id: 100 }, ...extra } }; }
function callback(id, token, index, operation) { return { update_id: id, callback_query: { id: 'cb-' + id, data: `dn:q:${token}:${index}:${operation}`, from: { id: 111 }, message: { message_id: 100, chat: { id: 111, type: 'private' } } } }; }
const snapshot = access => stateTransaction(access, state => structuredClone(state));
async function boundQuestion(ctx, questions = [QUESTION], id = 'bound-question') {
  const data = { session_id: TARGET.session, tool_use_id: id, tool_name: 'AskUserQuestion', tool_input: { questions } };
  await registerToolCall(ctx.access, TARGET, data);
  const key = callKey(TARGET.session, id);
  const request = await createInteraction(ctx.access, TARGET, 'question', data.tool_input, key);
  return { data, request, key };
}
const flushFeedback = ctx => drainInteractionFeedback(ctx.access, ctx.api, ctx.context.fresh);
const permissionNotice = extra => ({ hook_event_name: 'Notification', notification_type: 'permission_prompt',
  session_id: TARGET.session, message: 'Claude needs your permission', ...extra });
async function dispatchNotice(ctx, extra = {}, target = TARGET) {
  const plans = [], errors = [];
  await dispatchClaudeHook(Buffer.from(JSON.stringify(permissionNotice(extra))), ctx.file, {
    env: ctx.env, err: text => errors.push(text), reply: { session: async () => target },
    send: async plan => { plans.push(plan); return { ok: true, channel: plan.channel, sent: plan.items.length, planned: plan.items.length }; },
  });
  return { plans, errors };
}
const recipients = result => result.plans.filter(plan => plan.channel === 'telegram').flatMap(plan => plan.items.map(item => item.recipient));

test('完整选择题已送达时只抑制该接收人的通用权限提醒，未授权私聊与群聊仍收到兜底', async t => {
  const ctx = await temp(t), { request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  const result = await dispatchNotice(ctx);
  assert.deepEqual(recipients(result), ['222', '-333']); assert.deepEqual(result.errors, []);
  assert.deepEqual((await snapshot(ctx.access)).requests[request.id].notified.telegram, ['111']);
});
test('没有已投递选择题、回复未启用、发送失败或消息映射失败时保留全部通用提醒', async t => {
  for (const scenario of ['missing', 'disabled', 'send-failed', 'mapping-failed']) {
    const ctx = await temp(t, scenario !== 'disabled');
    if (scenario.endsWith('failed')) {
      const { request } = await boundQuestion(ctx);
      await assert.rejects(showInteraction(ctx.access, request.id, '111', async () => {
        if (scenario === 'send-failed') throw new Error('FAKE_ONLY');
        return {};
      }));
    }
    const result = await dispatchNotice(ctx);
    assert.deepEqual(recipients(result), ['111', '222', '-333']);
  }
});
test('长题只投递了部分分段时不覆盖通用提醒，完整重试成功后才覆盖', async t => {
  const ctx = await temp(t), q = { ...QUESTION, options: QUESTION.options.map(o => ({ ...o, description: '长选项'.repeat(2500) })) };
  const { request } = await boundQuestion(ctx, [q]);
  let count = 0;
  await assert.rejects(showInteraction(ctx.access, request.id, '111', async (method, payload) => {
    if (++count > 1) throw new Error('FAKE_ONLY');
    return ctx.api(method, payload);
  }));
  assert.deepEqual(recipients(await dispatchNotice(ctx)), ['111', '222', '-333']);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  assert.deepEqual(recipients(await dispatchNotice(ctx)), ['222', '-333']);
});
test('已成功投递后再次展示失败会恢复该用户的通用提醒', async t => {
  const ctx = await temp(t), { request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  await assert.rejects(showInteraction(ctx.access, request.id, '111', async () => { throw new Error('FAKE_ONLY'); }));
  assert.deepEqual(recipients(await dispatchNotice(ctx)), ['111', '222', '-333']);
});
test('选择题发送期间仍保留兜底；成功完成后才去重', async t => {
  const ctx = await temp(t), { request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', async (method, payload) => {
    assert.deepEqual(recipients(await dispatchNotice(ctx)), ['111', '222', '-333']);
    return ctx.api(method, payload);
  });
  assert.deepEqual(recipients(await dispatchNotice(ctx)), ['222', '-333']);
});
test('答题结束及 Stop 后短期迟到的通用提醒仍去重，新一轮输入不继承旧覆盖', async t => {
  const ctx = await temp(t), { data, request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  await completeToolCall(ctx.access, { ...data, hook_event_name: 'PostToolUse', tool_response: { answers: { [QUESTION.question]: 'React' } } });
  await lifecycleHook({ hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, { env: ctx.env, session: async () => TARGET });
  assert.deepEqual(recipients(await dispatchNotice(ctx)), ['222', '-333']);
  await lifecycleHook({ hook_event_name: 'UserPromptSubmit', session_id: TARGET.session, prompt: '新一轮' }, ctx.file, { env: ctx.env, session: async () => TARGET });
  assert.deepEqual(recipients(await dispatchNotice(ctx)), ['111', '222', '-333']);
});
test('未授权远端批准权限时仍登记后续其他工具，不能用旧选择题吞掉必要权限提醒', async t => {
  const ctx = await temp(t);
  await atomicJson(policyPath(ctx.file), { ...ctx.policy, permissions: false }); ctx.access = await accessReplies(ctx.file, ctx.env);
  const { request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  await interactionHook({ hook_event_name: 'PreToolUse', session_id: TARGET.session, tool_use_id: 'new-bash', tool_name: 'Bash', tool_input: { command: 'pwd' } }, ctx.file,
    { env: ctx.env, session: async () => TARGET, api: () => assert.fail('不能联网'), bridge: async () => assert.fail('不能启动桥接') });
  assert.deepEqual(recipients(await dispatchNotice(ctx)), ['111', '222', '-333']);
});
test('存在另一个并行调用时不猜测提醒归属，保留全部提醒', async t => {
  const ctx = await temp(t);
  await registerToolCall(ctx.access, TARGET, { tool_use_id: 'parallel', tool_name: 'Bash', tool_input: { command: 'pwd' } });
  const { request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  assert.deepEqual(recipients(await dispatchNotice(ctx)), ['111', '222', '-333']);
});
test('其他通知类型、明确的不同工具/调用/轮次，以及过期和进程切换不受旧选择题影响', async t => {
  const ctx = await temp(t), { request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  for (const extra of [{ notification_type: 'agent_needs_input' }, { notification_type: 'elicitation_dialog' },
    { tool_name: 'Bash' }, { tool_use_id: 'different-call' }, { prompt_id: 'different-prompt' }]) {
    assert.deepEqual(recipients(await dispatchNotice(ctx, extra)), ['111', '222', '-333']);
  }
  await stateTransaction(ctx.access, state => { state.requests[request.id].expires = Date.now() - 1; });
  assert.deepEqual(recipients(await dispatchNotice(ctx)), ['111', '222', '-333']);
  await stateTransaction(ctx.access, state => { state.requests[request.id].expires = Date.now() + 60000; });
  assert.deepEqual(recipients(await dispatchNotice(ctx, {}, { ...TARGET, birth: 'new-process' })), ['111', '222', '-333']);
});
test('所有 Telegram 接收人均被覆盖时正常不发送，不报告无可用渠道', async t => {
  const ctx = await temp(t); await atomicJson(ctx.file, { ...CONFIG, telegram: { ...CONFIG.telegram, chat_ids: ['111'] } });
  ctx.access = await accessReplies(ctx.file, ctx.env);
  const { request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  const result = await dispatchNotice(ctx);
  assert.deepEqual(result.plans, []); assert.deepEqual(result.errors, []);
});
test('飞书只在自身结构化通知成功且目标未变时去重，失败或更换 webhook 仍发送兜底', async t => {
  for (const sent of [true, false]) {
    const ctx = await temp(t); ctx.env.FEISHU_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/FAKE_ONLY';
    await atomicJson(ctx.file, { ...CONFIG, feishu: { enabled: true } }); ctx.access = await accessReplies(ctx.file, ctx.env);
    const data = { session_id: TARGET.session, tool_use_id: 'feishu-question', tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION] } };
    const options = { env: ctx.env, session: async () => TARGET, api: () => ctx.api, bridge: async () => true, wait: async () => null,
      send: async plan => ({ ok: sent, channel: plan.channel, sent: sent ? plan.items.length : 0, planned: plan.items.length }) };
    await interactionHook({ ...data, hook_event_name: 'PreToolUse' }, ctx.file, options);
    await interactionHook({ ...data, hook_event_name: 'PermissionRequest' }, ctx.file, options);
    const result = await dispatchNotice(ctx);
    assert.deepEqual(recipients(result), ['222', '-333']);
    assert.equal(result.plans.some(p => p.channel === 'feishu'), !sent);
    if (sent) {
      ctx.env.FEISHU_WEBHOOK += '_CHANGED';
      assert.ok((await dispatchNotice(ctx)).plans.some(p => p.channel === 'feishu'));
    }
  }
});
test('飞书卡片按题号和选项编号展示，题目与选项不粘连', async t => {
  const ctx = await temp(t); ctx.env.FEISHU_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/FAKE_ONLY';
  await atomicJson(ctx.file, { ...CONFIG, feishu: { enabled: true } }); ctx.access = await accessReplies(ctx.file, ctx.env);
  const questions = [QUESTION, { ...QUESTION, question: '选择语言？', header: '语言', multiSelect: true,
    options: [{ label: 'TypeScript', description: '类型系统' }, { label: '选项二', description: '第二个示例' }] }];
  const data = { session_id: TARGET.session, tool_use_id: 'feishu-format', tool_name: 'AskUserQuestion', tool_input: { questions } };
  let plan;
  const options = { env: ctx.env, session: async () => TARGET, api: () => ctx.api, bridge: async () => true, wait: async () => null,
    send: async value => { plan = value; return { ok: true, channel: value.channel, sent: value.items.length, planned: value.items.length }; } };
  await interactionHook({ ...data, hook_event_name: 'PreToolUse' }, ctx.file, options);
  await interactionHook({ ...data, hook_event_name: 'PermissionRequest' }, ctx.file, options);
  assert.ok(plan);
  const content = plan.items[0].payload.card.elements.find(element => element.tag === 'markdown').content;
  assert.match(content, /问题 1\/2：选择框架？/);
  assert.match(content, /1\. React\n组件/);
  assert.match(content, /2\. Vue\n渐进式/);
  assert.match(content, /问题 2\/2：选择语言？/);
  assert.match(content, /1\. TypeScript\n类型系统/);
  assert.match(content, /2\. 选项二\n第二个示例/);
  assert.match(content, /可多选：进入 Telegram 后逐项选择/);
  assert.match(content, /────────/);
  assert.doesNotMatch(content, /React：组件|Vue：渐进式/);
});
test('覆盖状态无法读取或授权撤销时失败开放，仅保留普通提醒而不回显错误', async t => {
  for (const revoked of [true, false]) {
    const ctx = await temp(t), { request } = await boundQuestion(ctx);
    await showInteraction(ctx.access, request.id, '111', ctx.api);
    if (revoked) await atomicJson(policyPath(ctx.file), { ...ctx.policy, enabled: false });
    else await writeFile(path.join(replyDirectory(ctx.file), 'state.json'), 'FAKE_ONLY_BROKEN_STATE');
    const result = await dispatchNotice(ctx);
    assert.deepEqual(recipients(result), ['111', '222', '-333']);
    assert.ok(!result.errors.join().includes('FAKE_ONLY'));
  }
});
test('缺少会话身份或不属于当前会话的提醒不去重', async t => {
  const ctx = await temp(t), { request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  for (const session_id of [undefined, 'other-session']) assert.deepEqual(
    await notificationCoverage(permissionNotice({ session_id }), ctx.file, ctx.access.config, { env: ctx.env }), { telegram: [], feishu: false });
});

test('PreToolUse 仅登记身份，不启动桥接、不联网、不等待回答；缺失关联保留本机', async t => {
  const ctx = await temp(t);
  const options = { env: ctx.env, session: async () => TARGET, bridge: async () => assert.fail('不能启动'),
    api: () => assert.fail('不能联网'), wait: async () => assert.fail('不能等待'), response: () => assert.fail('不能应答') };
  const data = { session_id: TARGET.session, tool_use_id: 'register-only', tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION] } };
  await interactionHook({ ...data, hook_event_name: 'PreToolUse' }, ctx.file, options);
  assert.equal(Object.keys((await snapshot(ctx.access)).requests).length, 0);
  await interactionHook({ ...data, tool_input: { questions: [{ ...QUESTION, question: '未登记问题' }] }, hook_event_name: 'PermissionRequest' }, ctx.file, options);
});
test('本机先答：等待立即结束，不输出远程答案，已登记提交反馈未生效并移除按钮', async t => {
  const ctx = await temp(t), { data, request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  await processUpdate(ctx.access, callback(1, request.id, 0, 'o1'), ctx.context);
  await interactionHook({ ...data, hook_event_name: 'PostToolUse', tool_response: { answers: { [QUESTION.question]: 'Vue' } } }, ctx.file, { env: ctx.env });
  assert.equal(await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 }), null);
  await flushFeedback(ctx);
  const value = (await snapshot(ctx.access)).requests[request.id];
  assert.equal(value.receipts[0].result.kind, 'not-applied'); // 同答案也不能虚称远端回传成功
  assert.ok(ctx.calls.some(c => c.payload.text?.includes('本机或其他端已经先处理了')));
  assert.ok(ctx.calls.some(c => c.method === 'editMessageReplyMarkup'));
  await processUpdate(ctx.access, callback(2, request.id, 0, 'o0'), ctx.context);
  assert.match(ctx.calls.at(-1).payload.text, /未生效/);
});
test('远端先回传：完成事件前只有等待确认，实际答案一致才反馈内容已生效且不虚报来源', async t => {
  const ctx = await temp(t), { data, request } = await boundQuestion(ctx);
  await processUpdate(ctx.access, callback(1, request.id, 0, 'o1'), ctx.context);
  await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
  await flushFeedback(ctx);
  assert.ok(!ctx.calls.some(c => c.payload.text?.includes('✅ 答案内容已生效')));
  await completeToolCall(ctx.access, { ...data, hook_event_name: 'PostToolUse', tool_response: { answers: { [QUESTION.question]: 'Vue' } } });
  await flushFeedback(ctx); await flushFeedback(ctx);
  const final = ctx.calls.filter(c => c.payload.text?.includes('✅ 答案内容已生效'));
  assert.equal(final.length, 1); assert.match(final[0].payload.text, /无法说明是哪一方生效/);
  const value = (await snapshot(ctx.access)).requests[request.id];
  assert.deepEqual(value.input, {}); assert.equal(value.receipts[0].answer, ''); assert.equal(value.response, undefined);
});
test('竞争落败：hook 已回传但 Claude 采用另一个答案，反馈未生效而非成功', async t => {
  const ctx = await temp(t), { data, request } = await boundQuestion(ctx);
  await processUpdate(ctx.access, callback(1, request.id, 0, 'o1'), ctx.context);
  await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
  await completeToolCall(ctx.access, { ...data, hook_event_name: 'PostToolUse', tool_response: { answers: { [QUESTION.question]: 'React' } } });
  await flushFeedback(ctx);
  assert.equal((await snapshot(ctx.access)).requests[request.id].receipts[0].result.kind, 'not-applied');
  assert.ok(ctx.calls.some(c => c.payload.text?.includes('没有采用你提交的答案')));
});
test('本机改为追加问题、聊天、超时或跳过时，不把遗留选项当作已采用答案', async t => {
  for (const extra of [{ followUp: true }, { response: '先解释' }, { afkTimeoutMs: 1000 }, { annotations: { [QUESTION.question]: { unanswered: 'skipped' } } }]) {
    const ctx = await temp(t), { data, request } = await boundQuestion(ctx);
    await processUpdate(ctx.access, callback(1, request.id, 0, 'o1'), ctx.context);
    await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
    await completeToolCall(ctx.access, { ...data, hook_event_name: 'PostToolUse', tool_response: { answers: { [QUESTION.question]: 'Vue' }, ...extra } });
    assert.equal((await snapshot(ctx.access)).requests[request.id].receipts[0].result.kind, 'not-applied');
  }
});
test('两端近同时：状态锁串行化回传与完成，无论顺序都不输出第二次答案', async t => {
  for (const localFirst of [true, false]) {
    const ctx = await temp(t), { data, request } = await boundQuestion(ctx);
    await processUpdate(ctx.access, callback(1, request.id, 0, 'o1'), ctx.context);
    const finish = () => completeToolCall(ctx.access, { ...data, hook_event_name: 'PostToolUse', tool_response: { answers: { [QUESTION.question]: 'React' } } });
    const wait = () => waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
    await Promise.all(localFirst ? [finish(), wait()] : [wait(), finish()]);
    assert.equal(await wait(), null);
    await flushFeedback(ctx);
    assert.equal((await snapshot(ctx.access)).requests[request.id].receipts[0].result.kind, 'not-applied');
  }
});
test('多选及多题自定义分别登记收据，全部回答才回传，完成结果逐次反馈', async t => {
  const ctx = await temp(t), q2 = { ...QUESTION, question: '填写备注' };
  const { data, request } = await boundQuestion(ctx, [{ ...QUESTION, multiSelect: true }, q2]);
  await processUpdate(ctx.access, callback(1, request.id, 0, 'o0'), ctx.context);
  await processUpdate(ctx.access, callback(2, request.id, 0, 'o1'), ctx.context);
  await processUpdate(ctx.access, callback(3, request.id, 0, 's'), ctx.context);
  assert.equal((await snapshot(ctx.access)).requests[request.id].response, undefined);
  await processUpdate(ctx.access, callback(4, request.id, 1, 'c'), ctx.context);
  const state = await snapshot(ctx.access);
  const entry = Object.keys(state.entries).filter(k => k.startsWith('tg:') && state.entries[k].question === 1).at(-1);
  await processUpdate(ctx.access, message(5, '  备注\n完整正文', { reply_to_message: { message_id: Number(entry.split(':').at(-1)) } }), ctx.context);
  await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
  await completeToolCall(ctx.access, { ...data, hook_event_name: 'PostToolUse', tool_response: { answers: { [QUESTION.question]: ['Vue', 'React'], [q2.question]: '  备注\n完整正文' } } });
  await flushFeedback(ctx);
  assert.equal(ctx.calls.filter(c => c.payload.text?.includes('✅ 答案内容已生效')).length, 2);
});
test('部分问题已提交但本机先完成整份问题，部分提交也有未生效反馈', async t => {
  const ctx = await temp(t), { data, request } = await boundQuestion(ctx, [QUESTION, { ...QUESTION, question: '第二题' }]);
  await processUpdate(ctx.access, callback(1, request.id, 0, 'o0'), ctx.context);
  await completeToolCall(ctx.access, { ...data, hook_event_name: 'PostToolUse', tool_response: { answers: { [QUESTION.question]: 'React', '第二题': 'Vue' } } });
  await flushFeedback(ctx);
  assert.equal((await snapshot(ctx.access)).requests[request.id].receipts[0].result.kind, 'not-applied');
});
test('缺结果、失败、取消和确认超时明确未知，不以 hook 输出代替生效确认', async t => {
  for (const event of ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied', 'timeout', 'SessionEnd']) {
    const ctx = await temp(t), { data, request } = await boundQuestion(ctx);
    await processUpdate(ctx.access, callback(1, request.id, 0, 'o0'), ctx.context);
    await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
    if (event === 'timeout') await stateTransaction(ctx.access, state => { state.requests[request.id].expires = Date.now() - 1; });
    else if (event === 'SessionEnd') await lifecycleHook({ ...data, hook_event_name: event }, ctx.file, { env: ctx.env });
    else await completeToolCall(ctx.access, { ...data, hook_event_name: event });
    await flushFeedback(ctx);
    assert.equal((await snapshot(ctx.access)).requests[request.id].receipts[0].result.kind, 'unknown', event);
    assert.ok(ctx.calls.some(c => c.payload.text?.includes('暂时无法确认')));
  }
});
test('取消信号结束等待且清除未回传的答案，部分提交仍有明确反馈', async t => {
  const ctx = await temp(t), { request } = await boundQuestion(ctx);
  await processUpdate(ctx.access, callback(1, request.id, 0, 'o0'), ctx.context);
  const controller = new AbortController(); controller.abort();
  assert.equal(await waitInteraction(ctx.access, request, ctx.context.fresh, { signal: controller.signal }), null);
  await flushFeedback(ctx);
  assert.equal((await snapshot(ctx.access)).requests[request.id].receipts[0].result.kind, 'not-applied');
  assert.ok(ctx.calls.some(c => c.payload.text?.includes('已取消')));
});
test('多选题的自定义文本按原文核验，不把逗号及空格变化误报为生效', async t => {
  const ctx = await temp(t), { data, request } = await boundQuestion(ctx, [{ ...QUESTION, multiSelect: true }]);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  const entry = Object.keys((await snapshot(ctx.access)).entries).filter(k => k.startsWith('tg:111:') && k !== 'tg:111:100').at(-1);
  await processUpdate(ctx.access, message(1, 'a, b', { reply_to_message: { message_id: Number(entry.split(':').at(-1)) } }), ctx.context);
  await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
  await completeToolCall(ctx.access, { ...data, hook_event_name: 'PostToolUse', tool_response: { answers: { [QUESTION.question]: 'b,a' } } });
  await flushFeedback(ctx);
  assert.equal((await snapshot(ctx.access)).requests[request.id].receipts[0].result.kind, 'not-applied');
});
test('权限批准仅在实际完成后确认，拒绝不能凭失败事件假报已生效', async t => {
  for (const op of ['a', 'd']) {
    const ctx = await temp(t), data = { session_id: TARGET.session, tool_use_id: 'permission', tool_name: 'Bash', tool_input: { command: 'fake' } };
    await registerToolCall(ctx.access, TARGET, data);
    const request = await createInteraction(ctx.access, TARGET, 'permission', { tool_name: data.tool_name, tool_input: data.tool_input }, callKey(TARGET.session, data.tool_use_id));
    await processUpdate(ctx.access, callback(1, request.id, 0, op), ctx.context);
    await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
    await completeToolCall(ctx.access, { ...data, hook_event_name: op === 'a' ? 'PostToolUse' : 'PostToolUseFailure' });
    await flushFeedback(ctx);
    assert.equal((await snapshot(ctx.access)).requests[request.id].receipts[0].result.kind, op === 'a' ? 'applied' : 'unknown');
  }
});
test('本机在发送 Telegram 通知过程中先答，晚到按钮仍被登记并清除', async t => {
  const ctx = await temp(t), { data, request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', async (method, payload) => {
    if (method === 'sendMessage') await completeToolCall(ctx.access, { ...data, hook_event_name: 'PostToolUse', tool_response: { answers: {} } });
    return ctx.api(method, payload);
  });
  await flushFeedback(ctx);
  assert.ok(ctx.calls.some(c => c.method === 'editMessageReplyMarkup'));
});
test('调用关联防误投：缺失、重复同输入、已结束、错题和重复事件均不创建新交互', async t => {
  const ctx = await temp(t);
  const data = { session_id: TARGET.session, tool_use_id: 'one', tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION] }, prompt_id: 'prompt' };
  assert.equal(await stateTransaction(ctx.access, s => matchingCall(s, TARGET, data)), undefined);
  await registerToolCall(ctx.access, TARGET, data);
  assert.ok(await stateTransaction(ctx.access, s => matchingCall(s, TARGET, data)));
  await completeToolCall(ctx.access, { ...data, hook_event_name: 'PostToolUse' });
  assert.equal(await stateTransaction(ctx.access, s => matchingCall(s, TARGET, data)), undefined);
  await registerToolCall(ctx.access, TARGET, { ...data, tool_use_id: 'two' });
  assert.equal(await stateTransaction(ctx.access, s => matchingCall(s, TARGET, data)), undefined);
});
test('独立工具并行不会互相作废；完成仅按 tool_use_id 结束对应请求', async t => {
  const ctx = await temp(t), first = await boundQuestion(ctx, [QUESTION], 'one');
  const second = await boundQuestion(ctx, [{ ...QUESTION, question: '另一个问题' }], 'two');
  await completeToolCall(ctx.access, { ...first.data, hook_event_name: 'PostToolUse', tool_response: { answers: {} } });
  const state = await snapshot(ctx.access);
  assert.ok(state.requests[first.request.id].result); assert.equal(state.requests[second.request.id].result, undefined);
});
test('结果发送失败记录未知且不重放；按钮编辑失败不会恢复答题资格；撤销后不再发送', async t => {
  const ctx = await temp(t), { data, request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  await processUpdate(ctx.access, callback(1, request.id, 0, 'o0'), ctx.context);
  await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
  await completeToolCall(ctx.access, { ...data, hook_event_name: 'PostToolUse', tool_response: { answers: { [QUESTION.question]: 'React' } } });
  let attempts = 0;
  const failing = async () => { attempts++; throw new Error('网络不可用'); };
  await drainInteractionFeedback(ctx.access, failing, ctx.context.fresh);
  await drainInteractionFeedback(ctx.access, failing, ctx.context.fresh);
  assert.equal(attempts, 2); // 一次结果发送、一次移除按钮；均不盲重发
  assert.equal((await snapshot(ctx.access)).requests[request.id].receipts[0].delivery, 'unknown');
  await atomicJson(policyPath(ctx.file), { ...ctx.policy, enabled: false });
  await drainInteractionFeedback(ctx.access, async () => assert.fail('撤销后不能发送'), ctx.context.fresh);
});

test('独立授权默认关闭，通知接收人不会自动获得远程输入权', async t => {
  const ctx = await temp(t, false); assert.equal(await accessReplies(ctx.file, ctx.env), null);
  assert.equal(await configureReplies(ctx.file, ui(['']), ctx.env), false);
  assert.equal(await accessReplies(ctx.file, ctx.env), null);
  await assert.rejects(configureReplies(ctx.file, ui(['-333']), ctx.env), /私聊/);
  await assert.rejects(configureReplies(ctx.file, ui(['999']), ctx.env), /私聊用户/);
});
test('明确选择用户及逐次权限后直接保存；重新授权不继承消息', async t => {
  const ctx = await temp(t);
  await configureReplies(ctx.file, ui(['111', 'n']), ctx.env);
  const access = await accessReplies(ctx.file, ctx.env);
  assert.equal(access.policy.permissions, false); assert.notEqual(access.identity, ctx.access.identity);
  assert.equal(Object.keys((await snapshot(access)).entries).length, 0);
  await assert.rejects(snapshot(ctx.access), /授权已撤销或发生变化/);
});
test('授权取消不写入，禁用需确认且不更改通知配置', async t => {
  const ctx = await temp(t), before = await readFile(ctx.file);
  const policyBefore = await readFile(policyPath(ctx.file));
  assert.equal(await configureReplies(ctx.file, ui(['']), ctx.env), false);
  assert.deepEqual(await readFile(policyPath(ctx.file)), policyBefore);
  assert.equal(await disableReplies(ctx.file, ui(['n'])), false);
  assert.equal(await disableReplies(ctx.file, ui(['y'])), true);
  assert.equal(await accessReplies(ctx.file, ctx.env), null); assert.deepEqual(await readFile(ctx.file), before);
  await assert.rejects(snapshot(ctx.access), /授权已撤销/);
});
test('Bot 变化、接收人撤销、损坏授权都拒绝，不继承旧映射', async t => {
  const ctx = await temp(t);
  await assert.rejects(accessReplies(ctx.file, { ...ctx.env, TELEGRAM_BOT_TOKEN: '456:NEW_FAKE' }), /Bot 已变更/);
  await assert.rejects(accessReplies(ctx.file, { ...ctx.env, TELEGRAM_CHAT_IDS: '222' }), /不在当前/);
  await atomicJson(policyPath(ctx.file), { ...ctx.policy, users: ['-333'] });
  await assert.rejects(accessReplies(ctx.file, ctx.env), /授权配置无效/);
});
test('旧版缺生命周期 hooks、异步 Stop、绑定其他配置或全局禁用时拒绝远程输入', async t => {
  const ctx = await temp(t), file = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'settings.json');
  const complete = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(await replyHooksReady(ctx.file, { env: ctx.env }), true);
  const old = structuredClone(complete); delete old.hooks.UserPromptSubmit; await atomicJson(file, old);
  await assert.rejects(accessReplies(ctx.file, ctx.env), /hooks 缺失/);
  const asyncStop = structuredClone(complete); asyncStop.hooks.Stop[0].hooks[0].async = true; await atomicJson(file, asyncStop);
  assert.equal(await replyHooksReady(ctx.file, { env: ctx.env }), false);
  await atomicJson(file, { ...complete, disableAllHooks: true });
  assert.equal(await replyHooksReady(ctx.file, { env: ctx.env }), false);
  await atomicJson(file, complete);
  assert.equal(await replyHooksReady(path.join(ctx.root, 'other-config.json'), { env: ctx.env }), false);
});
test('未观察到该会话 UserPromptSubmit 时不开放普通终端回复', async t => {
  const ctx = await temp(t), options = { env: ctx.env, session: async () => TARGET, bridge: async () => true, api: () => ctx.api };
  await lifecycleHook({ hook_event_name: 'SessionStart', session_id: TARGET.session }, ctx.file, options);
  await lifecycleHook({ hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, options);
  const notification = { title: '完成', content: '正文', footer: '', level: 'success' };
  assert.equal(await attachReply(notification, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, options), null);
  await lifecycleHook({ hook_event_name: 'UserPromptSubmit', session_id: TARGET.session, prompt: '开始' }, ctx.file, options);
  await lifecycleHook({ hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, options);
  assert.ok(await attachReply(notification, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, options));
});
for (const reason of ['session-unverified', 'state-missing', 'session-working', 'input-unobserved', 'identity-changed'])
test(`不带按钮时明确记录原因：${reason}`, async t => {
  const ctx = await temp(t), codes = [], errors = [];
  await stateTransaction(ctx.access, state => {
    if (reason === 'state-missing') delete state.sessions[TARGET.session];
    if (reason === 'session-working') state.sessions[TARGET.session].working = true;
    if (reason === 'input-unobserved') state.sessions[TARGET.session].tracked = false;
    if (reason === 'identity-changed') state.sessions[TARGET.session].birth = 'DIFFERENT';
  });
  const notification = { title: '完成', content: '正文', footer: '', level: 'success' };
  assert.equal(await attachReply(notification, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, {
    env: ctx.env, session: async () => reason === 'session-unverified' ? null : TARGET,
    replyDiagnostic: code => codes.push(code), err: text => errors.push(text),
    bridge: async () => assert.fail('未通过会话检查不得启动桥接'),
  }), null);
  assert.deepEqual(codes, [reason]); assert.equal(errors.length, 1); assert.ok(errors[0].includes(reason));
  assert.equal(notification.reply, undefined);
});

test('不同会话的通知诊断独立保存，正文和Token不落盘', async t => {
  const ctx = await temp(t), other = { ...TARGET, session: 'other-session', pid: TARGET.pid + 1, birth: 'different-birth' };
  await stateTransaction(ctx.access, state => {
    state.sessions[TARGET.session].tracked = false;
    state.sessions[other.session] = { ...other, updated: Date.now() };
  });
  await Promise.all([TARGET, other].map(target => dispatchClaudeHook(Buffer.from(JSON.stringify({
    hook_event_name: 'Stop', session_id: target.session, last_assistant_message: 'PRIVATE_BODY_NOT_FOR_DIAGNOSTICS',
  })), ctx.file, {
    env: ctx.env, err: () => {}, reply: { session: async () => target, bridge: async () => true, api: () => ctx.api },
    send: (plan, config) => deliver(plan, config, async () => ({ ok: true, result: { message_id: 900 } })),
  })));
  const directory = path.join(replyDirectory(ctx.file), 'notification-diagnostics');
  const first = JSON.parse(await readFile(path.join(directory, TARGET.session + '.json'), 'utf8'));
  const second = JSON.parse(await readFile(path.join(directory, other.session + '.json'), 'utf8'));
  assert.equal(first.reply, 'input-unobserved'); assert.equal(second.reply, 'attached');
  assert.equal(first.channels.telegram.status, 'complete'); assert.equal(second.channels.telegram.status, 'complete');
  for (const value of [first, second]) {
    const text = JSON.stringify(value);
    assert.doesNotMatch(text, /PRIVATE_BODY|FAKE_ONLY|FakeTestBot|chat_id|callback|https?:/);
    assert.deepEqual(Object.keys(value).sort(), ['channels', 'reply', 'updated', 'version']);
  }
  assert.deepEqual((await readdir(directory)).sort(), [other.session + '.json', TARGET.session + '.json'].sort());
});

test('本地诊断保存失败不影响投递、不重复发送', async t => {
  const ctx = await temp(t), errors = []; let sends = 0;
  await writeFile(path.join(replyDirectory(ctx.file), 'notification-diagnostics'), '阻止创建诊断目录');
  await dispatchClaudeHook(Buffer.from(JSON.stringify({ hook_event_name: 'Stop', session_id: TARGET.session,
    last_assistant_message: '测试', })), ctx.file, {
    env: ctx.env, err: text => errors.push(text), reply: { session: async () => TARGET, bridge: async () => true, api: () => ctx.api },
    send: async plan => { sends++; return { ok: true, channel: plan.channel, sent: plan.items.length, planned: plan.items.length }; },
  });
  assert.equal(sends, 1); assert.equal(errors.length, 1); assert.match(errors[0], /诊断摘要未能保存/);
});

test('会话读取权限拒绝、损坏及身份查询失败与明确缺失分开', async t => {
  const ctx = await temp(t), directory = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'sessions');
  assert.equal((await lookupSession(TARGET.session, { env: ctx.env })).status, 'missing');
  const denied = async () => { throw Object.assign(new Error('PRIVATE'), { code: 'EACCES' }); };
  assert.equal((await lookupSession(TARGET.session, { env: ctx.env, readDirectory: denied })).status, 'unavailable');
  await mkdir(directory);
  await atomicJson(path.join(directory, TARGET.pid + '.json'), { sessionId: TARGET.session, pid: TARGET.pid });
  const options = { env: ctx.env, platform: 'win32', runner: async () => ({ code: 0, stdout: '{"birth":"123"}' }) };
  assert.equal((await lookupSession(TARGET.session, options)).status, 'found');
  assert.equal((await lookupSession(TARGET.session, { ...options, readSessionFile: denied })).status, 'unavailable');
  assert.equal((await lookupSession(TARGET.session, { ...options, runner: denied })).status, 'unavailable');
  await writeFile(path.join(directory, '54321.json'), '{BROKEN');
  assert.equal((await lookupSession(TARGET.session, options)).status, 'unavailable'); // 不能排除不可读文件中还有同ID。
  await assert.rejects(validateTarget(TARGET, options), SessionLookupError);
});

test('Stop核验暂不可用保留排队回复并暂停输入，恢复相同身份后仅提交一次', async t => {
  const ctx = await temp(t);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = true; });
  await processUpdate(ctx.access, message(1, '保持原有效期'), ctx.context);
  const queued = (await snapshot(ctx.access)).pending[TARGET.session];
  await lifecycleHook({ hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file,
    { env: ctx.env, sessionLookup: async () => ({ status: 'unavailable' }) });
  let state = await snapshot(ctx.access);
  assert.equal(state.sessions[TARGET.session].unverified, true);
  assert.deepEqual(state.pending[TARGET.session], queued);
  assert.equal(await resolveEntry(ctx.access, 'tg:111:100', ctx.context), null);
  await drainReplies(ctx.access, { ...ctx.context, validate: async () => assert.fail('暂停状态不得尝试注入') });
  assert.equal(ctx.inputs.length, 0);
  await lifecycleHook({ hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file,
    { env: ctx.env, session: async () => TARGET });
  await drainReplies(ctx.access, ctx.context); await drainReplies(ctx.access, ctx.context);
  assert.equal(ctx.inputs.length, 1);
  state = await snapshot(ctx.access);
  assert.equal(state.sessions[TARGET.session].unverified, undefined);
  assert.equal(state.pending[TARGET.session].phase, 'submitted');
  assert.equal(state.pending[TARGET.session].text, undefined);
});

test('核验不可用时新的本地输入仍取消旧排队任务，明确SessionEnd仍清理路由', async t => {
  const ctx = await temp(t);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = true; });
  await processUpdate(ctx.access, message(1, '旧任务不得抢先输入'), ctx.context);
  await lifecycleHook({ hook_event_name: 'UserPromptSubmit', session_id: TARGET.session, prompt: '本地新任务' }, ctx.file,
    { env: ctx.env, sessionLookup: async () => ({ status: 'unavailable' }) });
  const state = await snapshot(ctx.access);
  assert.equal(state.pending[TARGET.session], undefined); assert.equal(state.sessions[TARGET.session].unverified, true);
  await lifecycleHook({ hook_event_name: 'SessionEnd', session_id: TARGET.session }, ctx.file, { env: ctx.env });
  assert.equal((await snapshot(ctx.access)).sessions[TARGET.session], undefined);
});

test('桥接注入前身份查询暂不可用暂停队列，不把它误标为已提交或丢弃正文', async t => {
  const ctx = await temp(t);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = true; });
  await processUpdate(ctx.access, message(1, '暂停后恢复'), ctx.context);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = false; });
  await drainReplies(ctx.access, { ...ctx.context, validate: async () => { throw new SessionLookupError(); } });
  let state = await snapshot(ctx.access);
  assert.equal(state.pending[TARGET.session].phase, 'queued');
  assert.equal(state.pending[TARGET.session].text, '暂停后恢复'); assert.equal(state.sessions[TARGET.session].unverified, true);
  assert.equal(ctx.inputs.length, 0);
  await lifecycleHook({ hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, { env: ctx.env, session: async () => TARGET });
  await drainReplies(ctx.access, ctx.context); assert.equal(ctx.inputs.length, 1);
});

test('已登记提交后发生身份错误也不重新排队或重放', async t => {
  const ctx = await temp(t); let attempted = 0;
  await processUpdate(ctx.access, message(1, '不重放'), { ...ctx.context, inject: async () => { attempted++; throw new SessionLookupError(); } });
  const state = await snapshot(ctx.access);
  assert.equal(state.pending[TARGET.session].phase, 'unknown'); assert.equal(state.pending[TARGET.session].text, undefined);
  await drainReplies(ctx.access, ctx.context); assert.equal(attempted, 1); assert.equal(ctx.inputs.length, 0);
});

test('暂停核验时不能登记新交互或使用旧按钮批准权限', async t => {
  const ctx = await temp(t), { request } = await boundQuestion(ctx);
  await lifecycleHook({ hook_event_name: 'Notification', session_id: TARGET.session }, ctx.file,
    { env: ctx.env, sessionLookup: async () => ({ status: 'unavailable' }) });
  await processUpdate(ctx.access, callback(1, request.id, 0, 'o0'), ctx.context);
  assert.equal((await snapshot(ctx.access)).requests[request.id].response, undefined);
  await assert.rejects(createInteraction(ctx.access, TARGET, 'permission', { tool_name: 'Bash' }), /会话|目标/);
  await assert.rejects(registerToolCall(ctx.access, TARGET, { tool_use_id: 'new', tool_name: 'Bash', tool_input: { command: 'FAKE' } }), /核验会话/);
});

test('状态写入串行化、TTL 清理与损坏文件保留', async t => {
  const ctx = await temp(t);
  await Promise.all(Array.from({ length: 8 }, () => stateTransaction(ctx.access, state => { state.offset++; })));
  assert.equal((await snapshot(ctx.access)).offset, 8);
  await stateTransaction(ctx.access, state => { state.entries.expired = { session: TARGET.session, epoch: targetEpoch(TARGET), updated: Date.now() - TTL - 1 }; });
  assert.equal((await snapshot(ctx.access)).entries.expired, undefined);
  const file = path.join(replyDirectory(ctx.file), 'state.json'); await writeFile(file, 'BROKEN_FAKE');
  await assert.rejects(snapshot(ctx.access), /无法读取/); assert.equal(await readFile(file, 'utf8'), 'BROKEN_FAKE');
});
test('Telegram 直接回复→终端提交→UserPromptSubmit 精确收到确认，重放不再输入', async t => {
  const ctx = await temp(t);
  await processUpdate(ctx.access, message(1, '执行测试\n谢谢'), ctx.context);
  assert.equal(ctx.inputs.length, 1); assert.equal(ctx.inputs[0].text, '执行测试 谢谢');
  assert.ok(ctx.calls.some(c => c.payload.text?.includes('已转发')));
  assert.equal((await snapshot(ctx.access)).pending[TARGET.session].text, undefined);
  await lifecycleHook({ hook_event_name: 'UserPromptSubmit', session_id: TARGET.session, prompt: '执行测试 谢谢' }, ctx.file,
    { env: ctx.env, session: async () => ({ ...TARGET }), api: () => ctx.api });
  assert.equal((await snapshot(ctx.access)).pending[TARGET.session], undefined);
  assert.ok(ctx.calls.some(c => c.payload.text?.includes('Claude 已收到回复')));
  await processUpdate(ctx.access, message(1, '执行测试\n谢谢'), ctx.context); assert.equal(ctx.inputs.length, 1);
});
test('收到确认保留飞书反馈，但不扩散远程回复原文', async t => {
  const ctx = await temp(t), plans = [];
  await processUpdate(ctx.access, message(1, 'PRIVATE_REPLY_CONTENT'), ctx.context);
  await atomicJson(ctx.file, { ...CONFIG, feishu: { enabled: true } });
  ctx.env.FEISHU_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/FAKE_ONLY';
  await lifecycleHook({ hook_event_name: 'UserPromptSubmit', session_id: TARGET.session, prompt: 'PRIVATE_REPLY_CONTENT' }, ctx.file,
    { env: ctx.env, session: async () => TARGET, api: () => ctx.api, send: async plan => { plans.push(plan); return { channel: plan.channel, ok: true, sent: 1, planned: 1 }; } });
  assert.equal(plans.length, 1); assert.equal(plans[0].channel, 'feishu');
  assert.ok(JSON.stringify(plans[0]).includes('Claude 已收到回复'));
  assert.ok(!JSON.stringify(plans[0]).includes('PRIVATE_REPLY_CONTENT'));
});
test('普通本地输入不冒充远程确认；会话关闭和同进程切换清理旧路由', async t => {
  const ctx = await temp(t);
  await processUpdate(ctx.access, message(1, '远程内容'), ctx.context);
  await lifecycleHook({ hook_event_name: 'UserPromptSubmit', session_id: TARGET.session, prompt: '本地内容' }, ctx.file,
    { env: ctx.env, session: async () => ({ ...TARGET }), api: () => ctx.api });
  assert.ok(!ctx.calls.some(c => c.payload.text?.includes('Claude 已收到回复')));
  const next = { ...TARGET, session: 'new-session' };
  await lifecycleHook({ hook_event_name: 'SessionStart', session_id: next.session }, ctx.file, { env: ctx.env, session: async () => next });
  assert.equal((await snapshot(ctx.access)).sessions[TARGET.session], undefined);
  await processUpdate(ctx.access, message(2, '不得误投'), ctx.context); assert.equal(ctx.inputs.length, 1);
  await lifecycleHook({ hook_event_name: 'SessionEnd', session_id: next.session }, ctx.file, { env: ctx.env });
  assert.equal((await snapshot(ctx.access)).sessions[next.session], undefined);
});
test('群聊、冒充用户、未授权通知接收人、过期消息与无路由均不能输入', async t => {
  const ctx = await temp(t);
  const updates = [message(1, 'x', { chat: { id: -333, type: 'group' } }), message(2, 'x', { from: { id: 222 } }),
    message(3, 'x', { chat: { id: 222, type: 'private' }, from: { id: 222 } }), message(4, 'x', { date: 1 }),
    message(5, 'x', { reply_to_message: { message_id: 999 } }), message(6, 'x', { reply_to_message: undefined })];
  for (const update of updates) await processUpdate(ctx.access, update, ctx.context);
  assert.equal(ctx.inputs.length, 0); assert.equal((await snapshot(ctx.access)).offset, 7);
});
test('/chatid 只返回发送者本人私聊 ID，不授予其远程权限', async t => {
  const ctx = await temp(t);
  await processUpdate(ctx.access, message(1, '/chatid', { chat: { id: 999, type: 'private' }, from: { id: 999 } }), ctx.context);
  assert.equal(ctx.calls[0].payload.chat_id, '999'); assert.match(ctx.calls[0].payload.text, /999/); assert.equal(ctx.inputs.length, 0);
});
test('内联按钮强制回复，飞书 deep link 用普通提示清除旧键盘并注册映射', async t => {
  const ctx = await temp(t), token = 'b'.repeat(32);
  await stateTransaction(ctx.access, state => { state.entries['token:' + token] = { ...state.entries['tg:111:100'] }; });
  const cb = callback(1, token, 0, 'c'); cb.callback_query.data = 'dn:r:' + token;
  await processUpdate(ctx.access, cb, ctx.context);
  const first = ctx.calls.find(c => c.method === 'sendMessage'); assert.equal(first.payload.reply_markup.force_reply, true);
  assert.ok((await snapshot(ctx.access)).entries['tg:111:501']);
  await processUpdate(ctx.access, message(2, '/start ' + token), ctx.context);
  const hint = ctx.calls.filter(c => c.method === 'sendMessage').at(-1);
  assert.deepEqual(hint.payload.reply_markup, { remove_keyboard: true });
  assert.ok((await snapshot(ctx.access)).entries['tg:111:502']);
});
test('工作中普通回复只排队；Stop 后提交，过期和目标 epoch 变化拒绝', async t => {
  const ctx = await temp(t);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = true; });
  await processUpdate(ctx.access, message(1, '排队'), ctx.context); assert.equal(ctx.inputs.length, 0);
  assert.equal((await snapshot(ctx.access)).pending[TARGET.session].text, '排队');
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = false; });
  await drainReplies(ctx.access, ctx.context); assert.equal(ctx.inputs.length, 1);
  await stateTransaction(ctx.access, state => { delete state.pending[TARGET.session]; state.sessions[TARGET.session].working = true; });
  await processUpdate(ctx.access, message(2, '旧目标'), ctx.context);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].birth = 'CHANGED'; state.sessions[TARGET.session].working = false; });
  await drainReplies(ctx.access, ctx.context); assert.equal(ctx.inputs.length, 1);
  assert.equal((await snapshot(ctx.access)).pending[TARGET.session].phase, 'unknown');
});
test('排队超过五分钟取消；已有未确认任务时不覆盖', async t => {
  const ctx = await temp(t);
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = true; });
  await processUpdate(ctx.access, message(1, '第一个'), ctx.context);
  await processUpdate(ctx.access, message(2, '第二个'), ctx.context);
  assert.equal((await snapshot(ctx.access)).pending[TARGET.session].text, '第一个');
  await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = false; state.pending[TARGET.session].updated = Date.now() - 300001; });
  await drainReplies(ctx.access, ctx.context); assert.equal(ctx.inputs.length, 0);
});
test('注入失败/部分写入不重试、删除明文；最终授权撤销时不输入', async t => {
  const ctx = await temp(t); let count = 0;
  await processUpdate(ctx.access, message(1, '不得重放'), { ...ctx.context, inject: async () => { count++; throw new Error('FAKE_SECRET'); } });
  await drainReplies(ctx.access, ctx.context); assert.equal(count, 1);
  assert.equal((await snapshot(ctx.access)).pending[TARGET.session].text, undefined);
  assert.ok(!JSON.stringify(ctx.calls).includes('FAKE_SECRET'));
  await stateTransaction(ctx.access, state => { delete state.pending[TARGET.session]; });
  await processUpdate(ctx.access, message(2, '已撤销'), { ...ctx.context, fresh: async () => null }); assert.equal(ctx.inputs.length, 0);
});
test('超长回复不截断、不拆任务，控制字符不触发终端按键', () => {
  assert.equal(sanitizeReply('  中文\r\n下一行\x1b[31m\u2028 x  '), '中文 下一行 [31m  x');
  assert.equal(sanitizeReply('😀'.repeat(4000)).length, 8000);
  assert.throws(() => sanitizeReply('😀'.repeat(4001)), /4000/);
  assert.throws(() => sanitizeReply('\x1b\x00'), /没有可提交的内容/);
});
test('完成通知每段带按钮、只授权私聊可用；飞书跳转；每段发送后立即映射', async t => {
  const ctx = await temp(t), message = { title: '完成', content: '中文😀\n'.repeat(2000), level: 'success', footer: '' };
  const binding = await attachReply(message, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file,
    { env: ctx.env, session: async () => TARGET, bridge: async () => true, api: () => ctx.api });
  assert.ok(binding); assert.match(message.reply.url, /^https:\/\/t.me\/FakeTestBot\?start=/);
  const plan = makePlan('telegram', message, ctx.access.config); mapReplies(plan, binding);
  assert.ok(plan.items.length > 3);
  assert.ok(plan.items.filter(i => i.recipient === '111').every(i => i.payload.reply_markup));
  assert.ok(plan.items.filter(i => i.recipient !== '111').every(i => !i.payload.reply_markup));
  let id = 800;
  assert.equal((await deliver(plan, ctx.access.config, async () => ({ ok: true, result: { message_id: ++id } }))).ok, true);
  assert.ok((await snapshot(ctx.access)).entries['tg:111:801']);
  const feishu = makePlan('feishu', message, ctx.access.config);
  assert.ok(feishu.items.every(i => i.payload.card.elements.some(e => e.tag === 'action')));
});
for (const scenario of [
  { name: '桥接未就绪仍发送双渠道普通通知', bridge: false, identity: true, telegram: true },
  { name: '身份查询失败不误报桥接故障且普通通知仍发送', bridge: true, identity: false, telegram: true },
  { name: '身份查询及Telegram投递失败时仅飞书成功且无按钮', bridge: true, identity: false, telegram: false },
  { name: '桥接未就绪及Telegram投递失败时仅飞书成功且无按钮', bridge: false, identity: true, telegram: false },
  { name: '恢复后双渠道带按钮且逐段建立映射', bridge: true, identity: true, telegram: true },
]) test(scenario.name, async t => {
  const ctx = await temp(t);
  await atomicJson(ctx.file, { ...CONFIG, telegram: { enabled: true, chat_ids: ['111'] }, feishu: { enabled: true } });
  const env = { ...ctx.env, FEISHU_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/FAKE_ONLY' };
  const received = [], errors = [], attempts = [];
  const { t: translate } = await import('../dist/i18n.js');
  await dispatchClaudeHook(Buffer.from(JSON.stringify({ hook_event_name: 'Stop', session_id: TARGET.session,
    last_assistant_message: '隔离测试', cwd: TARGET.cwd })), ctx.file, {
    env, err: text => errors.push(text),
    reply: { session: async () => TARGET, bridge: async () => scenario.bridge, api: () => async () => {
      if (!scenario.identity) throw new TransportError('FAKE_SECRET https://fake.invalid/bot123');
      return { username: 'FakeTestBot' };
    } },
    send: async (plan, config) => deliver(plan, config, async (_url, payload) => {
      attempts.push(plan.channel);
      if (plan.channel === 'telegram' && !scenario.telegram) throw new TransportError(translate('channels.network'));
      received.push({ channel: plan.channel, button: plan.channel === 'telegram' ? !!payload.reply_markup
        : payload.card.elements.some(element => element.tag === 'action') });
      return plan.channel === 'telegram' ? { ok: true, result: { message_id: 900 } } : { code: 0 };
    }),
  });
  assert.deepEqual(attempts, ['telegram', 'feishu']); // 不因失败自动重发，也不跳过普通 Telegram 通知。
  const button = scenario.bridge && scenario.identity;
  assert.deepEqual(received, [...(scenario.telegram ? [{ channel: 'telegram', button }] : []), { channel: 'feishu', button }]);
  const text = errors.join('\n');
  assert.ok(!/FAKE_SECRET|fake\.invalid|bot123/.test(text));
  if (!scenario.bridge) assert.match(text, /桥接还没有就绪/);
  else if (!scenario.identity) { assert.match(text, /getMe.*网络请求失败/); assert.doesNotMatch(text, /桥接还没有就绪/); }
  if (!scenario.telegram) assert.match(text, /telegram.*API 确认 0\/1.*网络请求失败/);
  const diagnosticText = await readFile(path.join(replyDirectory(ctx.file), 'notification-diagnostics', TARGET.session + '.json'), 'utf8');
  const diagnostic = JSON.parse(diagnosticText);
  assert.equal(diagnostic.reply, !scenario.bridge ? 'bridge-unready' : !scenario.identity ? 'getme-failed' : 'attached');
  assert.equal(diagnostic.channels.telegram.status, scenario.telegram ? 'complete' : 'incomplete');
  assert.doesNotMatch(diagnosticText, /FAKE_SECRET|fake\.invalid|bot123|FakeTestBot/);
  if (button) {
    assert.deepEqual(errors, []);
    assert.ok((await snapshot(ctx.access)).entries['tg:111:900']);
  }
});

test('首次通知getMe连接重置后只读重试恢复，第二次通知正常且发送不重复', async t => {
  const ctx = await temp(t), previous = globalThis.fetch, waits = [], requests = [];
  await atomicJson(ctx.file, { ...CONFIG, telegram: { enabled: true, chat_ids: ['111'] }, feishu: { enabled: true } });
  const env = { ...ctx.env, FEISHU_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/FAKE_ONLY' };
  let reset = true, messageId = 1000;
  globalThis.fetch = async url => {
    const telegram = new URL(url).hostname === 'api.telegram.org';
    const method = telegram ? new URL(url).pathname.split('/').pop() : 'feishu'; requests.push(method);
    if (method === 'getMe' && reset) { reset = false; throw new TypeError('PRIVATE', { cause: Object.assign(new Error('PRIVATE_TOKEN'), { code: 'ECONNRESET' }) }); }
    return new Response(JSON.stringify(!telegram ? { code: 0 } : { ok: true, result: method === 'getMe' ? { username: 'FakeTestBot' } : { message_id: ++messageId } }));
  };
  try {
    for (const turn of [1, 2]) {
      await dispatchClaudeHook(Buffer.from(JSON.stringify({ hook_event_name: 'Stop', session_id: TARGET.session,
        last_assistant_message: '首次通知模拟', cwd: TARGET.cwd })), ctx.file, {
        env, err: text => assert.fail(text), send: deliver,
        reply: { session: async () => TARGET, bridge: async () => true, sleep: async ms => waits.push(ms) },
      });
      const diagnostic = JSON.parse(await readFile(path.join(replyDirectory(ctx.file), 'notification-diagnostics', TARGET.session + '.json'), 'utf8'));
      assert.equal(diagnostic.reply, 'attached'); assert.equal(diagnostic.identityRetries, turn === 1 ? 1 : undefined);
      assert.equal(diagnostic.channels.telegram.status, 'complete'); assert.equal(diagnostic.channels.feishu.status, 'complete');
    }
    assert.deepEqual(requests, ['getMe', 'getMe', 'sendMessage', 'feishu', 'getMe', 'sendMessage', 'feishu']);
    assert.deepEqual(waits, [1000]);
  } finally { globalThis.fetch = previous; }
});
test('首次通知持续reset时保留精确发送原因，下一次正常；不自动重发通知', async t => {
  const ctx = await temp(t), previous = globalThis.fetch;
  await atomicJson(ctx.file, { ...CONFIG, telegram: { enabled: true, chat_ids: ['111'] }, feishu: { enabled: true } });
  const env = { ...ctx.env, FEISHU_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/FAKE_ONLY' };
  let turn = 1, getMe = 0, sends = 0;
  globalThis.fetch = async url => {
    const tg = new URL(url).hostname === 'api.telegram.org', method = tg ? new URL(url).pathname.split('/').pop() : 'feishu';
    if (method === 'getMe') getMe++;
    if (method === 'sendMessage') sends++;
    if (tg && turn === 1) throw new TypeError('PRIVATE', { cause: Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' }) });
    return new Response(JSON.stringify(tg ? { ok: true, result: method === 'getMe' ? { username: 'FakeTestBot' } : { message_id: 1100 } } : { code: 0 }));
  };
  try {
    for (turn = 1; turn <= 2; turn++) {
      await dispatchClaudeHook(Buffer.from(JSON.stringify({ hook_event_name: 'Stop', session_id: TARGET.session, last_assistant_message: 'FAKE_BODY' })), ctx.file, {
        env, err: () => {}, send: deliver, reply: { session: async () => TARGET, bridge: async () => true, sleep: async () => {} },
      });
      const text = await readFile(path.join(replyDirectory(ctx.file), 'notification-diagnostics', TARGET.session + '.json'), 'utf8');
      const d = JSON.parse(text);
      assert.equal(d.reply, turn === 1 ? 'getme-failed' : 'attached');
      assert.equal(d.channels.telegram.status, turn === 1 ? 'incomplete' : 'complete');
      assert.equal(d.channels.feishu.status, 'complete');
      if (turn === 1) assert.match(d.channels.telegram.reason, /ECONNRESET/);
      assert.doesNotMatch(text, /PRIVATE|FAKE_BODY|FAKE_ONLY/);
    }
    assert.equal(getMe, 4); assert.equal(sends, 2); // 首轮 getMe 重试 2 次；两轮各只尝试发送一次，不自动重发。
    const failure = JSON.parse(await readFile(path.join(replyDirectory(ctx.file), 'notification-failures', TARGET.session + '.json'), 'utf8'));
    assert.equal(failure.reply, 'getme-failed'); assert.equal(failure.identityRetries, 2);
  } finally { globalThis.fetch = previous; }
});
for (const resetSend of [false, true]) test(`真实桥接初始化身份可兜底首次getMe三次reset，发送${resetSend ? '失败也不重发' : '成功带双渠道按钮'}`, async t => {
  const ctx = await temp(t), previous = globalThis.fetch, methods = [], buttons = [];
  await atomicJson(ctx.file, { ...CONFIG, telegram: { enabled: true, chat_ids: ['111'] }, feishu: { enabled: true } });
  const env = { ...ctx.env, FEISHU_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/FAKE_ONLY' };
  globalThis.fetch = async (url, options) => {
    const tg = new URL(url).hostname === 'api.telegram.org';
    const method = tg ? new URL(url).pathname.split('/').pop() : 'feishu'; methods.push(method);
    if (method === 'getMe' || method === 'sendMessage' && resetSend)
      throw new TypeError('PRIVATE', { cause: Object.assign(new Error('PRIVATE_TOKEN'), { code: 'ECONNRESET' }) });
    const payload = JSON.parse(options.body);
    buttons.push(tg ? !!payload.reply_markup : payload.card.elements.some(e => e.tag === 'action'));
    return new Response(JSON.stringify(tg ? { ok: true, result: { message_id: 1200 } } : { code: 0 }));
  };
  try {
    await runBridge(ctx.file, { env, maxIterations: 1, api: () => async (method, payload) => {
      if (method !== 'getUpdates') return ctx.api(method, payload);
      await dispatchClaudeHook(Buffer.from(JSON.stringify({ hook_event_name: 'Stop', session_id: TARGET.session, last_assistant_message: 'FAKE_BODY' })), ctx.file, {
        env, err: () => {}, send: deliver, reply: { session: async () => TARGET, sleep: async () => {} },
      });
      return [];
    } });
    assert.deepEqual(methods, ['getMe', 'getMe', 'getMe', 'sendMessage', 'feishu']);
    assert.deepEqual(buttons, resetSend ? [true] : [true, true]);
    const text = await readFile(path.join(replyDirectory(ctx.file), 'notification-diagnostics', TARGET.session + '.json'), 'utf8');
    const d = JSON.parse(text);
    assert.equal(d.reply, 'attached'); assert.equal(d.identityRetries, 2); assert.equal(d.identityFallback, 'bridge');
    assert.equal(d.channels.telegram.status, resetSend ? 'incomplete' : 'complete');
    assert.equal(d.channels.feishu.status, 'complete');
    if (resetSend) assert.match(d.channels.telegram.reason, /ECONNRESET/);
    else assert.ok((await snapshot(ctx.access)).entries['tg:111:1200']);
    assert.doesNotMatch(text, /PRIVATE|FAKE_BODY|FAKE_ONLY|FakeTestBot/);
  } finally { globalThis.fetch = previous; }
});
async function identityLease(ctx) {
  await atomicJson(path.join(replyDirectory(ctx.file), 'bridge.json'), { pid: process.pid, owner: 'b'.repeat(32), ready: true,
    updated: Date.now(), identity: ctx.access.identity, botUsername: 'CachedTestBot' });
}
for (const failure of ['401', 'network', 'invalid-username', 'retry-401'])
test(`getMe ${failure}不使用桥接身份掩盖失败`, async t => {
  const ctx = await temp(t); await identityLease(ctx);
  let calls = 0; const codes = [], notification = { title: '完成', content: '', footer: '', level: 'success' };
  await assert.rejects(attachReply(notification, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, {
    env: ctx.env, session: async () => TARGET, sleep: async () => {}, replyDiagnostic: code => codes.push(code),
    api: () => async () => {
      calls++;
      if (failure === 'retry-401' && calls === 1) throw new TelegramConnectionResetError();
      if (failure.includes('401')) throw new TelegramRequestError(401);
      if (failure === 'network') throw new TransportError('FAKE');
      return { username: 'invalid/name' };
    },
  }));
  assert.equal(calls, failure === 'retry-401' ? 2 : 1);
  assert.equal(notification.reply, undefined); assert.ok(!codes.includes('getme-bridge-fallback'));
});
test('新getMe结果优先于桥接缓存，并在请求期间目标变化时拒绝按钮', async t => {
  for (const changed of [false, true]) {
    const ctx = await temp(t); await identityLease(ctx); let queried = false;
    const codes = [], notification = { title: '完成', content: '', footer: '', level: 'success' };
    const result = await attachReply(notification, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, {
      env: ctx.env, session: async () => changed && queried ? { ...TARGET, birth: 'NEW' } : TARGET,
      api: () => async () => { queried = true; return { username: 'FreshTestBot' }; }, replyDiagnostic: code => codes.push(code),
    });
    if (changed) { assert.equal(result, null); assert.equal(notification.reply, undefined); }
    else { assert.ok(result); assert.match(notification.reply.url, /FreshTestBot/); }
    assert.ok(!codes.includes('getme-bridge-fallback'));
  }
});
for (const change of ['revoke', 'generation', 'users', 'permissions', 'identity', 'working', 'untracked', 'unverified', 'ended', 'bridge'])
test(`最后一次getMe reset之后的${change}变化阻止身份兜底`, async t => {
  const ctx = await temp(t); await identityLease(ctx);
  let calls = 0, changed = false; const codes = [], notification = { title: '完成', content: '', footer: '', level: 'success' };
  const result = await attachReply(notification, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, {
    env: ctx.env, session: async () => changed && change === 'identity' ? { ...TARGET, birth: 'NEW' } : TARGET,
    sleep: async () => {}, replyDiagnostic: code => codes.push(code),
    api: () => async () => {
      if (++calls === 3) {
        changed = true;
        if (['revoke', 'generation', 'users', 'permissions'].includes(change)) await atomicJson(policyPath(ctx.file), { ...ctx.policy,
          ...(change === 'revoke' ? { enabled: false } : change === 'generation' ? { generation: 'c'.repeat(32) }
            : change === 'users' ? { users: ['222'] } : { permissions: false }) });
        else if (change === 'bridge') await atomicJson(path.join(replyDirectory(ctx.file), 'bridge.json'), { pid: process.pid, ready: false, updated: Date.now() });
        else await stateTransaction(ctx.access, state => {
          if (change === 'working') state.sessions[TARGET.session].working = true;
          if (change === 'untracked') state.sessions[TARGET.session].tracked = false;
          if (change === 'unverified') state.sessions[TARGET.session].unverified = true;
          if (change === 'ended') delete state.sessions[TARGET.session];
        });
      }
      throw new TelegramConnectionResetError();
    },
  });
  assert.equal(result, null); assert.equal(notification.reply, undefined); assert.equal(calls, 3);
  assert.ok(!codes.includes('getme-bridge-fallback'));
});
for (const fallback of [false, true]) test(`token提交事务阻止最后桥接检查期间的新本地输入，身份${fallback ? '兜底' : '直查'}`, async t => {
  const ctx = await temp(t); await identityLease(ctx);
  let checks = 0, calls = 0; const codes = [], notification = { title: '完成', content: '', footer: '', level: 'success' };
  const result = await attachReply(notification, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, {
    env: ctx.env, session: async () => TARGET, sleep: async () => {}, replyDiagnostic: code => codes.push(code),
    bridge: async () => {
      if (++checks === (fallback ? 5 : 2)) await stateTransaction(ctx.access, state => { state.sessions[TARGET.session].working = true; });
      return true;
    },
    api: () => async () => { calls++; if (fallback) throw new TelegramConnectionResetError(); return { username: 'FreshTestBot' }; },
  });
  assert.equal(result, null); assert.equal(notification.reply, undefined); assert.equal(calls, fallback ? 3 : 1);
  assert.ok(!codes.includes('getme-bridge-fallback'));
  assert.equal(Object.keys((await snapshot(ctx.access)).entries).filter(key => key.startsWith('token:')).length, 0);
});
test('最终reset后更换Token时不使用旧桥接身份', async t => {
  const ctx = await temp(t); await identityLease(ctx); let calls = 0;
  const codes = [], notification = { title: '完成', content: '', footer: '', level: 'success' };
  await assert.rejects(attachReply(notification, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, {
    env: ctx.env, session: async () => TARGET, sleep: async () => {}, replyDiagnostic: code => codes.push(code),
    api: () => async () => {
      if (++calls === 3) ctx.env.TELEGRAM_BOT_TOKEN = '124:FAKE_OTHER';
      throw new TelegramConnectionResetError();
    },
  }));
  assert.equal(calls, 3); assert.equal(notification.reply, undefined); assert.ok(!codes.includes('getme-bridge-fallback'));
});
test('身份兜底前本地核验异常保持check-failed，不误标为getMe reset失败', async t => {
  const ctx = await temp(t); await identityLease(ctx); let calls = 0;
  await dispatchClaudeHook(Buffer.from(JSON.stringify({ hook_event_name: 'Stop', session_id: TARGET.session })), ctx.file, {
    env: ctx.env, err: () => {}, send: async plan => ({ channel: plan.channel, ok: true, sent: plan.items.length, planned: plan.items.length }),
    reply: { session: async () => TARGET, sleep: async () => {}, api: () => async () => {
      if (++calls === 3) await writeFile(path.join(replyDirectory(ctx.file), 'stop.json'), 'invalid-json');
      throw new TelegramConnectionResetError();
    } },
  });
  const d = JSON.parse(await readFile(path.join(replyDirectory(ctx.file), 'notification-diagnostics', TARGET.session + '.json'), 'utf8'));
  assert.equal(d.reply, 'check-failed'); assert.equal(d.identityFallback, undefined); assert.equal(calls, 3);
});

for (const change of ['revoke', 'generation', 'identity', 'working', 'untracked', 'unverified', 'bridge'])
test(`按钮查询重试前重新核验：${change}`, async t => {
  const ctx = await temp(t), codes = []; let calls = 0, changed = false;
  const notification = { title: '完成', content: '测试', footer: '', level: 'success' };
  const binding = await attachReply(notification, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, {
    env: ctx.env, session: async () => changed && change === 'identity' ? { ...TARGET, birth: 'NEW' } : TARGET,
    bridge: async () => !(changed && change === 'bridge'), replyDiagnostic: code => codes.push(code),
    api: () => async () => { calls++; throw new TelegramConnectionResetError(); },
    sleep: async () => {
      changed = true;
      if (change === 'revoke' || change === 'generation') await atomicJson(policyPath(ctx.file), { ...ctx.policy,
        ...(change === 'revoke' ? { enabled: false } : { generation: 'b'.repeat(32) }) });
      else await stateTransaction(ctx.access, state => {
        if (change === 'working') state.sessions[TARGET.session].working = true;
        if (change === 'untracked') state.sessions[TARGET.session].tracked = false;
        if (change === 'unverified') state.sessions[TARGET.session].unverified = true;
      });
    },
  });
  assert.equal(binding, null); assert.equal(notification.reply, undefined); assert.equal(calls, 1);
  assert.equal(codes[0], 'getme-reset-retry');
});
test('按钮查询连续三次reset仍失败，不无限重试、不生成假按钮', async t => {
  const ctx = await temp(t), waits = []; let calls = 0;
  const notification = { title: '完成', content: '测试', footer: '', level: 'success' };
  await assert.rejects(attachReply(notification, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file, {
    env: ctx.env, session: async () => TARGET, bridge: async () => true,
    api: () => async () => { calls++; throw new TelegramConnectionResetError(); }, sleep: async ms => { waits.push(ms); },
  }), /getMe.*ECONNRESET/);
  assert.equal(calls, 3); assert.deepEqual(waits, [1000, 3000]); assert.equal(notification.reply, undefined);
});
test('桥接不就绪不展示假按钮；映射落盘失败不重发已发送段', async t => {
  const ctx = await temp(t), msg = { title: '完成', content: '正文', footer: '', level: 'success' };
  assert.equal(await attachReply(msg, { hook_event_name: 'Stop', session_id: TARGET.session }, ctx.file,
    { env: ctx.env, session: async () => TARGET, bridge: async () => false }), null);
  assert.equal(msg.reply, undefined);
  const plan = makePlan('telegram', msg, ctx.access.config); plan.onSent = async () => { throw new Error('FAIL'); };
  let sends = 0;
  const result = await deliver(plan, ctx.access.config, async () => { sends++; return { ok: true }; });
  assert.equal(result.ok, false); assert.equal(sends, 3); assert.equal(result.sent, 3);
});
test('结构化单选原样回传 questions / answers，未使用终端注入', async t => {
  const ctx = await temp(t), input = { questions: [QUESTION], metadata: { keep: true } };
  const request = await createInteraction(ctx.access, TARGET, 'question', input);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  await processUpdate(ctx.access, callback(1, request.id, 0, 'o1'), ctx.context);
  const response = await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
  assert.equal(response.hookSpecificOutput.decision.behavior, 'allow');
  assert.deepEqual(response.hookSpecificOutput.decision.updatedInput.questions, input.questions);
  assert.deepEqual(response.hookSpecificOutput.decision.updatedInput.metadata, input.metadata);
  assert.deepEqual(response.hookSpecificOutput.decision.updatedInput.answers, { '选择框架？': 'Vue' }); assert.equal(ctx.inputs.length, 0);
});
test('结构化多选、提交、下一题和自定义答案，旧按钮不能回答新问题', async t => {
  const ctx = await temp(t), q1 = { ...QUESTION, multiSelect: true }, q2 = { ...QUESTION, question: '其他需求？' };
  const request = await createInteraction(ctx.access, TARGET, 'question', { questions: [q1, q2] });
  await processUpdate(ctx.access, callback(1, request.id, 0, 'o0'), ctx.context);
  await processUpdate(ctx.access, callback(2, request.id, 0, 'o1'), ctx.context);
  await processUpdate(ctx.access, callback(3, request.id, 0, 's'), ctx.context);
  await processUpdate(ctx.access, callback(4, request.id, 0, 'o1'), ctx.context);
  assert.equal((await snapshot(ctx.access)).requests[request.id].index, 1);
  await processUpdate(ctx.access, callback(5, request.id, 1, 'c'), ctx.context);
  const last = ctx.calls.filter(c => c.method === 'sendMessage').at(-1);
  assert.equal(last.payload.reply_markup.force_reply, true);
  const state = await snapshot(ctx.access), key = Object.keys(state.entries).filter(k => k.startsWith('tg:111:') && state.entries[k].question === 1).at(-1);
  const replyId = Number(key.split(':').at(-1));
  await processUpdate(ctx.access, message(6, '  自定义完整答案\n保留换行', { reply_to_message: { message_id: replyId } }), ctx.context);
  const response = await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
  assert.deepEqual(response.hookSpecificOutput.decision.updatedInput.answers, { '选择框架？': 'React,Vue', '其他需求？': '  自定义完整答案\n保留换行' });
  assert.equal(ctx.inputs.length, 0);
});
test('本次权限允许与拒绝走专用 hook JSON，绝不持久写规则', async t => {
  const ctx = await temp(t);
  for (const [op, behavior] of [['a', 'allow'], ['d', 'deny']]) {
    const request = await createInteraction(ctx.access, TARGET, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm test' }, permission_suggestions: ['NOT_UI_OPTIONS'] });
    assert.match(interactionContent(request), /没有提供完整的本地按钮列表/);
    await processUpdate(ctx.access, callback(op === 'a' ? 1 : 2, request.id, 0, op), ctx.context);
    const response = await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
    assert.equal(response.hookSpecificOutput.hookEventName, 'PermissionRequest');
    assert.deepEqual(response.hookSpecificOutput.decision, { behavior });
    assert.equal(response.hookSpecificOutput.decision.updatedPermissions, undefined);
  }
  assert.equal(ctx.inputs.length, 0);
});
test('自定义权限反馈仅拒绝说明，不变相批准；未授权权限处理拒绝', async t => {
  const ctx = await temp(t), request = await createInteraction(ctx.access, TARGET, 'permission', { tool_name: 'Bash', tool_input: {} });
  await processUpdate(ctx.access, callback(1, request.id, 0, 'c'), ctx.context);
  const state = await snapshot(ctx.access), key = Object.keys(state.entries).filter(k => state.entries[k].request === request.id && k.startsWith('tg:')).at(-1);
  await processUpdate(ctx.access, message(2, '先检查文件', { reply_to_message: { message_id: Number(key.split(':').at(-1)) } }), ctx.context);
  const response = await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 });
  assert.deepEqual(response.hookSpecificOutput.decision, { behavior: 'deny', message: '先检查文件' });
  await assert.rejects(createInteraction({ ...ctx.access, policy: { ...ctx.access.policy, permissions: false } }, TARGET, 'permission', {}), /未授权/);
});
test('交互超时、撤销或会话切换不默认选择，坏问题不猜选项', async t => {
  const ctx = await temp(t), request = await createInteraction(ctx.access, TARGET, 'question', { questions: [QUESTION] });
  assert.equal(await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 0 }), null);
  const second = await createInteraction(ctx.access, TARGET, 'question', { questions: [QUESTION] });
  assert.equal(await waitInteraction(ctx.access, second, async () => null), null);
  assert.throws(() => questionsFrom({ questions: [] }), /问题结构/);
  assert.throws(() => questionsFrom({ questions: [{ ...QUESTION, options: [] }] }), /问题结构/);
  assert.equal(ctx.inputs.length, 0);
});
test('超时结束的旧按钮显示未作答，不显示为已处理', async t => {
  const ctx = await temp(t), { request } = await boundQuestion(ctx);
  await showInteraction(ctx.access, request.id, '111', ctx.api);
  await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 0 });
  await flushFeedback(ctx);
  const edit = ctx.calls.find(c => c.method === 'editMessageReplyMarkup');
  assert.ok(edit);
  assert.equal(edit.payload.reply_markup.inline_keyboard[0][0].text, '已超时 · 未作答');
});
test('结构化 hook 完整路径：展示所有选项→生成控制输出，未授权时完全不联网', async t => {
  const ctx = await temp(t), responses = [];
  const data = { session_id: TARGET.session, tool_use_id: 'question-1', tool_name: 'AskUserQuestion', tool_input: { questions: [QUESTION] } };
  await interactionHook({ ...data, hook_event_name: 'PreToolUse' }, ctx.file, { env: ctx.env, session: async () => TARGET });
  assert.equal(ctx.calls.length, 0);
  await interactionHook({ ...data, hook_event_name: 'PermissionRequest' }, ctx.file,
    { env: ctx.env, session: async () => TARGET, api: () => ctx.api, bridge: async () => true, response: r => responses.push(r),
      wait: async (access, request) => {
        await processUpdate(access, callback(1, request.id, 0, 'o0'), ctx.context);
        return waitInteraction(access, request, ctx.context.fresh, { timeout: 100 });
      } });
  const text = ctx.calls.filter(c => c.method === 'sendMessage').map(c => c.payload.text).join('\n');
  assert.match(text, /React/); assert.match(text, /Vue/); assert.equal(responses.length, 1);
  await atomicJson(policyPath(ctx.file), { ...ctx.policy, enabled: false });
  await interactionHook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }, ctx.file,
    { env: ctx.env, api: () => assert.fail('未授权不得联网') });
});
test('Telegram API 冲突安全退出，不调用 deleteWebhook、不泄漏 Token', async () => {
  const api = telegramApi('123:FAKE_SECRET', async () => ({ ok: false, error_code: 409, description: 'FAKE_SECRET' }));
  await assert.rejects(api('getUpdates', {}), error => /冲突/.test(error.message) && !error.message.includes('FAKE_SECRET'));
  await assert.rejects(api('deleteWebhook', {}), /不支持/);
});
test('桥接真实循环的隔离 API：单例锁、工作流、offset、结束清理', async t => {
  const ctx = await temp(t); let iterations = 0;
  const api = async (method, payload) => method === 'getUpdates' ? ++iterations === 1 ? [message(1, '桥接回复')] : [] : ctx.api(method, payload);
  await runBridge(ctx.file, { env: ctx.env, api: () => api, maxIterations: 1, validate: ctx.context.validate, inject: ctx.context.inject });
  assert.equal(ctx.inputs.length, 1); assert.equal((await snapshot(ctx.access)).offset, 2);
  assert.equal((await bridgeStatus(ctx.file)).running, false);
  assert.deepEqual(await readdir(path.join(appPaths(process.platform, ctx.env).data, 'reply-bots')), []);
});
test('桥接每轮跟随配置语言，切换后不再混用中英文', async t => {
  const ctx = await temp(t), polls = [];
  await atomicJson(ctx.file, { ...CONFIG, language: 'en' });
  const api = async (method, payload) => {
    if (method === 'getUpdates') {
      polls.push(payload);
      return polls.length === 1 ? [message(1, 'first', { reply_to_message: undefined })]
        : polls.length === 2 ? [message(2, 'second', { reply_to_message: undefined })] : [];
    }
    const result = await ctx.api(method, payload);
    // 第一轮发送后切换配置；桥接下一轮读取时应立即改用新语言。
    if (method === 'sendMessage' && polls.length === 1) await atomicJson(ctx.file, { ...CONFIG, language: 'zh' });
    return result;
  };
  await runBridge(ctx.file, { env: ctx.env, api: () => api, maxIterations: 2 });
  const texts = ctx.calls.filter(call => call.method === 'sendMessage').map(call => call.payload.text);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /How to reply/);
  assert.match(texts[1], /回复方式/);
});
test('webhook 与残留 Bot 锁不抢占，停止不会 kill 复用 PID', async t => {
  const ctx = await temp(t);
  await assert.rejects(runBridge(ctx.file, { env: ctx.env, api: () => async () => ({ url: 'FAKE_ONLY' }), maxIterations: 0 }), /webhook/);
  const directory = path.join(appPaths(process.platform, ctx.env).data, 'reply-bots');
  await writeFile(path.join(directory, ctx.policy.bot + '.lock'), 'existing-owner');
  await assert.rejects(runBridge(ctx.file, { env: ctx.env, api: () => ctx.api }), /同一个 Bot/);
  assert.equal(await readFile(path.join(directory, ctx.policy.bot + '.lock'), 'utf8'), 'existing-owner');
  assert.equal(await stopBridge(path.join(ctx.root, 'unused-config.json')), true);
});
test('桥接记录网络错误原因，而不是只留下通用失败', async t => {
  const ctx = await temp(t), message = '网络请求失败或响应无效。';
  await assert.rejects(runBridge(ctx.file, { env: ctx.env, api: () => async () => { throw new TransportError(message); }, maxIterations: 0 }),
    error => error.message === message);
  assert.equal((await bridgeStatus(ctx.file)).error, message);
});
test('macOS 进程身份必须是前台 claude，Windows 进程名称/生日必须可验证', async () => {
  assert.deepEqual(await processIdentity(123, 'win32', async (_c, args, input) => {
    assert.match(Buffer.from(args.at(-1), 'base64').toString('utf16le'), /ProcessName/); assert.equal(JSON.parse(input).pid, 123);
    return { code: 0, stdout: '{"birth":"123"}' };
  }), { birth: '123', tty: '' });
  assert.equal(await processIdentity(123, 'win32', async () => ({ code: 3, stdout: '' })), null);
  const mac = async (_c, args) => ({ code: 0, stdout: args.includes('pgid=') ? '99 99' : 'Tue Nov  3 10:00:00 2026 ttys007 /opt/bin/claude' });
  assert.equal((await processIdentity(123, 'darwin', mac)).tty, '/dev/ttys007');
  assert.equal(await processIdentity(123, 'darwin', async (_c, args) => args.includes('pgid=') ? { code: 0, stdout: '99 100' } : mac(_c, args)), null);
});
test('会话元数据精确查找、重复 ID/进程出生变化一律拒绝', async t => {
  const ctx = await temp(t), directory = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'sessions'); await mkdir(directory, { recursive: true });
  await atomicJson(path.join(directory, '12345.json'), { sessionId: TARGET.session, pid: TARGET.pid, cwd: 'C:\\test', name: '测试' });
  const options = { env: ctx.env, platform: 'win32', runner: async () => ({ code: 0, stdout: JSON.stringify({ birth: TARGET.birth }) }) };
  assert.equal(await findSession(TARGET.session, { ...options, platform: 'linux' }), null);
  const found = await findSession(TARGET.session, options); assert.equal(found.pid, TARGET.pid);
  assert.equal(await validateTarget({ ...found, birth: 'OLD' }, options), false);
  await atomicJson(path.join(directory, '12346.json'), { sessionId: TARGET.session, pid: 12346 });
  assert.equal(await findSession(TARGET.session, options), null);
});
test('会话名称读取只接受匹配 sessionId 的注册表名称，缺失或损坏时为空', async t => {
  const ctx = await temp(t), directory = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'sessions'); await mkdir(directory, { recursive: true });
  assert.equal(await findSessionName(TARGET.session, { env: ctx.env }), '');
  await writeFile(path.join(directory, '1.json'), '{BROKEN');
  await writeFile(path.join(directory, '2.json'), Buffer.alloc(128 * 1024 + 1));
  await atomicJson(path.join(directory, '3.json'), { sessionId: TARGET.session, name: '隔离测试会话' });
  await atomicJson(path.join(directory, '4.json'), { sessionId: 'other-session', name: '其他' });
  assert.equal(await findSessionName(TARGET.session, { env: ctx.env }), '隔离测试会话');
  assert.equal(await findSessionName('other-session', { env: ctx.env }), '其他');
  assert.equal(await findSessionName('../bad', { env: ctx.env }), '');
});
test('Windows 注入脚本通过 stdin 传文本，原生帮助类单独编译验证但绝不调用 Send', { skip: process.platform !== 'win32' }, async t => {
  const ctx = await temp(t), directory = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'sessions'); await mkdir(directory, { recursive: true });
  await atomicJson(path.join(directory, '12345.json'), { sessionId: TARGET.session, pid: TARGET.pid });
  let script;
  const text = '中文😀 $() " ; \\ 测试';
  await injectReply(TARGET, text, { env: ctx.env, runner: async (command, args, input) => {
    const decoded = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.ok(!args.join(' ').includes(text));
    if (decoded.includes('DevNotifyConsole')) { script = decoded; assert.equal(JSON.parse(input).text, text); }
    return { code: 0, stdout: JSON.stringify({ birth: TARGET.birth }) };
  } });
  const code = script.match(/Add-Type -TypeDefinition @'\n([\s\S]+)\n'@/)[1];
  assert.match(code, /GetConsoleProcessList/); assert.match(code, /CharSet=CharSet.Unicode/);
  const compile = '$ErrorActionPreference="Stop";[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -TypeDefinition ([Console]::In.ReadToEnd());[Runtime.InteropServices.Marshal]::SizeOf([type][DevNotifyConsole+Record])';
  const result = await runCommand(path.win32.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(compile, 'utf16le').toString('base64')], code);
  assert.equal(result.code, 0); assert.equal(result.stdout.trim(), '20');
});
test('macOS tmux 字面缓冲区与 Ghostty 精确 TTY 路由；部分失败绝不换通道重发', async t => {
  const ctx = await temp(t), directory = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'sessions'); await mkdir(directory, { recursive: true });
  await atomicJson(path.join(directory, '12345.json'), { sessionId: TARGET.session, pid: TARGET.pid });
  const target = { ...TARGET, birth: 'Tue Nov 3 10:00:00 2026', tty: '/dev/ttys007' }, calls = [];
  const text = '中文😀 $(do-not-execute) \\"quote\\" \\\\x0a';
  let tmux = true, failPaste = false;
  const runner = async (command, args, input) => {
    calls.push({ command, args, input });
    if (command === '/bin/ps') return { code: 0, stdout: args.includes('pgid=') ? '99 99' : 'Tue Nov  3 10:00:00 2026 ttys007 /opt/bin/claude' };
    if (command === 'tmux' && args[0] === 'list-panes') return { code: tmux ? 0 : 1, stdout: '%7 /dev/ttys007\n%8 /dev/ttys008' };
    if (command === 'tmux' && args[0] === 'paste-buffer' && failPaste) return { code: 1, stdout: '' };
    return { code: 0, stdout: command === '/usr/bin/osascript' ? 'ok\n' : '' };
  };
  await injectReply(target, text, { env: ctx.env, platform: 'darwin', runner });
  assert.equal(calls.find(c => c.args[0] === 'load-buffer').input, text);
  assert.ok(calls.some(c => c.args[0] === 'paste-buffer' && c.args.includes('%7')));
  assert.ok(calls.every(c => !c.args.join(' ').includes(text)));
  calls.length = 0; failPaste = true;
  await assert.rejects(injectReply(target, text, { env: ctx.env, platform: 'darwin', runner }), /粘贴失败/);
  assert.ok(!calls.some(c => c.command === '/usr/bin/osascript'));
  calls.length = 0; tmux = false; failPaste = false;
  await injectReply(target, text, { env: ctx.env, platform: 'darwin', runner });
  const script = calls.find(c => c.command === '/usr/bin/osascript').input;
  assert.match(script, /tty of t is "\/dev\/ttys007"/); assert.ok(script.includes('text:'));
});
test('回到本机不默认作答；省略 multiSelect 的真实问题仍可单选', async t => {
  const ctx = await temp(t), q = { ...QUESTION }; delete q.multiSelect;
  const request = await createInteraction(ctx.access, TARGET, 'question', { questions: [q] });
  await processUpdate(ctx.access, callback(1, request.id, 0, 'l'), ctx.context);
  assert.equal(await waitInteraction(ctx.access, request, ctx.context.fresh, { timeout: 100 }), null);
  assert.equal(ctx.inputs.length, 0);
});
test('实际 CLI 后台 start→问题 hook→Bot 按钮→JSON 答案→stop 闭环（假网络/假进程，不注入）', { skip: process.platform !== 'win32' }, async t => {
  const ctx = await temp(t), cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const directory = path.join(ctx.env.CLAUDE_CONFIG_DIR, 'sessions'); await mkdir(directory, { recursive: true });
  await atomicJson(path.join(directory, '12345.json'), { sessionId: TARGET.session, pid: TARGET.pid });
  const loader = path.join(ctx.root, 'isolated-cli-loader.mjs');
  await writeFile(loader, `import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {Readable,Writable} from 'node:stream';
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const original=cp.spawn;
cp.spawn=(command,args,options)=>{
 if(!/powershell.exe$/i.test(command))return original(command,args,options);
 const code=Buffer.from(args.at(-1),'base64').toString('utf16le');
 if(code.includes('DevNotifyConsole'))throw new Error('禁止实际注入');
 const child=new EventEmitter();
 child.stdin=new Writable({write(_data,_enc,done){done()}});
 child.stdout=Readable.from([${JSON.stringify(JSON.stringify({ birth: TARGET.birth }))}]);child.stderr=Readable.from([]);child.kill=()=>true;
 child.stdin.once('finish',()=>setImmediate(()=>child.emit('close',0)));return child;
};
syncBuiltinESMExports();
globalThis.fetch=async(url,options)=>{
 const method=url.split('/').at(-1); let result={};
 if(method==='getMe')result={username:'FakeTestBot'};
 else if(method==='sendMessage'){
  result={message_id:Math.floor(Math.random()*100000)+1000};
  const payload=JSON.parse(options.body);
  if(payload.text?.includes('✅ 答案内容已生效'))await writeFile(${JSON.stringify(path.join(ctx.root, 'final-feedback.json'))},JSON.stringify(payload));
  if(payload.text?.includes('Claude needs your permission'))await appendFile(${JSON.stringify(path.join(ctx.root, 'permission-notices.jsonl'))},JSON.stringify(payload)+'\\n');
 }
 else if(method==='getUpdates'){
  await delay(30);result=[];
  try{
   const state=JSON.parse(await readFile(${JSON.stringify(path.join(replyDirectory(ctx.file), 'state.json'))},'utf8'));
   const request=Object.values(state.requests??{}).find(r=>!r.response);
   const flag=${JSON.stringify(path.join(ctx.root, 'delivered.json'))};
   let delivered='';try{delivered=await readFile(flag,'utf8')}catch{}
   if(request&&delivered!==request.id){
    await writeFile(flag,request.id);
    result=[{update_id:50,callback_query:{id:'isolated',data:'dn:q:'+request.id+':0:o1',from:{id:111},message:{message_id:100,chat:{id:111,type:'private'}}}}];
   }
  }catch{}
 }
 return new Response(JSON.stringify({ok:true,result}));
};
`);
  const env = { ...process.env, ...ctx.env, NODE_OPTIONS: '--import=' + pathToFileURL(loader).href };
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args, '--config', ctx.file], { input, encoding: 'utf8', env, timeout: 20000 });
  try {
    const started = run(['reply', 'start']); assert.equal(started.status, 0, started.stderr + started.stdout);
    assert.equal((await bridgeStatus(ctx.file)).ready, true);
    const data = { tool_name: 'AskUserQuestion', tool_use_id: 'cli-question', session_id: TARGET.session, tool_input: { questions: [QUESTION] } };
    const registered = run(['integration', 'claude-code', 'hook'], JSON.stringify({ ...data, hook_event_name: 'PreToolUse' }));
    assert.equal(registered.status, 0); assert.equal(registered.stdout, '');
    const result = run(['integration', 'claude-code', 'hook'], JSON.stringify({ ...data, hook_event_name: 'PermissionRequest' }));
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    const response = JSON.parse(result.stdout);
    assert.equal(response.hookSpecificOutput.decision.updatedInput.answers[QUESTION.question], 'Vue');
    assert.deepEqual(response.hookSpecificOutput.decision.updatedInput.questions, [QUESTION]);
    const completed = run(['integration', 'claude-code', 'hook'], JSON.stringify({ ...data, hook_event_name: 'PostToolUse', tool_response: { answers: { [QUESTION.question]: 'Vue' } } }));
    assert.equal(completed.status, 0, completed.stderr);
    let receipt;
    for (let i = 0; i < 40; i++) {
      try { receipt = JSON.parse(await readFile(path.join(ctx.root, 'final-feedback.json'), 'utf8')); break; } catch { await delay(50); }
    }
    assert.equal(receipt?.chat_id, '111'); assert.match(receipt.text, /Claude 已确认采用/);
    const notify = () => run(['integration', 'claude-code', 'hook'], JSON.stringify(permissionNotice()));
    const notified = notify(); assert.equal(notified.status, 0, notified.stderr); assert.equal(notified.stderr, '');
    const notices = async () => (await readFile(path.join(ctx.root, 'permission-notices.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).chat_id);
    assert.deepEqual(await notices(), ['222', '-333']);
    const next = run(['integration', 'claude-code', 'hook'], JSON.stringify({ ...data, hook_event_name: 'PreToolUse', tool_use_id: 'cli-bash', tool_name: 'Bash', tool_input: { command: 'pwd' } }));
    assert.equal(next.status, 0, next.stderr); assert.equal(next.stdout, '');
    assert.equal(notify().status, 0);
    assert.deepEqual(await notices(), ['222', '-333', '111', '222', '-333']);
  } finally {
    const stopped = run(['reply', 'stop']); assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
    assert.equal((await bridgeStatus(ctx.file)).running, false);
  }
});
test('实际 CLI 进程可查询回复状态，非交互授权拒绝且不会启动后台', async t => {
  const ctx = await temp(t, false), cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'reply', 'status', '--config', ctx.file], { encoding: 'utf8', env: { ...process.env, ...ctx.env }, timeout: 10000 });
  assert.equal(result.status, 1); assert.match(result.stdout, /未启用/); assert.match(result.stdout, /未运行/);
  const setup = spawnSync(process.execPath, [cli, 'reply', 'setup', '--config', ctx.file], { encoding: 'utf8', env: { ...process.env, ...ctx.env }, timeout: 10000 });
  assert.equal(setup.status, 2); assert.ok(!setup.stdout.includes('FAKE_ONLY'));
});
