import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveReference, type Bundle, type Reference } from './credentials.js';
import { getLocale, t, type Locale } from './i18n.js';

export type Env = Record<string, string | undefined>;
export class ConfigError extends Error {}
export interface Config {
  language: Locale;
  telegram: { enabled: boolean; token: string; chatIds: string[] };
  feishu: { enabled: boolean; webhook: string; secret: string };
}
export const example = {
  version: 1,
  language: 'zh' as Locale,
  telegram: { enabled: true, chat_ids: [], token_env: 'TELEGRAM_BOT_TOKEN' },
  feishu: { enabled: true, webhook_env: 'FEISHU_WEBHOOK', secret_env: 'FEISHU_SECRET' },
};
export function appPaths(platform = process.platform, env: Env = process.env, home?: string) {
  const join = platform === 'win32' ? path.win32 : path.posix;
  if (env.DEV_NOTIFY_HOME) {
    if (!join.isAbsolute(env.DEV_NOTIFY_HOME)) throw new ConfigError(t('config.homeAbsolute'));
    return { config: join.join(env.DEV_NOTIFY_HOME, 'config', 'config.json'), data: join.join(env.DEV_NOTIFY_HOME, 'data') };
  }
  home ??= homedir();
  if (platform === 'win32') return {
    config: join.join(env.APPDATA || join.join(home, 'AppData', 'Roaming'), 'DevNotify', 'config.json'),
    data: join.join(env.LOCALAPPDATA || join.join(home, 'AppData', 'Local'), 'DevNotify', 'data'),
  };
  if (platform === 'darwin') {
    const root = join.join(home, 'Library', 'Application Support', 'DevNotify');
    return { config: join.join(root, 'config', 'config.json'), data: join.join(root, 'data') };
  }
  return { config: join.join(env.XDG_CONFIG_HOME || join.join(home, '.config'), 'dev-notify', 'config.json'),
    data: join.join(env.XDG_STATE_HOME || join.join(home, '.local', 'state'), 'dev-notify') };
}
export function object(value: unknown, allowed: string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigError(t('config.objectRequired', { name }));
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new ConfigError(t('config.objectUnknown', { name }));
  return result;
}
function enabled(section: Record<string, unknown>): boolean {
  if (section.enabled === undefined) return true;
  if (typeof section.enabled !== 'boolean') throw new ConfigError(t('config.enabledBoolean'));
  return section.enabled;
}
function secret(section: Record<string, unknown>, field: string, fallback: string, env: Env, stored: () => string): string {
  const name = section[field] ?? fallback;
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ConfigError(t('config.credentialEnvName'));
  if (Object.hasOwn(env, name)) return (env[name] ?? '').trim();
  return enabled(section) ? stored().trim() : '';
}
export function parseConfig(input: unknown, env: Env = process.env,
  resolver: (reference: Reference) => Bundle = resolveReference): Config {
  const data = object(input, ['version', 'language', 'telegram', 'feishu', 'credentials'], t('config.rootName'));
  if ((data.version ?? 1) !== 1) throw new ConfigError(t('config.unsupportedVersion'));
  const language = data.language ?? 'zh';
  if (language !== 'zh' && language !== 'en') throw new ConfigError(t('config.invalidLanguage'));
  let reference: Reference | undefined;
  if (data.credentials !== undefined) {
    const value = object(data.credentials, ['backend', 'id'], 'credentials');
    if (!['system', 'keyring'].includes(String(value.backend)) || typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id)) throw new ConfigError(t('config.invalidReference'));
    reference = value as unknown as Reference;
  }
  let cached: Bundle | undefined;
  const stored = (field: keyof Bundle): string => {
    if (!reference) return '';
    cached ??= resolver(reference);
    return cached[field] ?? '';
  };
  const tg = object(data.telegram ?? {}, ['enabled', 'chat_ids', 'token_env'], 'telegram');
  const fs = object(data.feishu ?? {}, ['enabled', 'webhook_env', 'secret_env'], 'feishu');
  const tgEnabled = enabled(tg), fsEnabled = enabled(fs);
  let ids: unknown = tg.chat_ids ?? [];
  if (Object.hasOwn(env, 'TELEGRAM_CHAT_ID') || Object.hasOwn(env, 'TELEGRAM_CHAT_IDS')) {
    ids = `${env.TELEGRAM_CHAT_ID ?? ''},${env.TELEGRAM_CHAT_IDS ?? ''}`.split(',').map(v => v.trim()).filter(Boolean);
  }
  if (!Array.isArray(ids)) throw new ConfigError(t('config.chatIdsArray'));
  const chatIds = [...new Set(ids.map(value => {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) throw new ConfigError(t('config.chatIdNumeric'));
    const id = String(value).trim();
    if (!/^-?[1-9][0-9]*$/.test(id)) throw new ConfigError(t('config.chatIdNonZero'));
    return id;
  }))];
  const token = secret(tg, 'token_env', 'TELEGRAM_BOT_TOKEN', env, () => stored('telegram_token'));
  if (token && !/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new ConfigError(t('config.telegramToken'));
  const webhook = secret(fs, 'webhook_env', 'FEISHU_WEBHOOK', env, () => stored('feishu_webhook'));
  if (webhook) {
    let valid = false;
    try {
      const url = new URL(webhook);
      valid = url.protocol === 'https:' && url.host === 'open.feishu.cn' && !url.username && !url.password && !url.search && !url.hash && /^\/open-apis\/bot\/v2\/hook\/[^/]+$/.test(url.pathname);
    } catch { /* 不输出含秘密的 URL 异常。 */ }
    if (!valid) throw new ConfigError(t('config.feishuWebhook'));
  }
  return { language, telegram: { enabled: tgEnabled, token, chatIds }, feishu: { enabled: fsEnabled, webhook,
    secret: secret(fs, 'secret_env', 'FEISHU_SECRET', env, () => stored('feishu_secret')) } };
}
export function ready(config: Config, channel: 'telegram' | 'feishu'): boolean {
  return channel === 'telegram' ? config.telegram.enabled && !!config.telegram.token && !!config.telegram.chatIds.length
    : config.feishu.enabled && !!config.feishu.webhook;
}
export function decodeUtf8(data: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw new ConfigError(t('config.utf8')); }
}
export async function readConfigLanguage(file: string): Promise<Locale | undefined> {
  try {
    const data = JSON.parse(decodeUtf8(await readFile(file))) as Record<string, unknown> | null;
    return parseLocaleFromConfig(data?.language);
  } catch { return undefined; }
}
function parseLocaleFromConfig(value: unknown): Locale | undefined {
  return value === 'zh' || value === 'en' ? value : undefined;
}
export async function loadConfig(file: string, required = false, env: Env = process.env): Promise<Config> {
  let input: unknown = {};
  try { input = JSON.parse(decodeUtf8(await readFile(file))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return parseConfig({}, env);
    throw new ConfigError(t('config.unreadable'));
  }
  return parseConfig(input, env);
}
export async function createConfig(file: string, language: Locale = getLocale()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(file, JSON.stringify({ ...example, language }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ConfigError(t('config.exists'));
    throw new ConfigError(t('config.createFailed'));
  }
}
