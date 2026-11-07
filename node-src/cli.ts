#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { appPaths, ConfigError, createConfig, decodeUtf8, loadConfig, readConfigLanguage, ready, type Env } from './config.js';
import { deliver, makePlan, type Channel, type Message } from './channels.js';
import { wizard, clearCredentials, setConfigLanguage } from './setup.js';
import { terminalPrompts, readText, Cancelled, type Prompts } from './prompts.js';
import { CredentialError, type Store } from './credentials.js';
import { claudeCodeStatus, claudeSettingsPath, configureClaudeCode } from './claude-code.js';
import { dispatchClaudeHook, readHookInput } from './claude-hook.js';
import { accessReplies, configureReplies, disableReplies } from './reply-state.js';
import { startBridge, stopBridge, bridgeStatus, runBridge } from './reply-bridge.js';
import type { ReplyHookOptions } from './reply-hooks.js';
import { updatePackage } from './update.js';
import { postUpdate } from './maintenance.js';
import { joinList, localeName, parseLocale, resolveLocale, setLocale, t, type Locale } from './i18n.js';

export const VERSION = '0.2.3';
const helpText = () => t('cli.help', { version: VERSION });
function rawLang(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang') return argv[i + 1];
    if (argv[i].startsWith('--lang=')) return argv[i].slice('--lang='.length);
  }
  return undefined;
}
function envLanguage(env: Env): string | undefined {
  return typeof env.DEV_NOTIFY_LANG === 'string' && env.DEV_NOTIFY_LANG !== '' ? env.DEV_NOTIFY_LANG : undefined;
}
async function configuredLanguage(file: string | undefined, env: Env): Promise<Locale | undefined> {
  try { return await readConfigLanguage(file ?? appPaths(process.platform, env).config); }
  catch { return undefined; }
}
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
    if (!process.stdin.isTTY) throw new ConfigError(t('cli.nonInteractive'));
    return /^(y|yes)$/i.test(await readText(t('cli.confirmTemplate')));
  },
  send: deliver,
};
export async function main(argv = process.argv.slice(2), overrides: Partial<Context> = {}): Promise<number> {
  const context = { ...defaults, ...overrides };
  setLocale(parseLocale(rawLang(argv)) ?? parseLocale(envLanguage(context.env)) ?? 'zh');
  const isHook = argv[0] === 'integration' && argv[1] === 'claude-code' && argv[2] === 'hook';
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
        help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, config: { type: 'string' }, lang: { type: 'string' },
        title: { type: 'string' }, content: { type: 'string' }, 'content-file': { type: 'string' }, stdin: { type: 'boolean' },
        channel: { type: 'string' }, level: { type: 'string' }, footer: { type: 'string' }, 'dry-run': { type: 'boolean' },
        template: { type: 'boolean' }, yes: { type: 'boolean' },
        'no-test': { type: 'boolean' }, 'no-hooks': { type: 'boolean' }, check: { type: 'boolean' }, 'no-post': { type: 'boolean' },
      } });
    } catch { throw new ConfigError(t('cli.invalidArgs')); }
    const { values, positionals } = parsed;
    if (values.lang !== undefined && values.lang !== '' && !parseLocale(values.lang)) throw new ConfigError(t('cli.invalidLanguage', { value: values.lang }));
    if (values.lang === undefined && envLanguage(context.env) !== undefined && !parseLocale(envLanguage(context.env))) {
      throw new ConfigError(t('cli.invalidLanguage', { value: envLanguage(context.env)! }));
    }
    if (values.help) {
      if (values.lang === undefined && envLanguage(context.env) === undefined) {
        const configured = await configuredLanguage(values.config ? path.resolve(values.config) : undefined, context.env);
        if (configured) setLocale(configured);
      }
      context.out(helpText()); return 0;
    }
    if (values.version) { context.out(`dev-notify ${VERSION}`); return 0; }
    const [command, action, integrationAction] = positionals;
    const allowed: Record<string, string[]> = {
      send: ['title', 'content', 'content-file', 'stdin', 'channel', 'level', 'footer', 'dry-run'],
      setup: ['template', 'yes', 'no-test', 'no-hooks'], paths: [], doctor: [], status: [], integration: ['yes'], credentials: [], reply: [], update: ['check', 'yes', 'no-post'], language: [],
    };
    const maxPositionals = command === 'integration' ? 3 : command === 'credentials' || command === 'reply' || command === 'language' ? 2 : 1;
    if (!command || !Object.hasOwn(allowed, command) || positionals.length > maxPositionals
      || Object.keys(values).some(key => key !== 'config' && key !== 'lang' && !allowed[command].includes(key))) throw new ConfigError(t('cli.invalidCommand'));
    const paths = appPaths(process.platform, context.env);
    const file = values.config ? path.resolve(values.config) : paths.config;
    setLocale(resolveLocale(values.lang, context.env, await readConfigLanguage(file)));
    if (command === 'language') {
      const requested = positionals[1];
      if (requested !== undefined) {
        const target = parseLocale(requested);
        if (!target) throw new ConfigError(t('cli.invalidLanguage', { value: requested }));
        setLocale(target);
        const changed = await setConfigLanguage(file, target, context.out);
        context.out(t(changed ? 'cli.languageChanged' : 'cli.languageAlready', { language: localeName(target), code: target }));
      } else {
        const effective = resolveLocale(values.lang, context.env, await readConfigLanguage(file));
        setLocale(effective);
        context.out(t('cli.languageCurrent', { language: localeName(effective), code: effective }));
        context.out(t('cli.languageHint'));
      }
      return 0;
    }
    if (command === 'paths') { context.out(JSON.stringify({ config: file, data: paths.data }, null, 2)); return 0; }
    if (command === 'update') {
      return await updatePackage(VERSION, {
        out: context.out, prompts: context.prompts,
        check: !!values.check, yes: !!values.yes,
        post: values['no-post'] ? undefined
          : () => postUpdate({ config: file, env: context.env, out: context.out, err: context.err }),
      });
    }
    if (command === 'integration') {
      if (action === 'list' && !integrationAction) {
        context.out(t('cli.integrationList')); return 0;
      }
      if (action !== 'claude-code' || !['install', 'status', 'remove', 'hook'].includes(integrationAction)) throw new ConfigError(t('cli.integrationUsage'));
      if (integrationAction === 'hook') {
        await dispatchClaudeHook(await context.hookStdin(), file, { ...context, response: value => context.out(JSON.stringify(value)) });
        return 0;
      }
      if (integrationAction === 'status') {
        const status = await claudeCodeStatus({ env: context.env });
        context.out(t('cli.integrationStatusFile', { file: status.file }));
        context.out(t('cli.integrationStatusCounts', { stop: status.stop, notification: status.notification,
          lifecycle: status.lifecycle, interaction: status.interaction, others: status.others }));
        context.out(status.disabled ? t('cli.integrationDisabled') : t('cli.integrationStatusNote'));
        return status.stop === 1 && status.notification === 1 && status.lifecycle === 3 && status.interaction === 5 && !status.disabled ? 0 : 1;
      }
      const prompts = context.prompts ?? (values.yes
        ? { out: context.out, text: async () => '', secret: async () => '' }
        : terminalPrompts());
      if (integrationAction === 'install') {
        const config = await loadConfig(file, true, context.env);
        if (!ready(config, 'telegram') && !ready(config, 'feishu')) throw new ConfigError(t('cli.setupChannelFirst'));
      }
      return await configureClaudeCode(file, integrationAction as 'install' | 'remove', prompts,
        { env: context.env, confirm: values.yes ? false : undefined }) ? 0 : 130;
    }
    if (command === 'reply') {
      if (!['setup', 'start', 'status', 'stop', 'disable', 'run'].includes(action)) throw new ConfigError(t('cli.replyUsage'));
      if (action === 'setup') {
        const saved = await configureReplies(file, context.prompts ?? terminalPrompts(), context.env);
        if (saved) context.out(t('cli.replySaved'));
        return saved ? 0 : 130;
      }
      if (action === 'disable') {
        if (!await disableReplies(file, context.prompts ?? terminalPrompts())) return 130;
        const stopped = await stopBridge(file);
        context.out(stopped ? t('cli.bridgeStopped') : t('cli.replyDisabled'));
        return 0;
      }
      if (action === 'stop') {
        const stopped = await stopBridge(file);
        context.out(stopped ? t('cli.stopStopped') : t('cli.stopRequested'));
        return stopped ? 0 : 1;
      }
      if (action === 'status') {
        const access = await accessReplies(file, context.env), status = await bridgeStatus(file);
        context.out(access ? t('cli.replyStatusAccess', { users: access.policy.users.length,
          state: t(access.policy.permissions ? 'cli.replyPermissionOn' : 'cli.replyPermissionOff') }) : t('cli.replyStatusNoAccess'));
        context.out(status.ready ? t('cli.bridgeReady') : status.running ? t('cli.bridgeStarting') : t('cli.bridgeNotRunning'));
        if (status.error) context.err(status.error);
        return access && status.ready ? 0 : 1;
      }
      if (action === 'run') { await runBridge(file, { env: context.env, lang: values.lang, log: context.err }); return 0; }
      const ready = await startBridge(file, context.env);
      context.out(ready ? t('cli.replyStartReady') : t('cli.replyStartNotReady'));
      return ready ? 0 : 1;
    }
    if (command === 'credentials') {
      if (action !== 'clear') throw new ConfigError(t('cli.credentialsUsage'));
      return await clearCredentials(file, context.prompts ?? terminalPrompts()) ? 0 : 130;
    }
    if (command === 'setup') {
      if (!values.template) {
        if (values.yes) throw new ConfigError(t('cli.yesTemplateOnly'));
        const prompts = context.prompts ?? terminalPrompts();
        const notes: string[] = [];
        const test = !values['no-test'];
        if (test) notes.push(t('cli.setupNoteTest'));
        let hooks = !values['no-hooks'];
        if (hooks) {
          try {
            notes.push(t('cli.setupNoteHooksPath', { path: claudeSettingsPath(context.env) }));
            notes.push(t('cli.setupNoteHooksScope'));
            notes.push(t('cli.setupNoteHooksLifecycle'));
          } catch (error) {
            hooks = false;
            context.out(error instanceof ConfigError ? t('cli.skipHooks', { reason: error.message }) : t('cli.skipHooksNoPath'));
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
              const plan = makePlan(channel, { title: t('cli.testTitle'), content: t('cli.testContent'), footer: '', level: 'info' }, config);
              const result = await context.send(plan, config);
              context.out(t('cli.testSent', { channel, sent: result.sent, planned: result.planned }));
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
      context.out(t('cli.templateWillCreate', { file }));
      if (!values.yes && !await context.confirm()) { context.out(t('cli.templateCancelled')); return 130; }
      await createConfig(file); context.out(t('cli.templateCreated')); return 0;
    }
    const config = await loadConfig(file, values.config !== undefined, context.env);
    if (command === 'doctor' || command === 'status') {
      context.out(t('cli.configPath', { file }));
      for (const channel of ['telegram', 'feishu'] as Channel[]) context.out(t('cli.channelStatus', { channel, status: t(ready(config, channel) ? 'cli.channelReady' : 'cli.channelNotReadyStatus') }));
      context.out(t('cli.credentialsNote'));
      return ready(config, 'telegram') || ready(config, 'feishu') ? 0 : 1;
    }
    if (!values.title?.trim()) throw new ConfigError(t('cli.sendTitle'));
    if ([values.content !== undefined, values['content-file'] !== undefined, !!values.stdin].filter(Boolean).length > 1) throw new ConfigError(t('cli.sendSources'));
    const level = values.level ?? 'info';
    const channel = values.channel ?? 'all';
    if (!['info', 'success', 'warn', 'error'].includes(level) || !['all', 'telegram', 'feishu'].includes(channel)) throw new ConfigError(t('cli.channelLevel'));
    let content = values.content ?? values.title;
    if (values['content-file'] !== undefined) content = decodeUtf8(await readFile(values['content-file']));
    if (values.stdin) content = decodeUtf8(await context.stdin());
    const message: Message = { title: values.title, content, footer: values.footer ?? '', level: level as Message['level'] };
    const selected: Channel[] = channel === 'all' ? ['telegram', 'feishu'] : [channel as Channel];
    let failed = false, planned = 0;
    for (const name of selected) {
      if (!ready(config, name)) {
        if (channel !== 'all') throw new ConfigError(t('cli.channelNotReady'));
        continue;
      }
      planned++;
      let plan;
      try { plan = makePlan(name, message, config); }
      catch { context.err(t('cli.segmentationFailed', { channel: name })); failed = true; continue; }
      if (values['dry-run']) { context.out(t('cli.dryRun', { channel: name, recipients: plan.recipients, items: plan.items.length })); continue; }
      const result = await context.send(plan, config);
      context.out(t('cli.sent', { channel: name, sent: result.sent, planned: result.planned }));
      if (!result.ok) { failed = true; context.err(result.error ?? t('channels.sendFailed')); }
    }
    if (!planned) throw new ConfigError(t('cli.noChannels'));
    return failed ? 1 : 0;
  } catch (error) {
    if (error instanceof Cancelled) { context.out(t('common.cancelled')); return isHook ? 0 : 130; }
    context.err(error instanceof ConfigError || error instanceof CredentialError ? error.message : t('common.failure'));
    // Stop hook 的退出码 2 会要求 Claude 继续；通知失败只能报告，不能阻塞或触发重试循环。
    return isHook ? 0 : 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main();
}
