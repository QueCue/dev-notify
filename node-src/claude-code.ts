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
}
const record = (value: unknown): value is Settings => value !== null && typeof value === 'object' && !Array.isArray(value);
const yes = (value: string) => /^(y|yes)$/i.test(value.trim());
export function claudeSettingsPath(env: Env = process.env, home = homedir(), platform = process.platform): string {
  const join = platform === 'win32' ? path.win32 : path.posix;
  const root = env.CLAUDE_CONFIG_DIR || join.join(home, '.claude');
  if (!join.isAbsolute(root)) throw new ConfigError('CLAUDE_CONFIG_DIR 必须是绝对路径，未修改 Claude Code 设置');
  return join.join(root, 'settings.json');
}
function settingsFile(options: IntegrationOptions): string {
  return claudeSettingsPath(options.env, options.home, options.platform);
}
async function snapshot(file: string): Promise<Buffer | null> {
  try {
    const bytes = await readFile(file);
    if (bytes.length > 1024 * 1024) throw new ConfigError('Claude Code 设置超过 1 MiB，未修改');
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof ConfigError) throw error;
    throw new ConfigError('无法读取 Claude Code 设置，未修改');
  }
}
function parseSettings(before: Buffer | null): Settings {
  let data: unknown;
  try { data = before === null ? {} : JSON.parse(decodeUtf8(before)); }
  catch { throw new ConfigError('Claude Code 设置不是合法 UTF-8 JSON，未覆盖'); }
  if (!record(data) || (data.hooks !== undefined && !record(data.hooks))) throw new ConfigError('Claude Code 设置或 hooks 结构无效，未覆盖');
  for (const event of EVENTS) {
    const groups = data.hooks?.[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups) || groups.some(group => !record(group) || !Array.isArray(group.hooks)
      || group.hooks.some((hook: unknown) => !record(hook)))) throw new ConfigError('Claude Code hook 数组结构无效，未覆盖');
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
  const result = { file, stop: 0, notification: 0, lifecycle: 0, interaction: 0, others: 0, disabled: data.disableAllHooks === true };
  for (const event of EVENTS) for (const group of data.hooks?.[event] ?? []) for (const hook of group.hooks) {
    if (owned(hook)) {
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
        ...(event === 'Notification' ? { async: true } : { timeout: event === 'PermissionRequest' ? 360 : event === 'PreToolUse' ? 10 : 120 }), statusMessage: HOOK_MARKER };
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
  catch { throw new ConfigError('Claude Code 设置写入锁不可用；确认没有安装进程后才能处理残留 .dev-notify.lock'); }
  const temporary = path.join(path.dirname(file), `.dev-notify-${randomBytes(16).toString('hex')}.tmp`);
  let created = false;
  try {
    await lock.close();
    if (!same(before, await snapshot(file))) throw new ConfigError('Claude Code 设置在确认期间已变化，未覆盖，请重试');
    const stream = await open(temporary, 'wx', 0o600); created = true;
    try { await stream.writeFile(JSON.stringify(target, null, 2) + '\n', 'utf8'); await stream.sync(); }
    finally { await stream.close(); }
    if (!same(before, await snapshot(file))) throw new ConfigError('Claude Code 设置在保存期间已变化，未覆盖，请重试');
    await replace(temporary, file);
  } finally {
    if (created) { try { await remove(temporary); } catch { prompts.out('临时 Claude Code 设置清理失败，请确认安装结束后清理 .dev-notify-*.tmp'); } }
    try { await remove(lockFile); } catch { prompts.out('Claude Code 设置锁清理失败，请确认安装结束后处理 .dev-notify.lock'); }
  }
}
export async function configureClaudeCode(config: string, action: 'install' | 'remove', prompts: Prompts,
  options: IntegrationOptions = {}): Promise<boolean> {
  const file = settingsFile(options), before = await snapshot(file), data = parseSettings(before);
  const status = describe(file, data);
  if (action === 'remove' && status.stop + status.notification + status.lifecycle + status.interaction === 0) {
    prompts.out(`Claude Code 用户级设置：${file}`);
    prompts.out('没有本工具标记的 hooks，未修改。');
    return true;
  }
  const runtime = options.runtime ?? { node: process.execPath, cli: fileURLToPath(new URL('./cli.js', import.meta.url)) };
  const target = merged(data, action === 'install' ? path.resolve(config) : null, runtime);
  // setup 快速路径已在汇总确认前展示路径和发送范围，避免保存后重复整段说明。
  const quiet = options.confirm === false;
  if (!quiet) prompts.out(`Claude Code 用户级设置：${file}`);
  if (JSON.stringify(data) === JSON.stringify(target)) {
    prompts.out(action === 'install' ? '本工具 hooks 已安装且配置一致，未重复添加。' : '没有本工具标记的 hooks，未修改。');
    return true;
  }
  if (action === 'install') {
    if (!quiet) {
      prompts.out(`通知配置：${path.resolve(config)}`);
      prompts.out('将为该 Claude Code 配置目录下的所有项目启用：最终回复通知，以及权限等待等需要输入的通知。');
      prompts.out('最终回复和通知正文可能包含敏感内容，将发送到上述配置实际生效的 Telegram / 飞书目标；环境变量仍可覆盖。');
      prompts.out('同时安装会话生命周期和结构化问题 hooks；未独立运行 reply setup 授权时不接收远程输入、不启动桥接。');
      prompts.out('不读取整份会话记录；启用回复后读取会话进程元数据，结构化问题/权限请求会发送相应问题或工具输入。');
      prompts.out('PreToolUse 只登记身份；PermissionRequest 与普通交互终端原生窗口并行等待，远程 5 分钟有效。安装完成事件用于结果反馈，不默认作答。当前已核对 Claude Code 2.1.316 实现；旧版和特殊宿主需另行验收。');
    }
    if (status.others) prompts.out(`保留当前文件中另外 ${status.others} 个相关处理器；可能出现重复通知。`);
    prompts.out('项目级或插件 hooks 也可能同时生效；不会自动迁移或删除原 Python hooks。');
    if (status.disabled) prompts.out('注意：该文件设置了 disableAllHooks，安装后仍不会生效；本工具不擅自解除禁用。');
  } else if (!quiet) prompts.out('只移除本工具标记的通知、生命周期和交互处理器；保留其他设置、hooks、通知配置和系统凭据。如需停止回复桥接，请运行 reply disable / stop。');
  if (options.confirm !== false
    && !yes(await prompts.text(action === 'install' ? '确认合并安装 Claude Code 通知 hooks？[y/N] ' : '确认移除本工具的 Claude Code hooks？[y/N] '))) {
    prompts.out('已取消，Claude Code 设置未修改。'); return false;
  }
  await commit(file, before, target, prompts, options.replace);
  prompts.out(action === 'install' ? 'Claude Code hooks 已写入。请在 /hooks 中检查并按界面确认；未生效时重启会话。'
    : '本工具的 Claude Code hooks 已移除；请在 /hooks 中检查或重启会话。');
  return true;
}
