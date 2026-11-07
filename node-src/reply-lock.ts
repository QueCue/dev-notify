import { open, readFile, unlink, lstat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { ConfigError } from './config.js';
import { t } from './i18n.js';

export type ProcessState = 'alive' | 'dead' | 'unknown';
export function processState(pid: number): ProcessState {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
}
interface LockRecord { pid: number; owner: string }
export interface BotLock { release(): Promise<void> }

// 只有 ESRCH 可证明进程已退出；权限不足、PID复用、坏文件都不允许抢占。
export async function acquireBotLock(file: string, owner: string,
  probe: (pid: number) => ProcessState = processState): Promise<BotLock> {
  if (!/^[a-f0-9]{32}$/.test(owner)) throw new ConfigError(t('reply.bridgeLocked'));
  const record: LockRecord = { pid: process.pid, owner };
  const readRecord = async (): Promise<LockRecord | null> => {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error();
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (!Number.isSafeInteger(value?.pid) || value.pid <= 0 || typeof value.owner !== 'string' ||
          !/^[a-f0-9]{32}$/.test(value.owner)) throw new Error();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new ConfigError(t('reply.bridgeLocked'));
    }
  };
  const dead = (value: LockRecord | null) => {
    if (!value) return true;
    try { return probe(value.pid) === 'dead'; } catch { return false; }
  };
  const create = async (): Promise<BotLock> => {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
    catch (error) { try { await handle.close(); } finally { await unlink(file); } throw error; }
    let released = false;
    return { async release() {
      if (released) return;
      released = true;
      try {
        const current = await readRecord();
        if (current?.pid === record.pid && current.owner === record.owner) await unlink(file);
      } finally { await handle.close(); }
    } };
  };
  try { return await create(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConfigError(t('reply.bridgeLocked')); }
  if (!dead(await readRecord())) throw new ConfigError(t('reply.bridgeLocked'));

  // 串行化“检查死亡→删除→重新创建”，两个恢复者不能误删对方的新锁。
  // 恢复门闩自身若损坏或残留则保守拒绝，不递归猜测并抢锁。
  const recoveryFile = file + '.recover';
  let gate: FileHandle;
  try { gate = await open(recoveryFile, 'wx', 0o600); }
  catch { throw new ConfigError(t('reply.bridgeLocked')); }
  try {
    await gate.writeFile(JSON.stringify(record));
    const current = await readRecord();
    if (!dead(current)) throw new ConfigError(t('reply.bridgeLocked'));
    if (current) await unlink(file);
    try { return await create(); }
    catch { throw new ConfigError(t('reply.bridgeLocked')); }
  } finally {
    try { await gate.close(); } finally { await unlink(recoveryFile); }
  }
}
