import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigError, type Env } from './config.js';
import { t } from './i18n.js';
import { claudeCodeStatus, type IntegrationStatus } from './claude-code.js';
import { bridgeStatus } from './reply-bridge.js';
import { accessReplies } from './reply-state.js';

type HooksStatus = Pick<IntegrationStatus, 'stop' | 'notification' | 'lifecycle' | 'interaction' | 'configs'>;
type BridgeState = Pick<Awaited<ReturnType<typeof bridgeStatus>>, 'running'>;

export interface PostUpdateOptions {
  config: string;
  env: Env;
  out: (text: string) => void;
  err: (text: string) => void;
  run?: (args: string[]) => number;
  hooks?: () => Promise<HooksStatus>;
  bridge?: () => Promise<BridgeState>;
  authorized?: () => Promise<boolean>;
  wait?: (ms: number) => Promise<void>;
}

function runCli(args: string[]): number {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', timeout: 300000 });
  if (result.error) throw new ConfigError(t('maintenance.runFailed'));
  return result.status ?? 1;
}

function reason(error: unknown): string {
  return error instanceof ConfigError ? error.message : t('maintenance.reasonHint');
}

const normalize = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

export async function postUpdate(options: PostUpdateOptions): Promise<number> {
  const run = options.run ?? runCli;
  const hooks = options.hooks ?? (() => claudeCodeStatus({ env: options.env }));
  const bridge = options.bridge ?? (() => bridgeStatus(options.config));
  const wait = options.wait ?? delay;
  let failed = false;

  let hooksStatus: HooksStatus | null = null;
  try { hooksStatus = await hooks(); }
  catch (error) { options.err(t('maintenance.hooksCheckFailed', { reason: reason(error) })); failed = true; }
  if (hooksStatus) {
    const count = hooksStatus.stop + hooksStatus.notification + hooksStatus.lifecycle + hooksStatus.interaction;
    if (!count) options.out(t('maintenance.noHooks'));
    else if (!hooksStatus.configs.some(file => normalize(file) === normalize(options.config))) {
      options.out(t('maintenance.otherConfig'));
    } else {
      options.out(t('maintenance.updatingHooks'));
      try {
        if (run(['integration', 'claude-code', 'install', '--yes', '--config', options.config]) === 0) options.out(t('maintenance.hooksUpdated'));
        else { options.err(t('maintenance.hooksFailed')); failed = true; }
      } catch (error) { options.err(t('maintenance.hooksFailedReason', { reason: reason(error) })); failed = true; }
    }
  }

  let bridgeState: BridgeState | null = null;
  try { bridgeState = await bridge(); }
  catch (error) { options.err(t('maintenance.bridgeCheckFailed', { reason: reason(error) })); failed = true; }
  let resume = bridgeState?.running === true;
  if (bridgeState && !resume) {
    try { resume = await (options.authorized ?? (async () => !!await accessReplies(options.config, options.env)))(); }
    catch (error) { options.err(t('maintenance.bridgeCheckFailed', { reason: reason(error) })); failed = true; }
  }
  if (bridgeState && resume) {
    options.out(t(bridgeState.running ? 'maintenance.restartingBridge' : 'maintenance.startingBridge'));
    try {
      let stillRunning = bridgeState.running;
      if (stillRunning) {
        // 心跳过期不等于进程退出；必须等待活进程真正退出，才启动新版本。
        run(['reply', 'stop', '--config', options.config]);
        for (let i = 0; i < 20; i++) {
          try { stillRunning = (await bridge()).running; } catch { break; }
          if (!stillRunning) break;
          await wait(500);
        }
      }
      if (stillRunning) { options.err(t('maintenance.bridgeStillRunning')); failed = true; }
      else if (run(['reply', 'start', '--config', options.config]) === 0) options.out(t('maintenance.bridgeRestarted'));
      else { options.err(t('maintenance.bridgeStartFailed')); failed = true; }
    } catch (error) { options.err(t('maintenance.bridgeRestartFailed', { reason: reason(error) })); failed = true; }
  } else if (bridgeState) options.out(t('maintenance.noBridge'));

  return failed ? 1 : 0;
}
