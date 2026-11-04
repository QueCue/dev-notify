import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { claudeSettingsPath, claudeCodeStatus, configureClaudeCode, HOOK_MARKER, NOTIFICATION_MATCHER, EVENTS } from '../dist/claude-code.js';
import { claudeHookMessage, dispatchClaudeHook, readHookInput, MAX_HOOK_BYTES, formatTime } from '../dist/claude-hook.js';
import { Cancelled } from '../dist/prompts.js';
import { main } from '../dist/cli.js';
import { deliver } from '../dist/channels.js';

// 测试意外绕过注入的发送器时立即失败，不接触真实网络或真实系统凭据。
globalThis.fetch = async () => { throw new Error('禁止真实网络请求'); };
const FAKE_ENV = { TELEGRAM_BOT_TOKEN: '123:TEST_ONLY', TELEGRAM_CHAT_ID: '111',
  FEISHU_WEBHOOK: '', FEISHU_SECRET: '' };
const CONFIG = { version: 1, telegram: { enabled: true, chat_ids: ['111'] }, feishu: { enabled: false } };
const runtime = { node: process.execPath, cli: fileURLToPath(new URL('../dist/cli.js', import.meta.url)) };
function ui(answers = []) {
  const output = [];
  return { output, out: text => output.push(text), text: async () => {
    assert.ok(answers.length, '没有预期之外的交互');
    const answer = answers.shift(); if (answer instanceof Error) throw answer; return answer;
  }, secret: async () => { throw new Error('集成管理不得读取或询问密钥'); } };
}
async function temp(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dev notify hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '用户配置 $ ` & 空格');
  const env = { ...FAKE_ENV, DEV_NOTIFY_HOME: path.join(root, '通知配置'), CLAUDE_CONFIG_DIR: directory };
  const config = path.join(env.DEV_NOTIFY_HOME, 'config', 'config.json');
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, JSON.stringify(CONFIG));
  return { root, directory, env, config, file: path.join(directory, 'settings.json') };
}
async function save(file, data) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data)); }
const json = data => Buffer.from(JSON.stringify(data));
const stop = extras => ({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '最终回复😀',
  session_id: 'test-session', cwd: 'C:\\work\\项目', ...extras });
const hooks = data => EVENTS.flatMap(event => (data.hooks?.[event] ?? []).flatMap(group => group.hooks));
async function invoke(env, args, extra = {}) {
  const output = [], errors = [];
  const code = await main(args, { env, out: text => output.push(text), err: text => errors.push(text),
    send: async () => { throw new Error('禁止真实发送'); }, ...extra });
  return { code, output, errors, text: [...output, ...errors].join('\n') };
}
class Store {
  items = new Map();
  read(id) { return this.items.get(id) ?? null; }
  create(id, values) { this.items.set(id, structuredClone(values)); }
  remove(id) { this.items.delete(id); }
}

