import { readFile, mkdir, open, rename, unlink, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ConfigError, decodeUtf8, type Env } from './config.js';
import { t } from './i18n.js';
import type { Prompts } from './prompts.js';

export const HOOK_MARKER = 'dev-notify:claude-code:v1';
// 同步 hook 未提供官方无限等待配置；24 天仍低于 32 位毫秒定时器上限，避免超大值溢出。
export const PERMISSION_HOOK_TIMEOUT_SECONDS = 24 * 24 * 60 * 60;
export const NOTIFICATION_MATCHER = 'permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input';
export const EVENTS = ['Stop', 'Notification', 'SessionStart', 'UserPromptSubmit', 'SessionEnd', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'] as const;
type Settings = Record<string, any>;
export interface HookRuntime { node: string; cli: string }
export interface IntegrationOptions {
  env?: Env;
  home?: string;
  platform?: NodeJS.Platform;
  runtime?: HookRuntime;
  replace?: typeof rename;
  lockOpen?: typeof open;
  runtimeAccess?: (file: string, mode: number) => Promise<void>;
  /** setup 快速路径已在汇总确认中覆盖 hooks 安装，不再重复询问。 */
  confirm?: boolean;
}
export interface IntegrationStatus {
  file: string;
  stop: number;
  notification: number;
  lifecycle: number;
  interaction: number;
  others: number;
  disabled: boolean;
  /** 本工具 hooks 绑定的通知配置路径（去重）。 */
  configs: string[];
  runtimeIssues: { event: string; kind: 'node' | 'cli'; reason: 'missing' | 'denied' | 'invalid' | 'unavailable' }[];
}
const record = (value: unknown): value is Settings => value !== null && typeof value === 'object' && !Array.isArray(value);
const yes = (value: string) => /^(y|yes)$/i.test(value.trim());
export function claudeSettingsPath(env: Env = process.env, home = homedir(), platform = process.platform): string {
  const join = platform === 'win32' ? path.win32 : path.posix;
  const root = env.CLAUDE_CONFIG_DIR || join.join(home, '.claude');
  if (!join.isAbsolute(root)) throw new ConfigError(t('claude.settingsAbsolute'));
  return join.join(root, 'settings.json');
}
function settingsFile(options: IntegrationOptions): string {
  return claudeSettingsPath(options.env, options.home, options.platform);
}
async function snapshot(file: string): Promise<Buffer | null> {
  try {
    const bytes = await readFile(file);
    if (bytes.length > 1024 * 1024) throw new ConfigError(t('claude.settingsTooLarge'));
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(t('claude.settingsReadFailed'));
  }
}
function parseSettings(before: Buffer | null): Settings {
  let data: unknown;
  try { data = before === null ? {} : JSON.parse(decodeUtf8(before)); }
  catch { throw new ConfigError(t('claude.settingsInvalidJson')); }
  if (!record(data) || (data.hooks !== undefined && !record(data.hooks))) throw new ConfigError(t('claude.settingsInvalidShape'));
  for (const event of EVENTS) {
    const groups = data.hooks?.[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups) || groups.some(group => !record(group) || !Array.isArray(group.hooks)
      || group.hooks.some((hook: unknown) => !record(hook)))) throw new ConfigError(t('claude.hooksInvalidShape'));
  }
  return data;
}
function owned(hook: Settings): boolean {
  return hook.type === 'command' && hook.statusMessage === HOOK_MARKER && Array.isArray(hook.args)
    && hook.args.length === 6 && typeof hook.args[0] === 'string'
    && hook.args[1] === 'integration' && hook.args[2] === 'claude-code' && hook.args[3] === 'hook'
    && hook.args[4] === '--config' && typeof hook.args[5] === 'string';
}
function describe(file: string, data: Settings): IntegrationStatus {
  const result = { file, stop: 0, notification: 0, lifecycle: 0, interaction: 0, others: 0, disabled: data.disableAllHooks === true,
    configs: [] as string[], runtimeIssues: [] as IntegrationStatus['runtimeIssues'] };
  for (const event of EVENTS) for (const group of data.hooks?.[event] ?? []) for (const hook of group.hooks) {
    if (owned(hook)) {
      if (!result.configs.includes(hook.args[5])) result.configs.push(hook.args[5]);
      if (event === 'Stop') result.stop++;
      else if (event === 'Notification') result.notification++;
      else if (['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PermissionDenied'].includes(event)) result.interaction++;
      else result.lifecycle++;
    }
    else result.others++;
  }
  return result;
}
async function runtimeIssues(data: Settings, options: IntegrationOptions, config?: string): Promise<IntegrationStatus['runtimeIssues']> {
  const issues: IntegrationStatus['runtimeIssues'] = [], checked = new Map<string, IntegrationStatus['runtimeIssues'][number]['reason'] | null>();
  const platform = options.platform ?? process.platform, paths = platform === 'win32' ? path.win32 : path.posix;
  const normalize = (file: string) => platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  for (const event of EVENTS) for (const group of data.hooks?.[event] ?? []) for (const hook of group.hooks) {
    if (!owned(hook) || config !== undefined && normalize(hook.args[5]) !== normalize(config)) continue;
    for (const [kind, file] of [['node', hook.command], ['cli', hook.args[0]]] as const) {
      const key = JSON.stringify([kind, file]);
      if (!checked.has(key)) {
        let reason: IntegrationStatus['runtimeIssues'][number]['reason'] | null = null;
        if (typeof file !== 'string' || !paths.isAbsolute(file)) reason = 'invalid';
        else try {
          if (!(await stat(file)).isFile()) reason = 'invalid';
          else {
            await (options.runtimeAccess ?? access)(file, constants.R_OK | (kind === 'node' && platform !== 'win32' ? constants.X_OK : 0));
            // Windows access() 不足以验证 ACL；仅打开后关闭，不读取文件正文或执行程序。
            const handle = await open(file, 'r');
            await handle.close();
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          reason = code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : code === 'EACCES' || code === 'EPERM' ? 'denied' : 'unavailable';
        }
        checked.set(key, reason);
      }
      const reason = checked.get(key);
      if (reason) issues.push({ event, kind, reason });
    }
  }
  return issues;
}
export async function claudeCodeStatus(options: IntegrationOptions = {}): Promise<IntegrationStatus> {
  const file = settingsFile(options), data = parseSettings(await snapshot(file));
  return { ...describe(file, data), runtimeIssues: await runtimeIssues(data, options) };
}
export async function replyHooksReady(config: string, options: IntegrationOptions = {}): Promise<boolean> {
  const data = parseSettings(await snapshot(settingsFile(options)));
  if (data.disableAllHooks === true) return false;
  const normalize = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  for (const event of EVENTS) {
    const groups = data.hooks?.[event] ?? [];
    const matches = groups.flatMap((group: Settings) => group.hooks)
      .filter((hook: Settings) => owned(hook) && normalize(hook.args[5]) === normalize(config));
    if (matches.length !== 1 || (event !== 'Notification' && matches[0].async === true)) return false;
    if (event !== 'Notification' && groups.some((group: Settings) => group.matcher && group.matcher !== '*'
      && group.hooks.includes(matches[0]))) return false;
  }
  return (await runtimeIssues(data, options, config)).length === 0;
}
function merged(data: Settings, config: string | null, runtime: HookRuntime): Settings {
  const target = structuredClone(data);
  for (const event of EVENTS) {
    const groups: Settings[] = [];
    for (const group of target.hooks?.[event] ?? []) {
      const remaining = group.hooks.filter((hook: Settings) => !owned(hook));
      if (remaining.length === group.hooks.length) groups.push(group);
      else if (remaining.length) groups.push({ ...group, hooks: remaining });
    }
    if (config !== null) {
      const handler = { type: 'command', command: runtime.node,
        args: [runtime.cli, 'integration', 'claude-code', 'hook', '--config', config],
        ...(event === 'Notification' ? { async: true } : { timeout: event === 'PermissionRequest' ? PERMISSION_HOOK_TIMEOUT_SECONDS : event === 'PreToolUse' ? 10 : 120 }), statusMessage: HOOK_MARKER };
      const matcher = event === 'Notification' ? NOTIFICATION_MATCHER : null;
      groups.push(matcher ? { matcher, hooks: [handler] } : { hooks: [handler] });
    }
    if (groups.length) { target.hooks ??= {}; target.hooks[event] = groups; }
    else if (target.hooks) delete target.hooks[event];
  }
  if (target.hooks && !Object.keys(target.hooks).length) delete target.hooks;
  return target;
}
function same(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}
async function remove(file: string): Promise<void> {
  try { await unlink(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function commit(file: string, before: Buffer | null, target: Settings, prompts: Prompts, replace = rename, lockOpen = open): Promise<void> {
  try { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); }
  catch (error) { throw new ConfigError(t(['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'claude.settingsWriteDenied' : 'claude.lockFailed')); }
  const lockFile = file + '.dev-notify.lock';
  let lock;
  try { lock = await lockOpen(lockFile, 'wx', 0o600); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(t(code === 'EEXIST' ? 'claude.lockUnavailable' : code === 'EACCES' || code === 'EPERM' ? 'claude.settingsWriteDenied' : 'claude.lockFailed'));
  }
  const temporary = path.join(path.dirname(file), `.dev-notify-${randomBytes(16).toString('hex')}.tmp`);
  let created = false;
  try {
    await lock.close();
    if (!same(before, await snapshot(file))) throw new ConfigError(t('claude.changedDuringConfirm'));
    const stream = await open(temporary, 'wx', 0o600); created = true;
    try { await stream.writeFile(JSON.stringify(target, null, 2) + '\n', 'utf8'); await stream.sync(); }
    finally { await stream.close(); }
    if (!same(before, await snapshot(file))) throw new ConfigError(t('claude.changedDuringSave'));
    await replace(temporary, file);
  } finally {
    if (created) { try { await remove(temporary); } catch { prompts.out(t('claude.tempCleanupFailed')); } }
    try { await remove(lockFile); } catch { prompts.out(t('claude.lockCleanupFailed')); }
  }
}
export async function configureClaudeCode(config: string, action: 'install' | 'remove', prompts: Prompts,
  options: IntegrationOptions = {}): Promise<boolean> {
  const file = settingsFile(options), before = await snapshot(file), data = parseSettings(before);
  const status = describe(file, data);
  if (action === 'remove' && status.stop + status.notification + status.lifecycle + status.interaction === 0) {
    prompts.out(t('claude.settingsPath', { file }));
    prompts.out(t('claude.noHooks'));
    return true;
  }
  const runtime = options.runtime ?? { node: process.execPath, cli: fileURLToPath(new URL('./cli.js', import.meta.url)) };
  const target = merged(data, action === 'install' ? path.resolve(config) : null, runtime);
  // setup 快速路径已在汇总确认前展示路径和发送范围，避免保存后重复整段说明。
  const quiet = options.confirm === false;
  if (!quiet) prompts.out(t('claude.settingsPath', { file }));
  if (JSON.stringify(data) === JSON.stringify(target)) {
    prompts.out(action === 'install' ? t('claude.alreadyInstalled') : t('claude.noHooks'));
    return true;
  }
  if (action === 'install') {
    if (!quiet) {
      prompts.out(t('claude.configPath', { config: path.resolve(config) }));
      prompts.out(t('claude.installScope'));
      prompts.out(t('claude.installSensitive'));
      prompts.out(t('claude.installLifecycle'));
      prompts.out(t('claude.installReads'));
      prompts.out(t('claude.installTiming'));
    }
    if (status.others) prompts.out(t('claude.otherHandlers', { count: status.others }));
    prompts.out(t('claude.projectHooks'));
    if (status.disabled) prompts.out(t('claude.disabledWarning'));
  } else if (!quiet) prompts.out(t('claude.removeScope'));
  if (options.confirm !== false
    && !yes(await prompts.text(action === 'install' ? t('claude.confirmInstall') : t('claude.confirmRemove')))) {
    prompts.out(t('claude.cancelled')); return false;
  }
  await commit(file, before, target, prompts, options.replace, options.lockOpen);
  prompts.out(action === 'install' ? t('claude.installed') : t('claude.removed'));
  return true;
}
