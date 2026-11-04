import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { KeyringStore, nativeStore, encodeBundle, decodeBundle, CredentialError } from '../dist/credentials.js';
import { example, parseConfig } from '../dist/config.js';
import { commitConfig, wizard, clearCredentials } from '../dist/setup.js';
import { main } from '../dist/cli.js';
import { readHidden, readText, Cancelled } from '../dist/prompts.js';
import { deliver, makePlan } from '../dist/channels.js';

globalThis.fetch = async () => { throw new Error('禁止真实网络请求'); };
const ID = 'a'.repeat(32);
const VALUES = { telegram_token: '123:TEST_ONLY', feishu_webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/TEST_ONLY', feishu_secret: 'TEST_ONLY' };
class Store {
  items = new Map();
  deleted = [];
  read(id) { return this.items.has(id) ? structuredClone(this.items.get(id)) : null; }
  create(id, values) { assert.ok(!this.items.has(id)); this.items.set(id, structuredClone(values)); }
  remove(id) { this.deleted.push(id); this.items.delete(id); }
}
function prompts(answers, secrets = []) {
  const output = [];
  return { output, out: text => output.push(text), text: async () => { assert.ok(answers.length); return answers.shift(); },
    secret: async () => { assert.ok(secrets.length); return secrets.shift(); } };
}
async function temp(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dev-notify-keyring-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'config.json') };
}
const data = () => ({ ...structuredClone(example), credentials: { backend: 'keyring', id: ID } });

