import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ConfigError, decodeUtf8, type Env } from './config.js';
import type { Prompts } from './prompts.js';

export const HOOK_MARKER = 'dev-notify:claude-code:v1';
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
}
const record = (value: unknown): value is Settings => value !== null && typeof value === 'object' && !Array.isArray(value);
const yes = (value: string) => /^(y|yes)$/i.test(value.trim());
export function claudeSettingsPath(env: Env = process.env, home = homedir(), platform = process.platform): string {
  const join = platform === 'win32' ? path.win32 : path.posix;
  const root = env.CLAUDE_CONFIG_DIR || join.join(home, '.claude');
  if (!join.isAbsolute(root)) throw new ConfigError('CLAUDE_CONFIG_DIR 需要是绝对路径，Claude Code 设置没有改动');
  return join.join(root, 'settings.json');
}
function settingsFile(options: IntegrationOptions): string {
  return claudeSettingsPath(options.env, options.home, options.platform);
}
async function snapshot(file: string): Promise<Buffer | null> {
  try {
    const bytes = await readFile(file);
    if (bytes.length > 1024 * 1024) throw new ConfigError('Claude Code 设置超过 1 MiB，操作已停止，文件没有改动。');
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('无法读取 Claude Code 设置，操作已停止。');
  }
}
function parseSettings(before: Buffer | null): Settings {
  let data: unknown;
  try { data = before === null ? {} : JSON.parse(decodeUtf8(before)); }
  catch { throw new ConfigError('Claude Code 设置不是合法的 UTF-8 JSON，没有覆盖。'); }
  if (!record(data) || (data.hooks !== undefined && !record(data.hooks))) throw new ConfigError('Claude Code 设置或 hooks 结构无效，没有覆盖。');
  for (const event of EVENTS) {
    const groups = data.hooks?.[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups) || groups.some(group => !record(group) || !Array.isArray(group.hooks)
      || group.hooks.some((hook: unknown) => !record(hook)))) throw new ConfigError('Claude Code hook 数组结构无效，没有覆盖。');
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
  const result = { file, stop: 0, notification: 0, lifecycle: 0, interaction: 0, others: 0, disabled: data.disableAllHooks === true, configs: [] as string[] };
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
export async function claudeCodeStatus(options: IntegrationOptions = {}): Promise<IntegrationStatus> {
  const file = settingsFile(options);
  return describe(file, parseSettings(await snapshot(file)));
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
  return true;
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
        ...(event === 'Notification' ? { async: true } : { timeout: event === 'PermissionRequest' ? 720 : event === 'PreToolUse' ? 10 : 120 }), statusMessage: HOOK_MARKER };
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
async function commit(file: string, before: Buffer | null, target: Settings, prompts: Prompts, replace = rename): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockFile = file + '.dev-notify.lock';
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch { throw new ConfigError('暂时无法获取 Claude Code 设置写入锁。请确认没有安装进程在运行，再处理残留的 .dev-notify.lock。'); }
  const temporary = path.join(path.dirname(file), `.dev-notify-${randomBytes(16).toString('hex')}.tmp`);
  let created = false;
  try {
    await lock.close();
    if (!same(before, await snapshot(file))) throw new ConfigError('Claude Code 设置在确认期间发生了变化，没有覆盖，请重试。');
    const stream = await open(temporary, 'wx', 0o600); created = true;
    try { await stream.writeFile(JSON.stringify(target, null, 2) + '\n', 'utf8'); await stream.sync(); }
    finally { await stream.close(); }
    if (!same(before, await snapshot(file))) throw new ConfigError('Claude Code 设置在保存期间发生了变化，没有覆盖，请重试。');
    await replace(temporary, file);
  } finally {
    if (created) { try { await remove(temporary); } catch { prompts.out('临时文件清理失败。安装结束后请删除 .dev-notify-*.tmp。'); } }
    try { await remove(lockFile); } catch { prompts.out('锁文件清理失败。安装结束后请删除 .dev-notify.lock。'); }
  }
}
export async function configureClaudeCode(config: string, action: 'install' | 'remove', prompts: Prompts,
  options: IntegrationOptions = {}): Promise<boolean> {
  const file = settingsFile(options), before = await snapshot(file), data = parseSettings(before);
  const status = describe(file, data);
  if (action === 'remove' && status.stop + status.notification + status.lifecycle + status.interaction === 0) {
    prompts.out(`Claude Code 用户级设置：${file}`);
    prompts.out('没有找到本工具添加的 hooks，设置没有改动。');
    return true;
  }
  const runtime = options.runtime ?? { node: process.execPath, cli: fileURLToPath(new URL('./cli.js', import.meta.url)) };
  const target = merged(data, action === 'install' ? path.resolve(config) : null, runtime);
  // setup 快速路径已在汇总确认前展示路径和发送范围，避免保存后重复整段说明。
  const quiet = options.confirm === false;
  if (!quiet) prompts.out(`Claude Code 用户级设置：${file}`);
  if (JSON.stringify(data) === JSON.stringify(target)) {
    prompts.out(action === 'install' ? '本工具 hooks 已经安装，配置一致，无需重复添加。' : '没有找到本工具添加的 hooks，设置没有改动。');
    return true;
  }
  if (action === 'install') {
    if (!quiet) {
      prompts.out(`通知配置：${path.resolve(config)}`);
      prompts.out('会为这个 Claude Code 配置目录下的所有项目启用通知：任务结束时发送最终回复，需要你确认或输入时也会提醒。');
      prompts.out('最终回复和提醒正文可能包含敏感内容，会发送到配置实际生效的 Telegram / 飞书。环境变量仍然优先。');
      prompts.out('同时安装会话生命周期和结构化问题 hooks。远程输入需要另行运行 reply setup 授权。');
      prompts.out('不会读取整份会话记录。启用回复后，会读取会话的进程元数据；结构化问题或权限请求会发送对应的问题和工具信息。');
      prompts.out('PreToolUse 只登记调用身份；PermissionRequest 会和本机终端窗口同时等待，远程回答的有效期是 10 分钟。安装完成事件只用于反馈结果，不会代替你作答。已核对 Claude Code 2.1.316；其他版本或宿主环境需要另行验证。');
    }
    if (status.others) prompts.out(`当前文件里还有 ${status.others} 个其他相关处理器，可能会重复通知。`);
    prompts.out('项目级或插件的 hooks 也可能同时生效；本工具不会自动迁移或删除旧版 hooks。');
    if (status.disabled) prompts.out('注意：该文件启用了 disableAllHooks，安装后 hooks 也不会生效；请自行解除禁用。');
  } else if (!quiet) prompts.out('只会移除本工具添加的通知、生命周期和交互处理器；其他设置、hooks、通知配置和系统凭据都会保留。如需停止回复桥接，请运行 reply disable 或 reply stop。');
  if (options.confirm !== false
    && !yes(await prompts.text(action === 'install' ? '安装这些 Claude Code hooks？[y/N] ' : '移除本工具的 Claude Code hooks？[y/N] '))) {
    prompts.out('已取消，Claude Code 设置没有改动。'); return false;
  }
  await commit(file, before, target, prompts, options.replace);
  prompts.out(action === 'install' ? 'Claude Code hooks 已安装。请在 /hooks 中检查并按界面确认；如果没有生效，请重启会话。'
    : '本工具的 Claude Code hooks 已移除。请在 /hooks 中检查，必要时重启会话。');
  return true;
}
