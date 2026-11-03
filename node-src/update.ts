import { spawnSync } from 'node:child_process';
import { ConfigError } from './config.js';
import { terminalPrompts, type Prompts } from './prompts.js';

const NAME = '@quecue/dev-notify';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/;

export interface UpdateRunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type UpdateRunner = (args: string[], capture: boolean) => UpdateRunnerResult;

function npmRunner(args: string[], capture: boolean): UpdateRunnerResult {
  // Windows 的 npm 是 .cmd；Node 不能直接 spawn，需要经过 shell。参数均为固定值。
  const result = spawnSync('npm', args, {
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    timeout: capture ? 30000 : 300000,
    shell: process.platform === 'win32',
  });
  if (result.error) throw new ConfigError('无法运行 npm。请确认已安装 npm，并且它在 PATH 中。');
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function fetchLatest(): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`https://registry.npmjs.org/${NAME.replace('/', '%2F')}/latest?t=${Date.now()}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { 'Cache-Control': 'no-cache, no-store', Accept: 'application/json' },
    });
  } catch {
    throw new ConfigError('无法检查最新版本。请检查网络后重试。');
  }
  if (!response.ok) throw new ConfigError(`无法检查最新版本（HTTP ${response.status}）。请检查网络后重试。`);
  let version: unknown;
  try { version = (await response.json())?.version; } catch { throw new ConfigError('npm registry 返回的版本信息无法解析。'); }
  if (typeof version !== 'string' || !VERSION.test(version)) throw new ConfigError('npm registry 返回的版本号格式不受支持。');
  return version;
}

function parts(version: string): number[] {
  const match = VERSION.exec(version);
  if (!match) throw new ConfigError('版本号格式不受支持。');
  const rank = match[4] === 'alpha' ? 1 : match[4] === 'beta' ? 2 : match[4] === 'rc' ? 3 : 4;
  return [Number(match[1]), Number(match[2]), Number(match[3]), rank, Number(match[5] ?? 0)];
}
export function compareVersions(left: string, right: string): number {
  const a = parts(left), b = parts(right);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export interface UpdateOptions {
  out: (text: string) => void;
  prompts?: Pick<Prompts, 'text'>;
  check: boolean;
  yes: boolean;
  runner?: UpdateRunner;
  latest?: () => Promise<string>;
  /** 安装成功后运行维护步骤；未提供时只打印提示。 */
  post?: () => Promise<number>;
}

async function confirmUpdate(latest: string, options: UpdateOptions): Promise<boolean> {
  if (options.yes) return true;
  if (!options.prompts && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new ConfigError('更新需要在交互终端中确认；非交互场景请使用 dev-notify update --yes。');
  }
  const prompts = options.prompts ?? terminalPrompts();
  return /^(y|yes)$/i.test(await prompts.text(`更新到 ${latest}？[y/N] `));
}

async function runMaintenance(options: UpdateOptions, updated: boolean): Promise<number> {
  if (!options.post) {
    if (updated) options.out('如有 Claude Code hooks，请运行 dev-notify integration claude-code install；如使用远程回复，请重启桥接。');
    return 0;
  }
  const code = await options.post();
  if (code !== 0) {
    options.out(updated ? '更新已完成，但后续维护步骤没有全部成功；请按上面的提示检查。' : '维护步骤没有全部成功；请按上面的提示检查。');
    return code;
  }
  options.out(updated ? '更新后的维护步骤已完成。' : '维护步骤已完成。');
  return 0;
}

export async function updatePackage(current: string, options: UpdateOptions): Promise<number> {
  if (!VERSION.test(current)) throw new ConfigError('当前版本号格式不受支持，无法检查更新。');
  const latest = await (options.latest ?? fetchLatest)();
  if (!VERSION.test(latest)) throw new ConfigError('npm registry 返回的版本号格式不受支持。');
  if (compareVersions(latest, current) <= 0) {
    options.out(`已是最新版本 ${current}。`);
    if (options.check) return 0;
    if (options.post) options.out('将执行 Claude Code hooks 和回复桥接维护。');
    return await runMaintenance(options, false);
  }
  options.out(`当前版本 ${current}，npm 最新版本 ${latest}。`);
  if (options.check) { options.out('运行 dev-notify update 更新。'); return 0; }
  if (options.post) options.out('更新完成后会自动重新安装绑定当前配置的 Claude Code hooks，并重启正在运行的回复桥接；可用 --no-post 跳过。');
  if (!await confirmUpdate(latest, options)) {
    options.out('已取消，没有更新。');
    return 130;
  }
  options.out(`运行 npm install -g ${NAME}@${latest} ...`);
  const result = (options.runner ?? npmRunner)(['install', '-g', `${NAME}@${latest}`], false);
  if (result.status !== 0) throw new ConfigError(`更新没有完成。请检查 npm 权限，或手动运行 npm install -g ${NAME}@latest。`);
  options.out(`已更新到 ${latest}。请重新打开终端后运行 dev-notify --version 确认。`);
  return await runMaintenance(options, true);
}