test('系统引用一次加载且环境变量完整覆盖不触碰后端', () => {
  let reads = 0;
  const resolve = () => { reads++; return VALUES; };
  const actual = parseConfig(data(), {}, resolve);
  assert.equal(actual.telegram.token, VALUES.telegram_token); assert.equal(reads, 1);
  const overridden = parseConfig(data(), { TELEGRAM_BOT_TOKEN: '', FEISHU_WEBHOOK: '', FEISHU_SECRET: '' }, () => { throw new Error('不应读取'); });
  assert.equal(overridden.telegram.token, ''); assert.equal(overridden.feishu.webhook, '');
});
test('禁用渠道不读取系统秘密，后端失败不能静默降级', () => {
  const source = data(); source.telegram.enabled = false; source.feishu.enabled = false;
  parseConfig(source, {}, () => { throw new Error('不应读取'); });
  assert.throws(() => parseConfig(data(), {}, () => { throw new CredentialError('存储锁定'); }), /锁定/);
});
test('秘密包验证大小、类型且不回显秘密', () => {
  for (const bytes of [Buffer.from('TEST_ONLY'), Buffer.from('[]'), Buffer.from('{"unknown":"TEST_ONLY"}'), Buffer.from('{"telegram_token":1}')]) {
    assert.throws(() => decodeBundle(bytes), error => !error.message.includes('TEST_ONLY'));
  }
  assert.throws(() => encodeBundle({ telegram_token: 'x'.repeat(2500) }), /2400/);
});
test('原生适配器仅访问指定条目且不覆盖已存在凭据', () => {
  const memory = new Map();
  class Entry {
    constructor(service, account) { assert.equal(service, 'dev-notify.node.credentials.v1'); this.id = account; }
    getSecret() { return memory.get(this.id) ?? null; }
    setSecret(bytes) { memory.set(this.id, [...bytes]); }
    deleteCredential() { return memory.delete(this.id); }
  }
  const store = new KeyringStore(Entry);
  assert.equal(store.read(ID), null);
  store.create(ID, VALUES); assert.deepEqual(store.read(ID), VALUES);
  assert.throws(() => store.create(ID, VALUES), /没有覆盖/);
  store.remove(ID); assert.equal(store.read(ID), null);
  assert.throws(() => store.read('../bad'), /引用无效/);
});
test('原生后端底层错误被脱敏且半写入失败尝试清理', () => {
  let removed = false;
  class Entry {
    getSecret() { return null; }
    setSecret() { throw new Error('TEST_ONLY'); }
    deleteCredential() { removed = true; return true; }
  }
  assert.throws(() => new KeyringStore(Entry).create(ID, VALUES), error => !error.message.includes('TEST_ONLY'));
  assert.equal(removed, true);
});
test('向导首次保存不把秘密写入 JSON，默认确认发送测试', async t => {
  const { file } = await temp(t), store = new Store();
  const ui = prompts(['3', '111,222', ''], Object.values(VALUES));
  let sent = false;
  assert.equal(await wizard(file, { store, prompts: ui, env: {}, testSend: async () => { sent = true; return true; } }), true);
  const raw = await readFile(file, 'utf8'), saved = JSON.parse(raw);
  assert.ok(!raw.includes('TEST_ONLY')); assert.ok(!ui.output.join().includes('TEST_ONLY'));
  assert.deepEqual(saved.telegram.chat_ids, ['111', '222']);
  assert.deepEqual(store.read(saved.credentials.id), VALUES); assert.equal(sent, true);
});
test('向导自动发现接收人并支持编号选择', async t => {
  const { file } = await temp(t), store = new Store();
  const ui = prompts(['1', '#2,#1', ''], [VALUES.telegram_token]);
  let seenToken;
  assert.equal(await wizard(file, { store, prompts: ui, env: {}, discover: async token => {
    seenToken = token;
    return [{ id: '111', title: 'Alice', kind: 'private' }, { id: '-100123', title: '团队', kind: 'supergroup' }];
  } }), true);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved.telegram.chat_ids, ['-100123', '111']);
  assert.equal(seenToken, VALUES.telegram_token);
  assert.ok(ui.output.some(line => line.includes('#2') && line.includes('团队')));
  assert.ok(!ui.output.join().includes('TEST_ONLY'));
});
test('编号越界后可重试，桥接运行时跳过自动发现', async t => {
  const { file } = await temp(t), store = new Store();
  const ui = prompts(['1', '#9', '#1', ''], [VALUES.telegram_token]);
  assert.equal(await wizard(file, { store, prompts: ui, env: {}, discover: async () => [
    { id: '111', title: 'Alice', kind: 'private' }] }), true);
  assert.ok(ui.output.some(line => line.includes('编号超出范围')));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).telegram.chat_ids, ['111']);

  const running = await temp(t), runStore = new Store();
  await mkdir(path.join(running.file + '.reply-data'), { recursive: true });
  await writeFile(path.join(running.file + '.reply-data', 'bridge.json'),
    JSON.stringify({ pid: process.pid, owner: 'test', ready: true, updated: Date.now() }));
  let called = false;
  const runUi = prompts(['1', '222', ''], [VALUES.telegram_token]);
  assert.equal(await wizard(running.file, { store: runStore, prompts: runUi, env: {},
    discover: async () => { called = true; return []; } }), true);
  assert.equal(called, false);
  assert.ok(runUi.output.some(line => line.includes('桥接正在运行')));
});
test('完整向导→系统引用→双渠道模拟发送链路', async t => {  const { file } = await temp(t), store = new Store(), ui = prompts(['3', '111', ''], Object.values(VALUES));
  let deliveries = 0;
  assert.equal(await wizard(file, { store, prompts: ui, env: {}, testSend: async config => {
    for (const channel of ['telegram', 'feishu']) {
      const plan = makePlan(channel, { title: '测试', content: '测试正文😀'.repeat(2000), level: 'info', footer: '' }, config);
      const result = await deliver(plan, config, async () => { deliveries++; return { ok: true, code: 0 }; }, async () => {});
      assert.equal(result.ok, true);
    }
    return true;
  } }), true);
  assert.ok(deliveries > 2);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parseConfig(saved, {}, ref => store.read(ref.id)).telegram.token, VALUES.telegram_token);
});
test('取消保存不写配置或系统条目', async t => {
  const { file, root } = await temp(t), store = new Store();
  assert.equal(await wizard(file, { store, prompts: prompts(['1', '111', 'n'], [VALUES.telegram_token]), env: {} }), false);
  assert.equal(store.items.size, 0); assert.deepEqual(await readdir(root), []);
});
test('输入错误可重试且敏感内容不回显', async t => {
  const { file } = await temp(t), store = new Store(), ui = prompts(['1', 'invalid', '111', ''], ['WRONG_SECRET', VALUES.telegram_token]);
  assert.equal(await wizard(file, { store, prompts: ui, env: {} }), true);
  assert.ok(!ui.output.join().includes('WRONG_SECRET'));
});
test('更新留空保留，签名可清除，成功后删除旧条目', async t => {
  const { file } = await temp(t), store = new Store();
  const original = data(); original.telegram.chat_ids = ['111'];
  await writeFile(file, JSON.stringify(original)); store.create(ID, VALUES);
  const ui = prompts(['', '', ''], ['', '', '-']);
  assert.equal(await wizard(file, { store, prompts: ui, env: {} }), true);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.notEqual(saved.credentials.id, ID); assert.equal(store.read(ID), null);
  assert.equal(store.read(saved.credentials.id).telegram_token, VALUES.telegram_token);
  assert.equal(store.read(saved.credentials.id).feishu_secret, '');
});
test('旧版原型引用迁移仅重新输入，不删除旧原型凭据', async t => {
  const { file } = await temp(t), store = new Store();
  const source = data(); source.credentials.backend = 'system';
  await writeFile(file, JSON.stringify(source));
  const ui = prompts(['1', '111', ''], [VALUES.telegram_token]);
  assert.equal(await wizard(file, { store, prompts: ui, env: {} }), true);
  assert.equal(store.deleted.includes(ID), false);
  assert.ok(ui.output.some(line => line.includes('旧版原型的旧凭据仍然保留')));
});
test('缺失旧凭据可明确确认后重配', async t => {
  const { file } = await temp(t), store = new Store();
  await writeFile(file, JSON.stringify(data()));
  assert.equal(await wizard(file, { store, prompts: prompts(['1', 'y', '111', ''], [VALUES.telegram_token]), env: {} }), true);
});
test('保存后测试失败不伪装为保存失败或撤销配置', async t => {
  const { file } = await temp(t), store = new Store(), ui = prompts(['1', '111', ''], [VALUES.telegram_token]);
  assert.equal(await wizard(file, { store, prompts: ui, env: {}, testSend: async () => false }), true);
  assert.ok(ui.output.some(line => line.includes('配置已保存。测试通知没有发送成功')));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).credentials.backend, 'keyring');
});
test('网络测试使用环境覆盖后的最终配置', async t => {
  const { file } = await temp(t), store = new Store();
  let token;
  await wizard(file, { store, prompts: prompts(['1', '111', ''], [VALUES.telegram_token]),
    env: { TELEGRAM_BOT_TOKEN: '456:OVERRIDE' }, testSend: async config => { token = config.telegram.token; return true; } });
  assert.equal(token, '456:OVERRIDE');
});
test('配置替换失败保留旧文件，仅删除本次新条目', async t => {
  const { file, root } = await temp(t), store = new Store();
  const source = data(), before = Buffer.from(JSON.stringify(source));
  await writeFile(file, before); store.create(ID, VALUES);
  await assert.rejects(commitConfig(file, source, before, store, VALUES, { replace: async () => { throw new Error('拒绝替换'); } }));
  assert.deepEqual(await readFile(file), before); assert.deepEqual([...store.items.keys()], [ID]);
  assert.deepEqual(await readdir(root), ['config.json']);
});
test('向导期间外部编辑不被覆盖', async t => {
  const { file } = await temp(t), store = new Store();
  await writeFile(file, 'external');
  await assert.rejects(commitConfig(file, example, null, store, VALUES), /发生了变化/);
  assert.equal(await readFile(file, 'utf8'), 'external'); assert.equal(store.items.size, 0);
});
test('已有写入锁不被移除', async t => {
  const { file } = await temp(t), store = new Store();
  await writeFile(file + '.setup.lock', 'other');
  await assert.rejects(commitConfig(file, example, null, store, VALUES), /锁/);
  assert.equal(await readFile(file + '.setup.lock', 'utf8'), 'other'); assert.equal(store.items.size, 0);
});
test('凭据校验失败不切换配置且清理新条目', async t => {
  const { file, root } = await temp(t), store = new Store();
  store.read = () => ({});
  await assert.rejects(commitConfig(file, example, null, store, VALUES), /校验失败/);
  assert.equal(store.items.size, 0); assert.deepEqual(await readdir(root), []);
});
test('新凭据清理失败只报告引用 ID', async t => {
  const { file } = await temp(t), store = new Store(), warnings = [];
  store.remove = () => { throw new Error('TEST_ONLY'); };
  await assert.rejects(commitConfig(file, example, null, store, VALUES, {
    replace: async () => { throw new Error(); }, warn: text => warnings.push(text),
  }));
  assert.ok(warnings.join().includes('引用 ID')); assert.ok(!warnings.join().includes('TEST_ONLY'));
});
test('旧凭据清理失败仍保留成功的新配置', async t => {
  const { file } = await temp(t), store = new Store(), warnings = [];
  const source = data(), before = Buffer.from(JSON.stringify(source));
  await writeFile(file, before); store.create(ID, VALUES);
  const originalRemove = store.remove.bind(store);
  store.remove = id => { if (id === ID) throw new Error('TEST_ONLY'); originalRemove(id); };
  await commitConfig(file, source, before, store, VALUES, { warn: text => warnings.push(text) });
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.notEqual(saved.credentials.id, ID); assert.ok(store.read(saved.credentials.id));
  assert.ok(warnings.join().includes('旧凭据没有清理掉')); assert.ok(!warnings.join().includes('TEST_ONLY'));
});
test('清除凭据必须确认；取消不修改，确认移除引用及条目', async t => {
  const { file } = await temp(t), store = new Store(), source = data();
  await writeFile(file, JSON.stringify(source)); store.create(ID, VALUES);
  assert.equal(await clearCredentials(file, prompts(['n']), store), false); assert.ok(store.read(ID));
  assert.equal(await clearCredentials(file, prompts(['y']), store), true);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).credentials, undefined); assert.equal(store.read(ID), null);
});
test('清除命令不删除旧版原型凭据', async t => {
  const { file } = await temp(t), source = data(); source.credentials.backend = 'system';
  await writeFile(file, JSON.stringify(source));
  await assert.rejects(clearCredentials(file, prompts([]), new Store()), /跨实现删除/);
});
test('非交互隐藏输入直接拒绝，CLI 禁止跳过凭据写入确认', async t => {
  await assert.rejects(readHidden('不要回显'), /隐藏输入/);
  const { root } = await temp(t), output = [];
  assert.equal(await main(['setup', '--yes'], { env: { DEV_NOTIFY_HOME: root }, out: t => output.push(t), err: t => output.push(t) }), 2);
  assert.ok(output.join().includes('仍然需要确认'));
});
test('Ctrl+C 取消向导返回 130', async t => {
  const { root } = await temp(t);
  const ui = { out: () => {}, text: async () => { throw new Cancelled(); }, secret: async () => '' };
  assert.equal(await main(['setup'], { env: { DEV_NOTIFY_HOME: root }, prompts: ui, out: () => {}, err: () => {} }), 130);
});
function fakeTerminal(t) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = true; input.isRaw = false; output.isTTY = true;
  input.setRawMode = mode => { input.isRaw = mode; return input; };
  let written = '';
  output.on('data', chunk => { written += chunk.toString(); });
  t.after(() => { input.destroy(); output.destroy(); });
  return { input, output, written: () => written };
}
test('隐藏输入无回显，退格与 Unicode 正确处理且恢复 raw mode', async t => {
  const terminal = fakeTerminal(t);
  const result = readHidden('密钥：', terminal.input, terminal.output);
  terminal.input.emit('keypress', 'TEST_ONLY', {});
  terminal.input.emit('keypress', '😀', {});
  terminal.input.emit('keypress', undefined, { name: 'backspace' });
  terminal.input.emit('keypress', 'x', {});
  terminal.input.emit('keypress', undefined, { name: 'return' });
  assert.equal(await result, 'TEST_ONLYx');
  assert.equal(terminal.input.isRaw, false);
  assert.equal(terminal.input.listenerCount('keypress'), 0);
  assert.ok(!terminal.written().includes('TEST_ONLY'));
});
test('隐藏输入 Ctrl+C 取消不回显且清理监听器', async t => {
  const terminal = fakeTerminal(t);
  const result = readHidden('密钥：', terminal.input, terminal.output);
  terminal.input.emit('keypress', 'TEST_ONLY', {});
  terminal.input.emit('keypress', undefined, { name: 'c', ctrl: true });
  await assert.rejects(result, Cancelled);
  assert.equal(terminal.input.isRaw, false);
  assert.equal(terminal.input.listenerCount('keypress'), 0);
  assert.ok(!terminal.written().includes('TEST_ONLY'));
});
test('不能启用 raw mode 时立即失败，不读取回显秘密', async t => {
  const terminal = fakeTerminal(t);
  terminal.input.setRawMode = () => { throw new Error('raw mode unavailable'); };
  await assert.rejects(readHidden('密钥：', terminal.input, terminal.output), /隐藏输入没有完成/);
  assert.equal(terminal.input.listenerCount('keypress'), 0);
  assert.ok(!terminal.written().includes('密钥：'));
});
test('普通输入的 Ctrl+C 和 EOF 均取消，不挂起向导', { timeout: 2000 }, async t => {
  for (const control of ['interrupt', 'eof']) {
    const terminal = fakeTerminal(t);
    const result = readText('选择：', terminal.input, terminal.output);
    if (control === 'interrupt') terminal.input.write('\x03');
    else terminal.input.end();
    await assert.rejects(result, Cancelled);
    assert.equal(terminal.input.isRaw, false);
  }
});
test('Windows 原生存储假密钥往返且清理本次随机条目', { skip: process.env.DEV_NOTIFY_NATIVE_TEST !== '1' || process.platform !== 'win32' }, () => {
  const store = nativeStore(), id = randomBytes(16).toString('hex');
  assert.equal(store.read(id), null);
  try { store.create(id, { telegram_token: '123:DEV_NOTIFY_TEST_NOT_REAL' });
    assert.equal(store.read(id).telegram_token, '123:DEV_NOTIFY_TEST_NOT_REAL');
  } finally { store.remove(id); }
  assert.equal(store.read(id), null);
});
