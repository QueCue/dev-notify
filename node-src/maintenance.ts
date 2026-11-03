import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigError, type Env } from './config.js';
import { claudeCodeStatus, type IntegrationStatus } from './claude-code.js';
import { bridgeStatus } from './reply-bridge.js';

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
  wait?: (ms: number) => Promise<void>;
}

function runCli(args: string[]): number {
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', timeout: 300000 });
  if (result.error) throw new ConfigError('无法运行更新后的 dev-notify。请重新打开终端后运行 dev-notify --version 检查。');
  return result.status ?? 1;
}

function reason(error: unknown): string {
  return error instanceof ConfigError ? error.message : '请运行 dev-notify integration claude-code status 或 dev-notify reply status 检查。';
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
  catch (error) { options.err(`无法检查 Claude Code hooks：${reason(error)}`); failed = true; }
  if (hooksStatus) {
    const count = hooksStatus.stop + hooksStatus.notification + hooksStatus.lifecycle + hooksStatus.interaction;
    if (!count) options.out('未检测到本工具的 Claude Code hooks，跳过。');
    else if (!hooksStatus.configs.some(file => normalize(file) === normalize(options.config))) {
      options.out('Claude Code hooks 绑定的是其他通知配置，跳过自动更新；如需更新，请用原来的 --config 运行 integration claude-code install。');
    } else {
      options.out('更新 Claude Code hooks ...');
      try {
        if (run(['integration', 'claude-code', 'install', '--yes', '--config', options.config]) === 0) options.out('Claude Code hooks 已更新。');
        else { options.err('Claude Code hooks 更新失败。'); failed = true; }
      } catch (error) { options.err(`Claude Code hooks 更新失败：${reason(error)}`); failed = true; }
    }
  }

  let bridgeState: BridgeState | null = null;
  try { bridgeState = await bridge(); }
  catch (error) { options.err(`无法检查回复桥接：${reason(error)}`); failed = true; }
  if (bridgeState?.running) {
    options.out('重启回复桥接 ...');
    try {
      // 0 表示已停止或本来未运行；1 表示停止请求已登记，下面等待进程释放锁。
      run(['reply', 'stop', '--config', options.config]);
      let stillRunning = true;
      for (let i = 0; i < 20; i++) {
        try { stillRunning = (await bridge()).running; } catch { break; }
        if (!stillRunning) break;
        await wait(500);
      }
      if (stillRunning) { options.err('回复桥接仍在退出，请稍后运行 dev-notify reply start。'); failed = true; }
      else if (run(['reply', 'start', '--config', options.config]) === 0) options.out('回复桥接已重启。');
      else { options.err('回复桥接启动失败。'); failed = true; }
    } catch (error) { options.err(`回复桥接重启失败：${reason(error)}`); failed = true; }
  } else if (bridgeState) options.out('未检测到运行中的回复桥接，跳过。');

  return failed ? 1 : 0;
}
