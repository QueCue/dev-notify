#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appPaths, ConfigError, createConfig, decodeUtf8, loadConfig, ready, type Env } from './config.js';
import { deliver, makePlan, type Channel, type Message } from './channels.js';
import { wizard, clearCredentials } from './setup.js';
import { terminalPrompts, readText, Cancelled, type Prompts } from './prompts.js';
import { CredentialError, type Store } from './credentials.js';
import { claudeCodeStatus, claudeSettingsPath, configureClaudeCode } from './claude-code.js';
import { dispatchClaudeHook, readHookInput } from './claude-hook.js';
import { accessReplies, configureReplies, disableReplies } from './reply-state.js';
import { startBridge, stopBridge, bridgeStatus, runBridge } from './reply-bridge.js';
import type { ReplyHookOptions } from './reply-hooks.js';

const HELP = `dev-notify 0.1.0-alpha.3 — 跨平台开发任务通知

命令：
  send --title 标题 [--content 正文 | --content-file 文件 | --stdin]
       [--channel all|telegram|feishu] [--level info|success|warn|error]
       [--footer 辅助信息] [--dry-run]
  setup [--no-test] [--no-hooks]
                            配置渠道及系统凭据；默认同时发送测试并安装
                            Claude Code 通知 hooks，一次确认完成
  setup --template [--yes]   仅创建无密钥模板，不覆盖已有配置、不安装 hooks
  credentials clear         确认后移除当前 Node 凭据引用和条目
  paths                     显示配置路径，不写文件
  doctor / status           离线检查，不发消息
  integration list          列出可用集成
  integration claude-code install / status / remove
                            单独安装、查询或移除用户级 hooks
  reply setup               另行授权可信 Telegram 私聊用户
  reply start / status / stop
                            启动、查询或停止回复桥接
  reply disable             确认后撤销远程回复授权并请求停止桥接
  reply run                 前台运行桥接（排错用，不启用系统自启动）

全局选项：--config 路径、--help、--version
环境变量：TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID / TELEGRAM_CHAT_IDS、
          FEISHU_WEBHOOK、FEISHU_SECRET；显式存在时优先。详见 README。
系统凭据使用 Windows Credential Manager / macOS Keychain；不调用 Python，不写入明文密钥。`;
export interface Context {
  env: Env;
  out: (text: string) => void;
  err: (text: string) => void;
  stdin: () => Promise<Uint8Array>;
  hookStdin: () => Promise<Uint8Array>;
  confirm: () => Promise<boolean>;
  send: typeof deliver;
  prompts?: Prompts;
  store?: Store;
  reply?: ReplyHookOptions;
}
const defaults: Context = {
  env: process.env,
  out: text => console.log(text),
  err: text => console.error(text),
  stdin: async () => { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); },
  hookStdin: () => readHookInput(),
  confirm: async () => {
    if (!process.stdin.isTTY) throw new ConfigError('非交互环境请使用 setup --template --yes');
    return /^(y|yes)$/i.test(await readText('确认创建模板？[y/N] '));
  },
  send: deliver,
};
export async function main(argv = process.argv.slice(2), overrides: Partial<Context> = {}): Promise<number> {
  const context = { ...defaults, ...overrides };
  const isHook = argv[0] === 'integration' && argv[1] === 'claude-code' && argv[2] === 'hook';
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
        help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, config: { type: 'string' },
        title: { type: 'string' }, content: { type: 'string' }, 'content-file': { type: 'string' }, stdin: { type: 'boolean' },
        channel: { type: 'string' }, level: { type: 'string' }, footer: { type: 'string' }, 'dry-run': { type: 'boolean' },
        template: { type: 'boolean' }, yes: { type: 'boolean' },
        'no-test': { type: 'boolean' }, 'no-hooks': { type: 'boolean' },
      } });
    } catch { throw new ConfigError('参数无效，请使用 --help；不回显可能含秘密的参数'); }
    const { values, positionals } = parsed;
    if (values.help) { context.out(HELP); return 0; }
    if (values.version) { context.out('dev-notify 0.1.0-alpha.3'); return 0; }
    const [command, action, integrationAction] = positionals;
    const allowed: Record<string, string[]> = {
      send: ['title', 'content', 'content-file', 'stdin', 'channel', 'level', 'footer', 'dry-run'],
      setup: ['template', 'yes', 'no-test', 'no-hooks'], paths: [], doctor: [], status: [], integration: [], credentials: [], reply: [],
    };
    if (!command || !Object.hasOwn(allowed, command) || positionals.length > (command === 'integration' ? 3 : command === 'credentials' || command === 'reply' ? 2 : 1)
      || Object.keys(values).some(key => key !== 'config' && !allowed[command].includes(key))) throw new ConfigError('命令或选项组合无效，请使用 --help');
    const paths = appPaths(process.platform, context.env);
    const file = values.config ? path.resolve(values.config) : paths.config;
    if (command === 'paths') { context.out(JSON.stringify({ config: file, data: paths.data }, null, 2)); return 0; }
    if (command === 'integration') {
      if (action === 'list' && !integrationAction) {
        context.out('claude-code: 可选通知集成、Telegram 回复与结构化问题交互；通知 hooks 与 reply setup 输入授权分开，默认不开启远程输入。'); return 0;
      }
      if (action !== 'claude-code' || !['install', 'status', 'remove', 'hook'].includes(integrationAction)) throw new ConfigError('请使用 integration list 或 integration claude-code install / status / remove');
      if (integrationAction === 'hook') {
        await dispatchClaudeHook(await context.hookStdin(), file, { ...context, response: value => context.out(JSON.stringify(value)) });
        return 0;
      }
      if (integrationAction === 'status') {
        const status = await claudeCodeStatus({ env: context.env });
        context.out(`Claude Code 用户级设置：${status.file}`);
        context.out(`本工具 hooks：Stop ${status.stop} 个，Notification ${status.notification} 个，会话生命周期 ${status.lifecycle}/3 个，交互及结果确认 ${status.interaction}/5 个；其他处理器 ${status.others} 个。`);
        context.out(status.disabled ? '当前文件设置了 disableAllHooks；本工具不会解除禁用。'
          : '仅检查用户级文件；实际是否加载或受项目、托管策略限制，请在 Claude Code /hooks 中确认。');
        return status.stop === 1 && status.notification === 1 && status.lifecycle === 3 && status.interaction === 5 && !status.disabled ? 0 : 1;
      }
      const prompts = context.prompts ?? terminalPrompts();
      if (integrationAction === 'install') {
        const config = await loadConfig(file, true, context.env);
        if (!ready(config, 'telegram') && !ready(config, 'feishu')) throw new ConfigError('请先运行 setup 配置可用通知渠道，再安装 Claude Code hooks');
      }
      return await configureClaudeCode(file, integrationAction as 'install' | 'remove', prompts, { env: context.env }) ? 0 : 130;
    }
    if (command === 'reply') {
      if (!['setup', 'start', 'status', 'stop', 'disable', 'run'].includes(action)) throw new ConfigError('请使用 reply setup / start / status / stop / disable / run');
      if (action === 'setup') {
        const saved = await configureReplies(file, context.prompts ?? terminalPrompts(), context.env);
        if (saved) context.out('授权已保存；请确认已安装本版 hooks，再运行 reply start。新授权不会恢复旧消息映射。');
        return saved ? 0 : 130;
      }
      if (action === 'disable') {
        if (!await disableReplies(file, context.prompts ?? terminalPrompts())) return 130;
        const stopped = await stopBridge(file);
        context.out(stopped ? '桥接已停止或未运行。' : '已撤销授权并请求停止；正在进行中的调用不能撤回。');
        return 0;
      }
      if (action === 'stop') {
        const stopped = await stopBridge(file);
        context.out(stopped ? '桥接已停止或未运行；授权仍保留，下一次事件可再次启动。彻底关闭请用 reply disable。'
          : '停止请求已登记；桥接尚未退出，未强杀进程，请用 reply status 检查。');
        return stopped ? 0 : 1;
      }
      if (action === 'status') {
        const access = await accessReplies(file, context.env), status = await bridgeStatus(file);
        context.out(access ? `远程回复：已另行授权 ${access.policy.users.length} 个私聊用户；逐次工具权限${access.policy.permissions ? '已启用' : '未启用'}。` : '远程回复：未启用。');
        context.out(status.ready ? '桥接：已就绪。' : status.running ? '桥接：进程存在但未就绪。' : '桥接：未运行。');
        if (status.error) context.err(status.error);
        return access && status.ready ? 0 : 1;
      }
      if (action === 'run') { await runBridge(file, { env: context.env, log: context.err }); return 0; }
      const ready = await startBridge(file, context.env);
      context.out(ready ? '回复桥接已就绪；请从新任务通知进入。' : '桥接尚未就绪；请用 reply status / reply run 查看安全错误，不要同时运行旧 Python 桥接。');
      return ready ? 0 : 1;
    }
    if (command === 'credentials') {
      if (action !== 'clear') throw new ConfigError('当前只支持 credentials clear，且必须交互确认');
      return await clearCredentials(file, context.prompts ?? terminalPrompts()) ? 0 : 130;
    }
    if (command === 'setup') {
      if (!values.template) {
        if (values.yes) throw new ConfigError('--yes 只允许与 --template 同时使用，不能跳过密钥保存确认');
        const prompts = context.prompts ?? terminalPrompts();
        const notes: string[] = [];
        const test = !values['no-test'];
        if (test) notes.push('保存后将发送固定内容的测试通知到最终生效的接收目标。');
        let hooks = !values['no-hooks'];
        if (hooks) {
          try {
            notes.push(`Claude Code 用户级设置：${claudeSettingsPath(context.env)}`);
            notes.push('将为该设置文件对应的所有项目安装通知 hooks；最终回复正文可能含敏感内容，将发送到配置实际生效的渠道。');
            notes.push('同时安装会话生命周期和结构化问题 hooks；未运行 reply setup 授权时不接收远程输入。');
          } catch (error) {
            hooks = false;
            context.out(error instanceof ConfigError ? `跳过 Claude Code hooks：${error.message}` : '跳过 Claude Code hooks：无法确定用户级设置路径');
          }
        }
        let integrationFailed = false;
        const saved = await wizard(file, {
          prompts, store: context.store, env: context.env, notes,
          testSend: test ? async config => {
            let count = 0, ok = true;
            for (const channel of ['telegram', 'feishu'] as Channel[]) {
              if (!ready(config, channel)) continue;
              count++;
              const plan = makePlan(channel, { title: 'dev-notify 配置测试', content: '这是一条由你确认发送的测试通知。', footer: '', level: 'info' }, config);
              const result = await context.send(plan, config);
              context.out(`${channel}: 测试已发送 ${result.sent}/${result.planned}`);
              ok = ok && result.ok;
            }
            return count > 0 && ok;
          } : undefined,
          afterSave: hooks ? async () => {
            try { await configureClaudeCode(file, 'install', prompts, { env: context.env, confirm: false }); }
            catch (error) { integrationFailed = true; throw error; }
          } : undefined,
        });
        if (!saved) return 130;
        return integrationFailed ? 1 : 0;
      }
      context.out(`将创建无密钥模板: ${file}；不会联网或修改 hooks`);
      if (!values.yes && !await context.confirm()) { context.out('已取消，未写入'); return 130; }
      await createConfig(file); context.out('已创建模板；请配置环境凭据和接收人'); return 0;
    }
    const config = await loadConfig(file, values.config !== undefined, context.env);
    if (command === 'doctor' || command === 'status') {
      context.out(`配置路径: ${file}`);
      for (const channel of ['telegram', 'feishu'] as Channel[]) context.out(`${channel}: ${ready(config, channel) ? '配置齐全，网络未验证' : '未启用或配置不完整'}`);
      context.out('凭据: 环境变量优先，其次 Windows Credential Manager / macOS Keychain；检查不联网，系统可能要求授权');
      return ready(config, 'telegram') || ready(config, 'feishu') ? 0 : 1;
    }
    if (!values.title?.trim()) throw new ConfigError('send 必须指定非空 --title');
    if ([values.content !== undefined, values['content-file'] !== undefined, !!values.stdin].filter(Boolean).length > 1) throw new ConfigError('正文来源只能指定一个');
    const level = values.level ?? 'info';
    const channel = values.channel ?? 'all';
    if (!['info', 'success', 'warn', 'error'].includes(level) || !['all', 'telegram', 'feishu'].includes(channel)) throw new ConfigError('渠道或通知级别无效');
    let content = values.content ?? values.title;
    if (values['content-file'] !== undefined) content = decodeUtf8(await readFile(values['content-file']));
    if (values.stdin) content = decodeUtf8(await context.stdin());
    const message: Message = { title: values.title, content, footer: values.footer ?? '', level: level as Message['level'] };
    const selected: Channel[] = channel === 'all' ? ['telegram', 'feishu'] : [channel as Channel];
    let failed = false, planned = 0;
    for (const name of selected) {
      if (!ready(config, name)) {
        if (channel !== 'all') throw new ConfigError('指定渠道未启用或配置不完整');
        continue;
      }
      planned++;
      let plan;
      try { plan = makePlan(name, message, config); }
      catch { context.err(`${name}: 无法生成安全分段，请缩短标题/辅助信息或检查正文格式`); failed = true; continue; }
      if (values['dry-run']) { context.out(`${name}: 接收目标 ${plan.recipients}，预计请求 ${plan.items.length}；未发送`); continue; }
      const result = await context.send(plan, config);
      context.out(`${name}: 已发送 ${result.sent}/${result.planned}`);
      if (!result.ok) { failed = true; context.err(result.error ?? '投递失败'); }
    }
    if (!planned) throw new ConfigError('没有可发送的渠道，请配置环境凭据和接收人');
    return failed ? 1 : 0;
  } catch (error) {
    if (error instanceof Cancelled) { context.out('已取消，未继续执行。'); return isHook ? 0 : 130; }
    context.err(error instanceof ConfigError || error instanceof CredentialError ? error.message : '操作失败，请检查文件、权限或输入；不输出可能含秘密的底层异常');
    // Stop hook 的退出码 2 会要求 Claude 继续；通知失败只能报告，不能阻塞或触发重试循环。
    return isHook ? 0 : 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main();
}