test('Claude Code Windows/macOS 默认路径与配置目录覆盖', () => {
  assert.equal(claudeSettingsPath({}, 'C:\\Users\\Tester', 'win32'), 'C:\\Users\\Tester\\.claude\\settings.json');
  assert.equal(claudeSettingsPath({}, '/Users/tester', 'darwin'), '/Users/tester/.claude/settings.json');
  assert.equal(claudeSettingsPath({ CLAUDE_CONFIG_DIR: '/tmp/用户 空格' }, '/Users/tester', 'darwin'), '/tmp/用户 空格/settings.json');
  assert.throws(() => claudeSettingsPath({ CLAUDE_CONFIG_DIR: 'relative' }), /绝对路径/);
});
test('状态查询不创建目录且不会访问系统凭据', async t => {
  const ctx = await temp(t), status = await claudeCodeStatus({ env: ctx.env });
  assert.equal(status.stop, 0); assert.equal(status.notification, 0);
  await assert.rejects(readFile(ctx.file), { code: 'ENOENT' });
  const result = await invoke(ctx.env, ['integration', 'claude-code', 'status']);
  assert.equal(result.code, 1); assert.match(result.text, /Stop 0/);
});
test('首次安装写入通知、同步生命周期与交互 exec hooks，参数不依赖 shell 转义', async t => {
  const ctx = await temp(t), prompts = ui(['y']);
  assert.equal(await configureClaudeCode(ctx.config, 'install', prompts, { env: ctx.env, runtime }), true);
  const saved = JSON.parse(await readFile(ctx.file, 'utf8'));
  assert.equal(saved.hooks.Stop.length, 1);
  assert.equal(saved.hooks.Notification[0].matcher, NOTIFICATION_MATCHER);
  assert.equal(hooks(saved).length, 10);
  assert.equal(saved.hooks.Notification[0].hooks[0].async, true);
  assert.equal(saved.hooks.Stop[0].hooks[0].async, undefined);
  assert.equal(saved.hooks.PreToolUse[0].matcher, undefined);
  assert.equal(saved.hooks.PreToolUse[0].hooks[0].timeout, 10);
  assert.equal(saved.hooks.PostToolUse[0].hooks[0].async, undefined);
  assert.equal(saved.hooks.PermissionRequest[0].hooks[0].timeout, 720);
  for (const hook of hooks(saved)) {
    assert.equal(hook.command, process.execPath);
    assert.equal(hook.statusMessage, HOOK_MARKER);
    assert.deepEqual(hook.args, [runtime.cli, 'integration', 'claude-code', 'hook', '--config', ctx.config]);
    assert.equal(hook.shell, undefined);
  }
  assert.ok(prompts.output.some(text => text.includes('敏感内容')));
  assert.deepEqual(await readdir(ctx.directory), ['settings.json']);
});
test('合并保留权限、环境变量、未知设置、原旧版 hooks 和其他事件', async t => {
  const ctx = await temp(t);
  const before = { permissions: { allow: ['Read'], deny: ['Bash(rm *)'] }, env: { KEEP: 'TEST_ONLY' }, future: { enabled: true },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'legacy-hook --old', timeout: 600 }] }],
      Notification: [{ matcher: 'idle_prompt', hooks: [{ type: 'command', command: 'other-tool' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: 'start-tool' }] }] } };
  await save(ctx.file, before);
  const prompts = ui(['y']); await configureClaudeCode(ctx.config, 'install', prompts, { env: ctx.env });
  const saved = JSON.parse(await readFile(ctx.file, 'utf8'));
  for (const key of ['permissions', 'env', 'future']) assert.deepEqual(saved[key], before[key]);
  assert.deepEqual(saved.hooks.Stop[0], before.hooks.Stop[0]);
  assert.deepEqual(saved.hooks.Notification[0], before.hooks.Notification[0]);
  assert.deepEqual(saved.hooks.SessionStart[0], before.hooks.SessionStart[0]);
  assert.ok(prompts.output.some(text => text.includes('重复通知')));
  assert.ok(!prompts.output.join().includes('TEST_ONLY'));
});
test('重复安装不重复添加也不改写文件，升级路径和通知配置可显式更新', async t => {
  const ctx = await temp(t);
  await configureClaudeCode(ctx.config, 'install', ui(['y']), { env: ctx.env, runtime });
  const before = await readFile(ctx.file);
  await configureClaudeCode(ctx.config, 'install', ui(), { env: ctx.env, runtime });
  assert.deepEqual(await readFile(ctx.file), before);
  const updated = { node: process.execPath, cli: path.join(ctx.root, '新版本 cli.js') };
  await configureClaudeCode(path.join(ctx.root, '另一配置.json'), 'install', ui(['y']), { env: ctx.env, runtime: updated });
  const saved = JSON.parse(await readFile(ctx.file, 'utf8'));
  assert.equal(hooks(saved).length, 10);
  assert.equal(hooks(saved)[0].args[0], updated.cli);
});
test('安装取消或 Ctrl+C 不创建 Claude Code 设置', async t => {
  const ctx = await temp(t);
  assert.equal(await configureClaudeCode(ctx.config, 'install', ui(['n']), { env: ctx.env }), false);
  await assert.rejects(configureClaudeCode(ctx.config, 'install', ui([new Cancelled()]), { env: ctx.env }), Cancelled);
  await assert.rejects(readFile(ctx.file), { code: 'ENOENT' });
});
test('损坏 JSON 与异常 hooks 结构被拒绝，不覆盖或泄漏内容', async t => {
  const ctx = await temp(t);
  for (const value of ['TEST_ONLY', '[]', '{"hooks":[]}', '{"hooks":{"Stop":{}}}', '{"hooks":{"Notification":[{"hooks":false}]}}']) {
    await save(ctx.file, value);
    await assert.rejects(configureClaudeCode(ctx.config, 'install', ui(), { env: ctx.env }), error => !error.message.includes('TEST_ONLY'));
    assert.equal(await readFile(ctx.file, 'utf8'), value);
  }
});
test('移除只删除本工具标记的处理器，保留同组其他 hooks 与组属性', async t => {
  const ctx = await temp(t);
  await configureClaudeCode(ctx.config, 'install', ui(['y']), { env: ctx.env });
  const saved = JSON.parse(await readFile(ctx.file, 'utf8'));
  saved.hooks.Stop[0].future = 'keep';
  saved.hooks.Stop[0].hooks.push({ type: 'command', command: 'keep-this' });
  saved.model = 'keep-model';
  await save(ctx.file, saved);
  assert.equal(await configureClaudeCode(ctx.config, 'remove', ui(['n']), { env: ctx.env }), false);
  assert.equal((await claudeCodeStatus({ env: ctx.env })).stop, 1);
  assert.equal(await configureClaudeCode(ctx.config, 'remove', ui(['y']), { env: ctx.env }), true);
  const removed = JSON.parse(await readFile(ctx.file, 'utf8'));
  assert.equal(removed.model, 'keep-model');
  assert.deepEqual(removed.hooks.Stop, [{ future: 'keep', hooks: [{ type: 'command', command: 'keep-this' }] }]);
  assert.equal(removed.hooks.Notification, undefined);
  assert.deepEqual(JSON.parse(await readFile(ctx.config, 'utf8')), CONFIG);
});
test('没有本工具 hooks 的移除是只读，不能按 dev-notify 子串误删其他命令', async t => {
  const ctx = await temp(t), existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-dev-notify-handler', statusMessage: HOOK_MARKER }] }] } };
  await save(ctx.file, existing); const before = await readFile(ctx.file);
  await configureClaudeCode(ctx.config, 'remove', ui(), { env: ctx.env });
  assert.deepEqual(await readFile(ctx.file), before);
});
test('没有本工具条目时也不清理原有空 hooks 数组', async t => {
  const ctx = await temp(t), existing = '{ "hooks": { "Stop": [], "Notification": [] } }';
  await save(ctx.file, existing);
  await configureClaudeCode(ctx.config, 'remove', ui(), { env: ctx.env });
  assert.equal(await readFile(ctx.file, 'utf8'), existing);
});
test('只含本工具的设置移除后保留空文件，重复移除不写文件', async t => {
  const ctx = await temp(t);
  await configureClaudeCode(ctx.config, 'install', ui(['y']), { env: ctx.env });
  await configureClaudeCode(ctx.config, 'remove', ui(['y']), { env: ctx.env });
  assert.deepEqual(JSON.parse(await readFile(ctx.file, 'utf8')), {});
  const before = await readFile(ctx.file);
  await configureClaudeCode(ctx.config, 'remove', ui(), { env: ctx.env });
  assert.deepEqual(await readFile(ctx.file), before);
});
test('现有 disableAllHooks 保留并明确告知，状态不能假报可用', async t => {
  const ctx = await temp(t); await save(ctx.file, { disableAllHooks: true });
  const prompts = ui(['y']); await configureClaudeCode(ctx.config, 'install', prompts, { env: ctx.env });
  assert.equal((await claudeCodeStatus({ env: ctx.env })).disabled, true);
  assert.ok(prompts.output.some(text => text.includes('也不会生效')));
  assert.equal((await invoke(ctx.env, ['integration', 'claude-code', 'status'])).code, 1);
});
test('确认期间的外部修改不被覆盖', async t => {
  const ctx = await temp(t); await save(ctx.file, { existing: true });
  const prompts = ui(); prompts.text = async () => { await save(ctx.file, { externallyChanged: true }); return 'y'; };
  await assert.rejects(configureClaudeCode(ctx.config, 'install', prompts, { env: ctx.env }), /变化/);
  assert.deepEqual(JSON.parse(await readFile(ctx.file, 'utf8')), { externallyChanged: true });
  assert.deepEqual(await readdir(ctx.directory), ['settings.json']);
});
test('替换失败保留原文件并清理临时文件和本次锁', async t => {
  const ctx = await temp(t); await save(ctx.file, '{ "existing": true }');
  const before = await readFile(ctx.file);
  await assert.rejects(configureClaudeCode(ctx.config, 'install', ui(['y']), { env: ctx.env,
    replace: async () => { throw new Error('TEST_ONLY'); } }));
  assert.deepEqual(await readFile(ctx.file), before);
  assert.deepEqual(await readdir(ctx.directory), ['settings.json']);
});
test('已有写入锁不能被覆盖或移除', async t => {
  const ctx = await temp(t); await save(ctx.file, {}); await writeFile(ctx.file + '.dev-notify.lock', 'other-process');
  await assert.rejects(configureClaudeCode(ctx.config, 'install', ui(['y']), { env: ctx.env }), /锁/);
  assert.equal(await readFile(ctx.file + '.dev-notify.lock', 'utf8'), 'other-process');
});
test('CLI 单独安装、查询和移除共用同一套确认与配置合并逻辑', async t => {
  const ctx = await temp(t);
  assert.equal((await invoke(ctx.env, ['integration', 'claude-code', 'install'], { prompts: ui(['y']) })).code, 0);
  assert.equal((await invoke(ctx.env, ['integration', 'claude-code', 'status'])).code, 0);
  assert.equal((await invoke(ctx.env, ['integration', 'claude-code', 'remove'], { prompts: ui(['n']) })).code, 130);
  assert.equal((await invoke(ctx.env, ['integration', 'claude-code', 'remove'], { prompts: ui(['y']) })).code, 0);
});
test('无可用渠道不能单独安装，--yes 可跳过集成确认', async t => {
  const ctx = await temp(t);
  const disabled = { ...ctx.env, TELEGRAM_BOT_TOKEN: '', FEISHU_WEBHOOK: '' };
  assert.equal((await invoke(disabled, ['integration', 'claude-code', 'install'], { prompts: ui() })).code, 2);
  await assert.rejects(readFile(ctx.file), { code: 'ENOENT' });
  assert.equal((await invoke(ctx.env, ['integration', 'claude-code', 'install', '--yes'])).code, 0);
  assert.equal((await invoke(ctx.env, ['integration', 'claude-code', 'status'])).code, 0);
  assert.equal((await invoke(ctx.env, ['integration', 'list', 'extra'])).code, 2);
});
test('setup 一次确认完成保存、测试和 Claude Code 安装', async t => {
  const ctx = await temp(t); await rm(ctx.config);
  const prompts = ui(['1', '111', '']);
  prompts.secret = async () => '123:TEST_ONLY';
  let sent = 0;
  const result = await invoke(ctx.env, ['setup'], { prompts, store: new Store(),
    send: async plan => { sent++; return { ok: true, channel: plan.channel, sent: plan.items.length, planned: plan.items.length }; } });
  assert.equal(result.code, 0); assert.equal((await claudeCodeStatus({ env: ctx.env })).stop, 1);
  assert.equal(sent, 1);
  assert.ok(!JSON.stringify(JSON.parse(await readFile(ctx.config, 'utf8'))).includes('TEST_ONLY'));
});
test('setup --no-hooks 保存渠道但不创建 Claude Code 设置', async t => {
  const ctx = await temp(t); await rm(ctx.config);
  const prompts = ui(['1', '111', '']); prompts.secret = async () => '123:TEST_ONLY';
  const result = await invoke(ctx.env, ['setup', '--no-hooks'], { prompts, store: new Store(),
    send: async plan => ({ ok: true, channel: plan.channel, sent: plan.items.length, planned: plan.items.length }) });
  assert.equal(result.code, 0); await readFile(ctx.config);
  await assert.rejects(readFile(ctx.file), { code: 'ENOENT' });
});
test('setup --no-test 保存配置并安装 hooks，不发送测试', async t => {
  const ctx = await temp(t); await rm(ctx.config);
  const prompts = ui(['1', '111', '']); prompts.secret = async () => '123:TEST_ONLY';
  const result = await invoke(ctx.env, ['setup', '--no-test'], { prompts, store: new Store() });
  assert.equal(result.code, 0); assert.equal((await claudeCodeStatus({ env: ctx.env })).stop, 1);
  assert.match(prompts.output.join('\n'), /已跳过测试通知/);
});
test('setup 汇总确认取消时不写配置或 hooks', async t => {
  const ctx = await temp(t); await rm(ctx.config);
  const prompts = ui(['1', '111', 'n']); prompts.secret = async () => '123:TEST_ONLY';
  const result = await invoke(ctx.env, ['setup'], { prompts, store: new Store() });
  assert.equal(result.code, 130);
  await assert.rejects(readFile(ctx.config), { code: 'ENOENT' });
  await assert.rejects(readFile(ctx.file), { code: 'ENOENT' });
});
test('setup 渠道已保存但 hooks 安装失败时明确区分结果，不回滚渠道', async t => {
  const ctx = await temp(t); await rm(ctx.config); await save(ctx.file, 'BROKEN');
  const prompts = ui(['1', '111', '']); prompts.secret = async () => '123:TEST_ONLY';
  const result = await invoke(ctx.env, ['setup', '--no-test'], { prompts, store: new Store() });
  assert.equal(result.code, 1); assert.match(prompts.output.join('\n'), /配置已保存。Claude Code hooks 没有安装完成/);
  assert.equal(await readFile(ctx.file, 'utf8'), 'BROKEN'); await readFile(ctx.config);
});
test('模板模式不询问集成、不创建 Claude Code 设置', async t => {
  const ctx = await temp(t); await rm(ctx.config);
  const result = await invoke(ctx.env, ['setup', '--template', '--yes'], { prompts: ui() });
  assert.equal(result.code, 0); await assert.rejects(readFile(ctx.file), { code: 'ENOENT' });
});
test('Stop 使用最终正文并完整保留长内容，不读会话文件或思考与工具数据', () => {
  const body = '长回复 中文😀\n'.repeat(3000);
  const message = claudeHookMessage(json(stop({ last_assistant_message: body, transcript_path: 'DO_NOT_READ',
    thinking: 'PRIVATE_THINKING', tool_results: 'PRIVATE_TOOL' })));
  assert.equal(message.content, body); assert.equal(message.level, 'success');
  assert.match(message.footer, /项目：C:\\work\\项目/); assert.match(message.footer, /test-session/);
  assert.ok(!JSON.stringify(message).includes('PRIVATE_'));
});
test('底部依次显示项目绝对路径、会话名称和会话 ID，缺失名称时省略主题', () => {
  const named = claudeHookMessage(json(stop()), 'dev-notify-e9');
  assert.deepEqual(named.footer.split('\n'), ['项目：C:\\work\\项目', '主题：dev-notify-e9', '会话：test-session']);
  const unnamed = claudeHookMessage(json(stop()));
  assert.deepEqual(unnamed.footer.split('\n'), ['项目：C:\\work\\项目', '会话：test-session']);
  const bare = claudeHookMessage(json({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: '请批准' }));
  assert.equal(bare.footer, '');
});
test('通知按 sessionId 从会话注册表读取主题名称并忽略损坏文件', async t => {
  const ctx = await temp(t), sessions = path.join(ctx.directory, 'sessions');
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(sessions, '12345.json'), JSON.stringify({ pid: 12345, sessionId: 'test-session', name: '测试主题' }));
  await writeFile(path.join(sessions, '12346.json'), '{BROKEN');
  const plans = [];
  await dispatchClaudeHook(json(stop()), ctx.config, { env: ctx.env, err: () => {},
    send: async plan => { plans.push(plan); return { ok: true, channel: plan.channel, sent: plan.items.length, planned: plan.items.length }; } });
  assert.equal(plans.length, 1);
  assert.match(plans[0].items[0].plain, /项目：C:\\work\\项目\n主题：测试主题\n会话：test-session/);
});
test('Stop 缺少或空正文时诚实发送完成提示，不拿旧 transcript 冒充', () => {
  for (const value of [undefined, '', '  ']) {
    const message = claudeHookMessage(json(stop({ last_assistant_message: value, transcript_path: 'DO_NOT_READ' })));
    assert.match(message.content, /没有提供最终正文/);
  }
});
test('继续中的 Stop、子代理、空闲和认证通知全部忽略', () => {
  for (const data of [stop({ stop_hook_active: true }), stop({ hook_event_name: 'SubagentStop' }),
    { hook_event_name: 'Notification', notification_type: 'idle_prompt' },
    { hook_event_name: 'Notification', notification_type: 'auth_success' },
    { hook_event_name: 'Notification', notification_type: 'unknown' }]) assert.equal(claudeHookMessage(json(data)), null);
});
test('需要确认或输入的 Notification 转发正文，缺少正文则明确提示', () => {
  for (const notification_type of NOTIFICATION_MATCHER.split('|')) {
    const message = claudeHookMessage(json({ hook_event_name: 'Notification', notification_type, message: '请批准工具操作' }));
    assert.equal(message.content, '请批准工具操作'); assert.equal(message.level, 'warn');
  }
  assert.match(claudeHookMessage(json({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })).content, /等待你的确认/);
});
test('损坏 hook 输入、错误类型和超限正文均拒绝，不泄漏或截断', () => {
  for (const bytes of [Buffer.from('TEST_ONLY'), Buffer.from('[]'), Buffer.from([0xff]), json(stop({ stop_hook_active: 'false' })),
    json(stop({ last_assistant_message: {} })), json({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: [] }),
    Buffer.alloc(MAX_HOOK_BYTES + 1)]) assert.throws(() => claudeHookMessage(bytes), error => !error.message.includes('TEST_ONLY'));
});
test('读取 hook stdin 完整拼接，超限立即失败', async () => {
  assert.equal(Buffer.from(await readHookInput(Readable.from([Buffer.from('中文'), Buffer.from('😀')]))).toString(), '中文😀');
  await assert.rejects(readHookInput(Readable.from([Buffer.alloc(11)]), 10), /超过大小限制/);
});
test('通知事件开关只抑制对应类型，不影响另一类', async t => {
  const ctx = await temp(t);
  await writeFile(ctx.config, JSON.stringify({ ...CONFIG, notifications: { events: { stop: false } } }));
  const plans = [];
  const options = { env: ctx.env, err: () => {}, send: async plan => {
    plans.push(plan); return { ok: true, channel: plan.channel, sent: plan.items.length, planned: plan.items.length };
  } };
  await dispatchClaudeHook(json(stop()), ctx.config, options);
  assert.equal(plans.length, 0);
  await dispatchClaudeHook(json({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: '请批准' }),
    ctx.config, options);
  assert.equal(plans.length, 1);
});
test('项目 allow 过滤普通通知，其他项目不发', async t => {
  const ctx = await temp(t);
  const cwd = process.platform === 'win32' ? 'C:\\work\\项目' : '/work/项目';
  const other = process.platform === 'win32' ? 'C:\\other\\项目' : '/other/项目';
  const allow = process.platform === 'win32' ? 'C:\\work' : '/work';
  await writeFile(ctx.config, JSON.stringify({ ...CONFIG, notifications: { projects: { allow: [allow] } } }));
  const plans = [];
  const options = { env: ctx.env, err: () => {}, send: async plan => {
    plans.push(plan); return { ok: true, sent: 1, planned: 1, channel: plan.channel };
  } };
  await dispatchClaudeHook(json(stop({ cwd })), ctx.config, options);
  assert.equal(plans.length, 1);
  await dispatchClaudeHook(json(stop({ cwd: other })), ctx.config, options);
  assert.equal(plans.length, 1);
});
test('静默时段按注入的本地时钟抑制通知', async t => {
  const ctx = await temp(t);
  await writeFile(ctx.config, JSON.stringify({ ...CONFIG,
    notifications: { quiet_hours: { start: '22:00', end: '08:00' } } }));
  const plans = [];
  const options = now => ({ env: ctx.env, err: () => {}, now, send: async plan => {
    plans.push(plan); return { ok: true, sent: 1, planned: 1, channel: plan.channel };
  } });
  await dispatchClaudeHook(json(stop()), ctx.config, options(() => new Date(2026, 0, 1, 23, 0)));
  assert.equal(plans.length, 0);
  await dispatchClaudeHook(json(stop()), ctx.config, options(() => new Date(2026, 0, 1, 12, 0)));
  assert.equal(plans.length, 1);
});
test('自定义 footer 模板替换默认项目/主题/会话行，空模板隐藏底部信息', async t => {
  const ctx = await temp(t);
  await writeFile(ctx.config, JSON.stringify({ ...CONFIG, templates: { footer: 'P={project} S={session}' } }));
  const plans = [];
  const options = { env: ctx.env, err: () => {}, send: async plan => {
    plans.push(plan); return { ok: true, sent: 1, planned: 1, channel: plan.channel };
  } };
  await dispatchClaudeHook(json(stop()), ctx.config, options);
  assert.match(plans[0].items[0].plain, /P=C:\\work\\项目 S=test-session/);
  assert.ok(!plans[0].items[0].plain.includes('主题：'));
  assert.ok(!plans[0].items[0].plain.includes('会话：'));

  await writeFile(ctx.config, JSON.stringify({ ...CONFIG, templates: { footer: '' } }));
  await dispatchClaudeHook(json(stop()), ctx.config, options);
  assert.ok(!plans[1].items[0].plain.includes('────────'));
});
test('模板 {time} 优先使用 transcript 结束时间，读取失败才回退 hook 时间', async t => {
  const ctx = await temp(t);
  const directory = path.join(ctx.directory, 'projects', 'project');
  await mkdir(directory, { recursive: true });
  const transcript = path.join(directory, 'session.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T10:20:30.000Z' }) + '\n');
  await writeFile(ctx.config, JSON.stringify({ ...CONFIG, templates: { footer: 'T={time}' } }));
  const plans = [];
  const options = now => ({ env: ctx.env, err: () => {}, now, send: async plan => {
    plans.push(plan); return { ok: true, sent: 1, planned: 1, channel: plan.channel };
  } });
  const hookTime = () => new Date('2026-11-04T10:20:35.000Z');
  await dispatchClaudeHook(json(stop({ transcript_path: transcript })), ctx.config, options(hookTime));
  assert.ok(plans[0].items[0].plain.includes('T=' + formatTime(new Date('2026-11-04T10:20:30.000Z'))));
  assert.ok(!plans[0].items[0].plain.includes('T=' + formatTime(hookTime())));
  await dispatchClaudeHook(json(stop({ transcript_path: path.join(ctx.root, 'missing.jsonl') })), ctx.config, options(hookTime));
  assert.ok(plans[1].items[0].plain.includes('T=' + formatTime(hookTime())));
});
test('Stop 经过真实分段规划与模拟投递，所有正文完整保留', async t => {
  const ctx = await temp(t), body = '分段内容😀\n'.repeat(2000), plans = [], errors = [];
  await dispatchClaudeHook(json(stop({ last_assistant_message: body })), ctx.config, { env: ctx.env, err: text => errors.push(text),
    send: async (plan, config) => { plans.push(plan); return deliver(plan, config, async () => ({ ok: true }), async () => {}); } });
  assert.equal(errors.length, 0); assert.equal(plans.length, 1); assert.ok(plans[0].items.length > 1);
  assert.equal(plans[0].items.map(item => item.plain.split('\n\n').slice(1).join('\n\n').split('────────\n')[0].replace(/\n\n$/, '')).join(''), body);
});
test('被忽略的事件不加载配置或触碰系统凭据', async t => {
  const ctx = await temp(t);
  await dispatchClaudeHook(json(stop({ stop_hook_active: true })), path.join(ctx.root, 'missing.json'), {
    env: {}, err: () => assert.fail('不应报错'), send: async () => assert.fail('不应发送') });
});
test('单渠道失败不泄漏错误且不阻止另一个渠道，hook 不输出控制 JSON', async t => {
  const ctx = await temp(t); await writeFile(ctx.config, JSON.stringify({ ...CONFIG, feishu: { enabled: true } }));
  const called = [], output = [], env = { ...ctx.env, FEISHU_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/TEST_ONLY' };
  await dispatchClaudeHook(json(stop()), ctx.config, { env, err: text => output.push(text), send: async plan => {
    called.push(plan.channel);
    if (plan.channel === 'telegram') throw new Error('TEST_ONLY');
    return { ok: true, sent: 1, planned: 1, channel: plan.channel };
  } });
  assert.deepEqual(called, ['telegram', 'feishu']); assert.equal(output.length, 1); assert.ok(!output.join().includes('TEST_ONLY'));
});
test('hook 配置或投递失败退出 0，绝不以退出码 2 阻止 Claude 停止', async t => {
  const ctx = await temp(t);
  for (const args of [['integration', 'claude-code', 'hook'], ['integration', 'claude-code', 'hook', '--secret', 'TEST_ONLY']]) {
    const result = await invoke(ctx.env, args, { hookStdin: async () => json(stop()) });
    assert.equal(result.code, 0); assert.equal(result.output.length, 0); assert.ok(!result.errors.join().includes('TEST_ONLY'));
  }
  const invalid = await invoke(ctx.env, ['integration', 'claude-code', 'hook'], { hookStdin: async () => Buffer.from('TEST_ONLY') });
  assert.equal(invalid.code, 0); assert.ok(invalid.errors.length); assert.ok(!invalid.text.includes('TEST_ONLY'));
});
test('生成的 exec 命令实进程管道测试：含空格特殊字符路径，无 shell、无真实发送', async t => {
  const ctx = await temp(t);
  await configureClaudeCode(ctx.config, 'install', ui(['y']), { env: ctx.env });
  const saved = JSON.parse(await readFile(ctx.file, 'utf8')), hook = saved.hooks.Stop[0].hooks[0];
  const loader = path.join(ctx.root, 'mock-network.mjs'), requests = path.join(ctx.root, 'requests.jsonl');
  await writeFile(loader, `import { appendFile } from 'node:fs/promises';\nglobalThis.fetch = async (url, options) => {\n  await appendFile(${JSON.stringify(requests)}, JSON.stringify({ url, payload: JSON.parse(options.body) }) + '\\n');\n  return new Response(JSON.stringify({ ok: true, code: 0 }));\n};\n`);
  const result = spawnSync(hook.command, hook.args, { input: json(stop()), encoding: 'utf8', cwd: ctx.root,
    env: { ...process.env, ...ctx.env, NODE_OPTIONS: '--import=' + pathToFileURL(loader).href }, timeout: 20000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
  const sent = (await readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(sent.length, 1); assert.equal(sent[0].payload.chat_id, '111'); assert.match(sent[0].payload.text, /最终回复😀/);
});
test('CLI --version 与包版本一致，避免下次发布号与命令输出脱节', async t => {
  const ctx = await temp(t), pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal((await invoke(ctx.env, ['--version'])).text, 'dev-notify ' + pkg.version);
});
