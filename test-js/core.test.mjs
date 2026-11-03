import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appPaths, createConfig, loadConfig, parseConfig, decodeUtf8, example } from '../dist/config.js';
import { main } from '../dist/cli.js';
import { parseMarkdown, visibleText, telegramParts, feishuParts } from '../dist/formatting.js';
import { makePlan, deliver, requestJson } from '../dist/channels.js';

// 如果测试意外绕过注入的传输，立即失败，不允许真实网络请求。
globalThis.fetch = async () => { throw new Error('禁止真实网络请求'); };
const fakeEnv = { TELEGRAM_BOT_TOKEN: '123:TEST_ONLY', TELEGRAM_CHAT_ID: '111',
  FEISHU_WEBHOOK: 'https://open.feishu.cn/open-apis/bot/v2/hook/TEST_ONLY', FEISHU_SECRET: 'TEST_ONLY' };
const config = () => parseConfig({}, fakeEnv);
const message = content => ({ title: '标题', content, footer: '会话辅助', level: 'info' });
async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-node-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function invoke(root, args, env = {}, overrides = {}) {
  const output = [], errors = [];
  const code = await main(args, { env: { DEV_NOTIFY_HOME: root, ...env },
    out: text => output.push(text), err: text => errors.push(text),
    send: async () => { throw new Error('测试禁止真实发送'); }, ...overrides });
  return { code, text: [...output, ...errors].join('\n') };
}
const decode = text => text.replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function balanced(html) {
  const stack = [];
  for (const match of html.matchAll(/<(\/?)(\w+)>/g)) {
    if (match[1]) assert.equal(stack.pop(), match[2]); else stack.push(match[2]);
  }
  assert.deepEqual(stack, []);
}

