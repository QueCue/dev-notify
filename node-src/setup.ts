import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ConfigError, decodeUtf8, example, parseConfig, ready, type Config, type Env } from './config.js';
import { encodeBundle, nativeStore, type Bundle, type Reference, type Store } from './credentials.js';
import { terminalPrompts, type Prompts } from './prompts.js';

export type RawConfig = Record<string, any>;
const yes = (text: string) => /^(y|yes)$/i.test(text.trim());
const defaultYes = (text: string) => !text.trim() || yes(text);
export async function snapshot(file: string): Promise<Buffer | null> {
  try { return await readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new ConfigError('无法读取现有配置，未修改'); }
}
function same(left: Buffer | null, right: Buffer | null) { return left === null ? right === null : right !== null && left.equals(right); }
export function readRaw(raw: Buffer | null): RawConfig {
  if (raw === null) return structuredClone(example);
  let data;
  try { data = JSON.parse(decodeUtf8(raw)); }
  catch { throw new ConfigError('现有配置损坏，未覆盖；请先修复 JSON'); }
  parseConfig(data, {}, () => ({}));
  return data;
}
async function removeFile(file: string) {
  try { await unlink(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export interface CommitOptions {
  warn?: (text: string) => void;
  replace?: typeof rename;
}
export async function commitConfig(file: string, data: RawConfig, expected: Buffer | null,
  store: Store, values: Bundle | null, options: CommitOptions = {}): Promise<void> {
  const warn = options.warn ?? (text => console.error(text));
  const target = structuredClone(data);
  const old = target.credentials as Reference | undefined;
  const id = randomBytes(16).toString('hex');
  if (values !== null) {
    encodeBundle(values);
    target.credentials = { backend: 'keyring', id };
    parseConfig(target, {}, () => values);
  } else { delete target.credentials; parseConfig(target, {}); }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = file + '.setup.lock';
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new ConfigError('配置写入锁不可用；请检查权限，或确认没有运行中的向导后处理残留 .setup.lock'); }
  const temporary = path.join(path.dirname(file), `.config-${id}.tmp`);
  let created = false, committed = false, tempCreated = false;
  try {
    await lock.close();
    if (!same(await snapshot(file), expected)) throw new ConfigError('配置在向导期间已变化，未覆盖，请重试');
    if (values !== null) {
      store.create(id, values); created = true;
      const check = store.read(id);
      if (check === null || JSON.stringify(check) !== JSON.stringify(values)) throw new ConfigError('凭据写入校验失败，未切换配置');
    }
    const stream = await open(temporary, 'wx', 0o600); tempCreated = true;
    try { await stream.writeFile(JSON.stringify(target, null, 2) + '\n', 'utf8'); await stream.sync(); }
    finally { await stream.close(); }
    if (!same(await snapshot(file), expected)) throw new ConfigError('配置在保存期间已变化，未覆盖，请重试');
    await (options.replace ?? rename)(temporary, file); committed = true;
  } finally {
    if (tempCreated) { try { await removeFile(temporary); } catch { warn(`临时配置清理失败：${path.basename(temporary)}`); } }
    if (created && !committed) {
      try { store.remove(id); } catch { warn(`配置未切换，但新凭据清理失败；引用 ID：${id}`); }
    }
    try { await removeFile(lockPath); } catch { warn('配置写入锁清理失败，请确认没有向导运行后处理 .setup.lock'); }
  }
  if (old?.backend === 'keyring') {
    try { store.remove(old.id); } catch { warn(`配置已保存，但旧凭据清理失败；引用 ID：${old.id}`); }
  } else if (old?.backend === 'system') {
    warn('Python 原型旧凭据未删除；仍由原型管理，避免跨实现误删');
  }
}
export interface SetupOptions {
  prompts?: Prompts;
  store?: Store;
  env?: Env;
  testSend?: (config: Config) => Promise<boolean>;
  /** 在唯一一次确认前展示的安装范围说明。 */
  notes?: string[];
  /** 确认后执行的附加安装（如 Claude Code hooks）；失败不影响已保存的配置。 */
  afterSave?: () => Promise<void>;
}
export async function wizard(file: string, options: SetupOptions = {}): Promise<boolean> {
  const prompts = options.prompts ?? terminalPrompts();
  const before = await snapshot(file), data = readRaw(before);
  const { out } = prompts;
  out(`配置路径：${file}`);
  out('所选渠道的 Token、webhook 和签名密钥均为隐藏输入（不回显），存入 Windows Credential Manager / macOS Keychain；JSON 只保存引用。');
  const telegramEnabled = data.telegram?.enabled !== false;
  const feishuEnabled = data.feishu?.enabled !== false;
  const current = before === null ? ''
    : telegramEnabled && feishuEnabled ? '3'
      : telegramEnabled ? '1' : feishuEnabled ? '2' : '';
  const entered = await prompts.text(`选择渠道：1 Telegram，2 飞书，3 两者${current ? ` [${current}]` : ''}；其他输入取消：`);
  const selection = entered || current;
  if (!['1', '2', '3'].includes(selection)) return false;
  const store = options.store ?? nativeStore();
  let previous: Bundle = {};
  const reference = data.credentials as Reference | undefined;
  if (reference?.backend === 'keyring') {
    try {
      const existing = store.read(reference.id);
      if (!existing) throw new Error();
      previous = existing;
    } catch {
      out('原凭据无法读取，可能缺失、锁定或权限不足。');
      if (!yes(await prompts.text('放弃旧值，重新输入所选渠道凭据？[y/N] '))) return false;
    }
  } else if (reference?.backend === 'system') out('检测到 Python 原型凭据；本次重新输入保存，旧凭据不读取、不删除。');
  data.telegram ??= {}; data.feishu ??= {};
  data.telegram.enabled = selection !== '2'; data.feishu.enabled = selection !== '1';
  const values: Bundle = {};
  const readValue = async (label: string, key: keyof Bundle, required: boolean) => {
    while (true) {
      const hint = previous[key] ? '留空保留已存值' : '不从环境变量自动复制';
      const optional = required ? '' : '可选；';
      const answer = await prompts.secret(`${label}（隐藏输入，不回显；${optional}${hint}${required ? '' : '；输入 - 清除'}）：`);
      const value = !required && answer === '-' ? '' : answer || previous[key] || '';
      if (required && !value) { out('此项不能为空，请重试，或 Ctrl+C 取消。'); continue; }
      try {
        const check: RawConfig = { telegram: { enabled: key === 'telegram_token', chat_ids: ['1'] },
          feishu: { enabled: key !== 'telegram_token' }, credentials: { backend: 'keyring', id: '0'.repeat(32) } };
        parseConfig(check, {}, () => ({ [key]: value }));
        return value;
      } catch { out('格式不正确，请检查后重新输入；不会显示秘密。'); }
    }
  };
  if (data.telegram.enabled) {
    values.telegram_token = await readValue('Telegram Bot Token', 'telegram_token', true);
    out('接收人需要先启动 Bot；本轮手动填写数字 chat_id，不启动 getUpdates 或自动配对。');
    while (true) {
      const entered = await prompts.text('接收人 chat_id，多个用逗号分隔（留空保留原名单）：');
      const ids = entered ? entered.split(',').map(item => item.trim()) : data.telegram.chat_ids ?? [];
      try {
        if (!ids.length) throw new Error();
        const check = parseConfig({ telegram: { chat_ids: ids } }, {});
        data.telegram.chat_ids = check.telegram.chatIds; break;
      } catch { out('请填写至少一个有效数字 chat_id，或 Ctrl+C 取消。'); }
    }
  }
  if (data.feishu.enabled) {
    values.feishu_webhook = await readValue('飞书 webhook', 'feishu_webhook', true);
    values.feishu_secret = await readValue('飞书签名密钥', 'feishu_secret', false);
  }
  encodeBundle(values);
  const preview = { ...data, credentials: { backend: 'keyring', id: '0'.repeat(32) } };
  parseConfig(preview, {}, () => values);
  const env = options.env ?? process.env;
  out(`将启用：${data.telegram.enabled ? `Telegram（${data.telegram.chat_ids.length} 个接收人）` : ''}${data.feishu.enabled ? ' 飞书' : ''}`);
  out('环境变量仍优先（含显式空值）；测试通知会使用最终生效的配置，不一定是刚输入的值。');
  const overrides = [data.telegram.token_env ?? 'TELEGRAM_BOT_TOKEN', data.feishu.webhook_env ?? 'FEISHU_WEBHOOK',
    data.feishu.secret_env ?? 'FEISHU_SECRET', 'TELEGRAM_CHAT_ID', 'TELEGRAM_CHAT_IDS'].filter(name => Object.hasOwn(env, name));
  if (overrides.length) out('当前存在环境覆盖：' + overrides.join('、'));
  if (reference?.backend === 'keyring') out('保存成功后删除旧凭据；共享旧引用 ID 的配置副本也需更新。');
  out('未选中的渠道会禁用；新条目只保存所选渠道凭据。');
  for (const line of options.notes ?? []) out(line);
  const actions = ['保存配置和系统凭据'];
  if (options.testSend) actions.push('发送固定内容的测试通知');
  if (options.afterSave) actions.push('安装 Claude Code 通知 hooks');
  const extraActions = actions.slice(1);
  const question = extraActions.length
    ? `确认${actions[0]}，并${extraActions.join('、')}？[Y/n] ` : `确认${actions[0]}？[Y/n] `;
  if (!defaultYes(await prompts.text(question))) return false;
  await commitConfig(file, data, before, store, values, { warn: out });
  out('配置和系统凭据已保存。');
  if (options.testSend) {
    try {
      const effective = parseConfig(preview, env, () => values);
      const ok = await options.testSend(effective);
      out(ok ? '测试通知发送成功。' : '配置已保存，但测试通知失败或没有可用渠道；请运行 doctor 检查。');
    } catch { out('配置已保存，但环境覆盖或网络导致测试失败；请运行 doctor 检查。'); }
  } else out('未发送测试通知。');
  if (options.afterSave) {
    try { await options.afterSave(); }
    catch (error) {
      out(`配置已保存，但 Claude Code hooks 安装未完成：${error instanceof ConfigError ? error.message : '请运行 integration claude-code status 检查'}`);
    }
  }
  try {
    if (ready(parseConfig(preview, env, () => values), 'telegram')) {
      out('如需从 Telegram 回复 Claude，请另行运行：dev-notify reply setup');
    }
  } catch { /* 环境覆盖无效时上方测试分支已报告。 */ }
  return true;
}
export async function clearCredentials(file: string, prompts: Prompts, store?: Store): Promise<boolean> {
  const before = await snapshot(file), data = readRaw(before);
  const reference = data.credentials as Reference | undefined;
  if (!reference) { prompts.out('此配置没有系统凭据引用，未修改。'); return true; }
  if (reference.backend !== 'keyring') throw new ConfigError('这是 Python 原型的凭据，Node 不执行跨实现删除');
  prompts.out('将移除当前配置的系统凭据引用并删除其条目；环境变量不变，共享引用的配置副本将失效。');
  if (!yes(await prompts.text('确认清除？[y/N] '))) return false;
  await commitConfig(file, data, before, store ?? nativeStore(), null, { warn: prompts.out });
  prompts.out('凭据引用已移除；如删除条目失败，上方会显示警告。');
  return true;
}
