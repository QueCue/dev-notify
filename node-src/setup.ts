import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ConfigError, decodeUtf8, example, parseConfig, ready, type Config, type Env } from './config.js';
import { encodeBundle, nativeStore, type Bundle, type Reference, type Store } from './credentials.js';
import { getLocale, joinList, t, type Locale } from './i18n.js';
import { terminalPrompts, type Prompts } from './prompts.js';
import { bridgeStatus } from './reply-bridge.js';
import { discoverChats, type ChatCandidate } from './telegram-discovery.js';

export type RawConfig = Record<string, any>;
const yes = (text: string) => /^(y|yes)$/i.test(text.trim());
const defaultYes = (text: string) => !text.trim() || yes(text);
const KIND_KEYS = {
  private: 'setup.discoveryKind.private',
  group: 'setup.discoveryKind.group',
  supergroup: 'setup.discoveryKind.supergroup',
  channel: 'setup.discoveryKind.channel',
  unknown: 'setup.discoveryKind.unknown',
} as const;
export async function snapshot(file: string): Promise<Buffer | null> {
  try { return await readFile(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new ConfigError(t('setup.readFailed')); }
}
function same(left: Buffer | null, right: Buffer | null) { return left === null ? right === null : right !== null && left.equals(right); }
export function readRaw(raw: Buffer | null): RawConfig {
  if (raw === null) return structuredClone(example);
  let data;
  try { data = JSON.parse(decodeUtf8(raw)); }
  catch { throw new ConfigError(t('setup.parseFailed')); }
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
  /** 只更新配置，不触碰现有凭据引用。 */
  keepCredentials?: boolean;
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
  } else if (options.keepCredentials) { parseConfig(target, {}, () => ({})); }
  else { delete target.credentials; parseConfig(target, {}); }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = file + '.setup.lock';
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new ConfigError(t('setup.lockUnavailable')); }
  const temporary = path.join(path.dirname(file), `.config-${id}.tmp`);
  let created = false, committed = false, tempCreated = false;
  try {
    await lock.close();
    if (!same(await snapshot(file), expected)) throw new ConfigError(t('setup.changedDuringWizard'));
    if (values !== null) {
      store.create(id, values); created = true;
      const check = store.read(id);
      if (check === null || JSON.stringify(check) !== JSON.stringify(values)) throw new ConfigError(t('setup.credentialVerifyFailed'));
    }
    const stream = await open(temporary, 'wx', 0o600); tempCreated = true;
    try { await stream.writeFile(JSON.stringify(target, null, 2) + '\n', 'utf8'); await stream.sync(); }
    finally { await stream.close(); }
    if (!same(await snapshot(file), expected)) throw new ConfigError(t('setup.changedDuringSave'));
    await (options.replace ?? rename)(temporary, file); committed = true;
  } finally {
    if (tempCreated) { try { await removeFile(temporary); } catch { warn(t('setup.tempCleanupFailed', { name: path.basename(temporary) })); } }
    if (created && !committed) {
      try { store.remove(id); } catch { warn(t('setup.credentialCleanupFailed', { id })); }
    }
    try { await removeFile(lockPath); } catch { warn(t('setup.lockCleanupFailed')); }
  }
  if (!options.keepCredentials && old?.backend === 'keyring') {
    try { store.remove(old.id); } catch { warn(t('setup.oldCredentialCleanupFailed', { id: old.id })); }
  } else if (!options.keepCredentials && old?.backend === 'system') {
    warn(t('setup.oldSystemRetained'));
  }
}
export interface SetupOptions {
  prompts?: Prompts;
  store?: Store;
  env?: Env;
  testSend?: (config: Config) => Promise<boolean>;
  /** 在唯一一次确认前展示的安装范围说明。 */
  notes?: string[];
  /** 自动发现 Telegram 会话；测试可注入，默认读取 Bot 最近的更新。 */
  discover?: (token: string) => Promise<ChatCandidate[]>;
  /** 确认后执行的附加安装（如 Claude Code hooks）；失败不影响已保存的配置。 */
  afterSave?: () => Promise<void>;
}
export async function wizard(file: string, options: SetupOptions = {}): Promise<boolean> {
  const prompts = options.prompts ?? terminalPrompts();
  const env = options.env ?? process.env;
  const before = await snapshot(file), data = readRaw(before);
  const { out } = prompts;
  if (before === null) data.language = getLocale();
  out(t('setup.path', { file }));
  out(t('setup.secretsNote'));
  const telegramEnabled = data.telegram?.enabled !== false;
  const feishuEnabled = data.feishu?.enabled !== false;
  const current = before === null ? ''
    : telegramEnabled && feishuEnabled ? '3'
      : telegramEnabled ? '1' : feishuEnabled ? '2' : '';
  const entered = await prompts.text(t('setup.channelPrompt', { current: current ? ` [${current}]` : '' }));
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
      out(t('setup.credentialUnreadable'));
      if (!yes(await prompts.text(t('setup.reenterPrompt')))) return false;
    }
  } else if (reference?.backend === 'system') out(t('setup.oldSystemDetected'));
  data.telegram ??= {}; data.feishu ??= {};
  data.telegram.enabled = selection !== '2'; data.feishu.enabled = selection !== '1';
  const values: Bundle = {};
  const readValue = async (label: string, key: keyof Bundle, required: boolean) => {
    while (true) {
      const prompt = required
        ? previous[key] ? 'setup.secretRequiredKeep' : 'setup.secretRequiredNew'
        : previous[key] ? 'setup.secretOptionalKeep' : 'setup.secretOptionalNew';
      const answer = await prompts.secret(t(prompt, { label }));
      const value = !required && answer === '-' ? '' : answer || previous[key] || '';
      if (required && !value) { out(t('setup.requiredBlank')); continue; }
      try {
        const check: RawConfig = { telegram: { enabled: key === 'telegram_token', chat_ids: ['1'] },
          feishu: { enabled: key !== 'telegram_token' }, credentials: { backend: 'keyring', id: '0'.repeat(32) } };
        parseConfig(check, {}, () => ({ [key]: value }));
        return value;
      } catch { out(t('setup.invalidFormat')); }
    }
  };
  if (data.telegram.enabled) {
    values.telegram_token = await readValue('Telegram Bot Token', 'telegram_token', true);
    // 与保存后的运行时一致：显式存在的 token 环境变量优先，空值同样覆盖。
    const tokenEnv = typeof data.telegram.token_env === 'string' ? data.telegram.token_env : 'TELEGRAM_BOT_TOKEN';
    const discoveryToken = Object.hasOwn(env, tokenEnv) ? (env[tokenEnv] ?? '').trim() : values.telegram_token;
    let candidates: ChatCandidate[] = [];
    let discoveryRan = false;
    try {
      if ((await bridgeStatus(file)).running) out(t('setup.discoveryBridgeRunning'));
      else {
        candidates = await (options.discover ?? discoverChats)(discoveryToken);
        discoveryRan = true;
      }
    } catch (error) {
      out(t('setup.discoveryFailed', { reason: error instanceof ConfigError ? error.message : t('common.failure') }));
    }
    if (candidates.length) {
      out(t('setup.discoveryFound'));
      candidates.forEach((chat, index) => out(`  #${index + 1}  ${chat.id}  ${chat.title}  (${t(KIND_KEYS[chat.kind])})`));
      out(t('setup.telegramChatInstructionDiscovered'));
    } else {
      if (discoveryRan) out(t('setup.discoveryEmpty'));
      out(t('setup.telegramChatInstruction'));
    }
    const chatPrompt = t(candidates.length ? 'setup.telegramChatPromptDiscovered' : 'setup.telegramChatPrompt');
    while (true) {
      const entered = await prompts.text(chatPrompt);
      let ids: unknown[];
      if (!entered) ids = data.telegram.chat_ids ?? [];
      else if (candidates.length && /^#\d+(?:\s*,\s*#\d+)*$/.test(entered)) {
        const indexes = entered.split(',').map(item => Number(item.trim().slice(1)));
        if (indexes.some(value => !Number.isSafeInteger(value) || value < 1 || value > candidates.length)) {
          out(t('setup.discoverySelectionInvalid')); continue;
        }
        ids = [...new Set(indexes.map(value => candidates[value - 1].id))];
      } else ids = entered.split(',').map(item => item.trim());
      try {
        if (!ids.length) throw new Error();
        const check = parseConfig({ telegram: { chat_ids: ids } }, {});
        data.telegram.chat_ids = check.telegram.chatIds; break;
      } catch { out(t(candidates.length ? 'setup.telegramChatInvalidDiscovered' : 'setup.telegramChatInvalid')); }
    }
  }
  if (data.feishu.enabled) {
    values.feishu_webhook = await readValue(t('setup.labelFeishuWebhook'), 'feishu_webhook', true);
    values.feishu_secret = await readValue(t('setup.labelFeishuSecret'), 'feishu_secret', false);
  }
  encodeBundle(values);
  const preview = { ...data, credentials: { backend: 'keyring', id: '0'.repeat(32) } };
  parseConfig(preview, {}, () => values);
  const channels: string[] = [];
  if (data.telegram.enabled) channels.push(t('setup.channelTelegram', { count: data.telegram.chat_ids.length }));
  if (data.feishu.enabled) channels.push(t('setup.channelFeishu'));
  out(t('setup.channelsEnabled', { channels: joinList(channels) }));
  out(t('setup.envPriority'));
  const overrides = [data.telegram.token_env ?? 'TELEGRAM_BOT_TOKEN', data.feishu.webhook_env ?? 'FEISHU_WEBHOOK',
    data.feishu.secret_env ?? 'FEISHU_SECRET', 'TELEGRAM_CHAT_ID', 'TELEGRAM_CHAT_IDS'].filter(name => Object.hasOwn(env, name));
  if (overrides.length) out(t('setup.envOverrides', { names: joinList(overrides) }));
  if (reference?.backend === 'keyring') out(t('setup.oldDeleteWarning'));
  out(t('setup.disabledChannels'));
  for (const line of options.notes ?? []) out(line);
  const actions = [t('setup.actionSave')];
  if (options.testSend) actions.push(t('setup.actionTest'));
  if (options.afterSave) actions.push(t('setup.actionHooks'));
  if (!defaultYes(await prompts.text(t('setup.continue', { actions: joinList(actions) })))) return false;
  await commitConfig(file, data, before, store, values, { warn: out });
  out(t('setup.saved'));
  if (options.testSend) {
    try {
      const effective = parseConfig(preview, env, () => values);
      const ok = await options.testSend(effective);
      out(ok ? t('setup.testSuccess') : t('setup.testFailed'));
    } catch { out(t('setup.testFailedEnv')); }
  } else out(t('setup.testSkipped'));
  if (options.afterSave) {
    try { await options.afterSave(); }
    catch (error) {
      out(t('setup.hooksFailed', { reason: error instanceof ConfigError ? error.message : t('setup.hooksCheckHint') }));
    }
  }
  try {
    if (ready(parseConfig(preview, env, () => values), 'telegram')) {
      out(t('setup.replyHint'));
    }
  } catch { /* 环境覆盖无效时上方测试分支已报告。 */ }
  return true;
}
export async function setConfigLanguage(file: string, language: Locale, warn?: (text: string) => void): Promise<boolean> {
  const before = await snapshot(file);
  if (before === null) throw new ConfigError(t('config.languageNoConfig', { file, language }));
  const data = readRaw(before);
  if ((data.language ?? 'zh') === language) return false;
  data.language = language;
  await commitConfig(file, data, before, { read: () => null, create: () => {}, remove: () => {} }, null,
    { keepCredentials: true, warn });
  return true;
}
export async function clearCredentials(file: string, prompts: Prompts, store?: Store): Promise<boolean> {
  const before = await snapshot(file), data = readRaw(before);
  const reference = data.credentials as Reference | undefined;
  if (!reference) { prompts.out(t('setup.clearNoReference')); return true; }
  if (reference.backend !== 'keyring') throw new ConfigError(t('setup.clearOldBackend'));
  prompts.out(t('setup.clearWarning'));
  if (!yes(await prompts.text(t('setup.clearConfirm')))) return false;
  await commitConfig(file, data, before, store ?? nativeStore(), null, { warn: prompts.out });
  prompts.out(t('setup.cleared'));
  return true;
}