test('Windows/macOS 路径及绝对目录覆盖', () => {
  assert.equal(appPaths('win32', {}, 'C:\\Users\\Tester').config, 'C:\\Users\\Tester\\AppData\\Roaming\\DevNotify\\config.json');
  assert.equal(appPaths('darwin', {}, '/Users/tester').config, '/Users/tester/Library/Application Support/DevNotify/config/config.json');
  assert.equal(appPaths('darwin', { DEV_NOTIFY_HOME: '/tmp/tester' }).data, '/tmp/tester/data');
  assert.throws(() => appPaths('darwin', { DEV_NOTIFY_HOME: 'relative' }), /绝对路径/);
});
test('接收人环境变量完全覆盖且显式空值撤销', () => {
  const source = { telegram: { chat_ids: ['111', '222'] } };
  for (const [env, expected] of [[{}, ['111', '222']], [{ TELEGRAM_CHAT_ID: '333' }, ['333']],
    [{ TELEGRAM_CHAT_IDS: '333,444,333' }, ['333', '444']], [{ TELEGRAM_CHAT_IDS: '' }, []]]) {
    assert.deepEqual(parseConfig(source, env).telegram.chatIds, expected);
  }
});
test('配置拒绝秘密字段、类型错误、非安全整数', () => {
  for (const input of [[], null, { version: 2 }, { telegram: [] }, { telegram: { enabled: 'false' } },
    { telegram: { token: 'TEST_ONLY' } }, { telegram: { chat_ids: [true] } },
    { telegram: { chat_ids: [Number.MAX_SAFE_INTEGER + 1] } }]) {
    assert.throws(() => parseConfig(input, {}), error => !error.message.includes('TEST_ONLY'));
  }
});
test('系统凭据引用未迁移时明确拒绝，不降级明文', () => {
  const source = { credentials: { backend: 'system', id: 'a'.repeat(32) } };
  assert.throws(() => parseConfig(source, {}), /旧版原型/);
  assert.equal(parseConfig(source, fakeEnv).telegram.token, fakeEnv.TELEGRAM_BOT_TOKEN);
  const disabled = { ...source, telegram: { enabled: false }, feishu: { enabled: false } };
  assert.equal(parseConfig(disabled, {}).telegram.token, '');
});
test('凭据 URL 必须是飞书 HTTPS 官方地址', () => {
  for (const url of ['http://open.feishu.cn/open-apis/bot/v2/hook/x', 'https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/x',
    'https://user@open.feishu.cn/open-apis/bot/v2/hook/x', 'https://open.feishu.cn/open-apis/bot/v2/hook/x?q=secret']) {
    assert.throws(() => parseConfig({}, { FEISHU_WEBHOOK: url }));
  }
});
test('配置 UTF-8 BOM 兼容且损坏配置不被忽略', async t => {
  const file = path.join(await temporary(t), 'config.json');
  await writeFile(file, '\ufeff' + JSON.stringify(example));
  assert.deepEqual((await loadConfig(file, true, {})).telegram.chatIds, []);
  await writeFile(file, '{"invalid":TEST_ONLY}');
  await assert.rejects(loadConfig(file, false, {}), error => !error.message.includes('TEST_ONLY'));
});
test('模板排他创建，不覆盖原配置', async t => {
  const file = path.join(await temporary(t), 'config.json');
  await createConfig(file);
  const before = await readFile(file);
  await assert.rejects(createConfig(file), /没有覆盖/);
  assert.deepEqual(await readFile(file), before);
});
test('UTF-8 解码拒绝无效字节', () => {
  assert.throws(() => decodeUtf8(Uint8Array.of(0xff, 0xfe)), /UTF-8/);
});
test('路径和离线诊断不产生文件', async t => {
  const root = await temporary(t);
  assert.equal((await invoke(root, ['paths'])).code, 0);
  assert.equal((await invoke(root, ['doctor'])).code, 1);
  assert.deepEqual(await readdir(root), []);
});
test('不支持的参数不回显潜在秘密', async t => {
  const result = await invoke(await temporary(t), ['send', '--token', 'TEST_ONLY']);
  assert.equal(result.code, 2);
  assert.ok(!result.text.includes('TEST_ONLY'));
});
test('正文来源互斥，文件错误不发送标题', async t => {
  const root = await temporary(t);
  assert.equal((await invoke(root, ['send', '--title', '标题', '--content', 'x', '--stdin'], fakeEnv)).code, 2);
  assert.equal((await invoke(root, ['send', '--title', '标题', '--content-file', path.join(root, 'missing')], fakeEnv)).code, 2);
});
test('dry-run 不发送，不输出正文、接收人或秘密', async t => {
  const result = await invoke(await temporary(t), ['send', '--title', 'PRIVATE_TITLE', '--content', 'PRIVATE_BODY'.repeat(1000), '--dry-run'], fakeEnv);
  assert.equal(result.code, 0);
  for (const value of ['TEST_ONLY', 'PRIVATE_TITLE', 'PRIVATE_BODY']) assert.ok(!result.text.includes(value));
  assert.match(result.text, /没有实际发送/);
});
test('显式缺失配置和缺少渠道均返回 2', async t => {
  const root = await temporary(t);
  assert.equal((await invoke(root, ['--config', path.join(root, 'missing'), 'doctor'])).code, 2);
  assert.equal((await invoke(root, ['send', '--title', '标题'])).code, 2);
});
test('模板需明确选择并保留已有配置', async t => {
  const root = await temporary(t);
  assert.equal((await invoke(root, ['setup'])).code, 2);
  assert.equal((await invoke(root, ['setup', '--template'], {}, { confirm: async () => false })).code, 130);
  assert.deepEqual(await readdir(root), []);
  assert.equal((await invoke(root, ['setup', '--template', '--yes'])).code, 0);
  assert.equal((await invoke(root, ['setup', '--template', '--yes'])).code, 2);
});
test('部分渠道失败不会被另一个渠道成功掩盖', async t => {
  const result = await invoke(await temporary(t), ['send', '--title', '标题'], fakeEnv, {
    send: async plan => ({ channel: plan.channel, planned: plan.items.length, sent: plan.channel === 'telegram' ? plan.items.length : 0,
      ok: plan.channel === 'telegram', error: plan.channel === 'telegram' ? undefined : '失败' }),
  });
  assert.equal(result.code, 1);
});
test('标准输入完整分段', async t => {
  const body = '中文😀正文'.repeat(3000);
  const root = await temporary(t);
  let actual = '';
  const result = await invoke(root, ['send', '--channel', 'telegram', '--title', '标题', '--stdin'], fakeEnv, {
    stdin: async () => Buffer.from(body), send: async plan => {
      actual = plan.items.map(item => item.plain.split('\n\n').slice(1).join('\n\n')).join('');
      return { channel: plan.channel, planned: plan.items.length, sent: plan.items.length, ok: true };
    },
  });
  assert.equal(result.code, 0);
  assert.equal(actual, body);
});
test('Markdown 支持标题、引用、列表、内联格式且保留链接地址', () => {
  const blocks = parseMarkdown('# 标题\n> 引用\n- [x] 完成\n**加粗** `代码` ~~删除~~ [链接](https://example.invalid)');
  const [chunk] = telegramParts(blocks, 3900);
  balanced(chunk.html);
  for (const tag of ['<b>', '<blockquote>', '<code>', '<s>']) assert.ok(chunk.html.includes(tag));
  assert.ok(chunk.plain.includes('https://example.invalid'));
  assert.ok(chunk.plain.includes('☑ 完成'));
});
test('代码、长表格、emoji、特殊字符按最终可见长度分段且无内容丢失', () => {
  const examples = ['😀中文<&> '.repeat(2000), '```text\n' + '示例代码行\n'.repeat(1500) + '```',
    '| ' + 'A'.repeat(1000) + ' | B |\n| --- | --- |\n' + '| x | y |\n'.repeat(8),
    '**' + '加粗😀'.repeat(2000) + '**'];
  for (const content of examples) {
    const blocks = parseMarkdown(content);
    const chunks = telegramParts(blocks, 3000);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.map(chunk => chunk.plain).join(''), visibleText(blocks));
    for (const chunk of chunks) {
      assert.ok(chunk.plain.length <= 3000);
      assert.equal(decode(chunk.html), chunk.plain);
      balanced(chunk.html);
      assert.ok(!/[\uD800-\uDBFF]$/.test(chunk.plain));
    }
  }
});
test('代码围栏必须匹配长度，不提前关闭较长围栏', () => {
  const blocks = parseMarkdown('````text\na\n```\nb\n````');
  assert.equal(blocks.length, 1);
  assert.equal(visibleText(blocks), 'a\n```\nb');
});
test('飞书普通正文分段完整，UTF-8 字节不超限', () => {
  const body = '中文😀正文\n\n'.repeat(1000);
  const chunks = feishuParts(parseMarkdown(body), 1000);
  assert.equal(chunks.join(''), body);
  for (const chunk of chunks) assert.ok(Buffer.byteLength(chunk) <= 1000);
});
test('飞书跨段代码和粗体各段闭合', () => {
  for (const [body, wrapper] of [['**' + '中文😀'.repeat(1000) + '**', '**'], ['```text\n' + '中文😀'.repeat(1000) + '\n```', '```']]) {
    const chunks = feishuParts(parseMarkdown(body), 1000);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) { assert.ok(chunk.startsWith(wrapper)); assert.ok(chunk.endsWith(wrapper)); }
  }
});
test('Telegram 两个接收人获得完整分段', () => {
  const cfg = config(); cfg.telegram.chatIds.push('222');
  const plan = makePlan('telegram', message('正文😀'.repeat(2000)), cfg);
  assert.equal(plan.recipients, 2);
  for (const recipient of cfg.telegram.chatIds) {
    const items = plan.items.filter(item => item.recipient === recipient);
    assert.ok(items.length > 1);
    for (const item of items) { assert.ok(item.plain.length <= 4096); assert.ok(item.plain.endsWith('会话辅助')); }
  }
});
test('Telegram HTML 回退只重发当前分段', async () => {
  const cfg = config(), plan = makePlan('telegram', message('正文😀'.repeat(2000)), cfg);
  const calls = [];
  const result = await deliver(plan, cfg, async (_, body) => {
    calls.push(structuredClone(body));
    return body.parse_mode ? { ok: false, description: "can't parse entities" } : { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, plan.items.length * 2);
  for (let i = 0; i < calls.length; i += 2) assert.equal(calls[i + 1].text, plan.items[i / 2].plain);
});
test('Telegram 429 最多重试一次且等待有界', async () => {
  const cfg = config(), plan = makePlan('telegram', message('正文'), cfg);
  let count = 0;
  const waits = [];
  const result = await deliver(plan, cfg, async () => {
    count++; return { ok: false, error_code: 429, parameters: { retry_after: 2 } };
  }, async ms => { waits.push(ms); });
  assert.equal(result.ok, false); assert.equal(count, 2); assert.deepEqual(waits, [2000]);
});
test('失败停止该接收人后续分段，其他接收人继续', async () => {
  const cfg = config(); cfg.telegram.chatIds.push('222');
  const plan = makePlan('telegram', message('正文'.repeat(7000)), cfg), calls = [];
  const result = await deliver(plan, cfg, async (_, payload) => { calls.push(payload.chat_id); return { ok: payload.chat_id === '222' }; });
  assert.equal(calls.filter(id => id === '111').length, 1);
  assert.equal(result.sent, plan.items.length / 2);
  assert.equal(result.ok, false);
});
test('飞书组件回退保留正文、签名、辅助信息及卡片大小', async () => {
  const cfg = config(), plan = makePlan('feishu', message('正文😀'.repeat(4000)), cfg);
  const original = structuredClone(plan), calls = [];
  const result = await deliver(plan, cfg, async (_, body) => {
    calls.push(structuredClone(body));
    return { code: body.card.elements[0].tag === 'markdown' ? 1 : 0 };
  }, async () => {});
  assert.equal(result.ok, true); assert.deepEqual(plan, original);
  assert.equal(calls.length, plan.items.length * 2);
  for (let i = 0; i < calls.length; i += 2) {
    assert.equal(calls[i].card.elements[0].content, calls[i + 1].card.elements[0].text.content);
    assert.ok(calls[i].sign);
    assert.ok(Buffer.byteLength(JSON.stringify(calls[i])) < 28000);
  }
});
test('过长元信息在发送前拒绝', () => {
  assert.throws(() => makePlan('telegram', { ...message('正文'), title: '甲'.repeat(5000) }, config()));
  assert.throws(() => makePlan('feishu', { ...message('正文'), title: '甲'.repeat(10000) }, config()));
});
test('传输禁止重定向，底层错误不泄漏秘密', async () => {
  await assert.rejects(requestJson('https://example.invalid/TEST_ONLY', {}, async (_, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    throw new Error('TEST_ONLY');
  }), error => !error.message.includes('TEST_ONLY'));
});
test('传输验证响应形状与最大字节数', async () => {
  for (const response of ['[]', 'not json', 'x'.repeat(1024 * 1024 + 1)]) {
    await assert.rejects(requestJson('https://example.invalid', {}, async () => new Response(response)));
  }
});
test('可列出可选应用集成且非交互密钥向导不回显输入', async t => {
  const root = await temporary(t);
  assert.match((await invoke(root, ['integration', 'list'])).text, /支持通知/);
  assert.match((await invoke(root, ['setup'])).text, /交互终端/);
});
