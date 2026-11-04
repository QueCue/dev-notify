import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_TAIL = 2 * 1024 * 1024;
const MAX_AGE = 5 * 60 * 1000;
const MAX_SKEW = 60 * 1000;

function inside(file: string, directory: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const base = normalize(file), root = normalize(directory);
  return base.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
/** 只读取 transcript 尾部，返回最后一条 assistant 记录的时间；不读取或输出消息内容。 */
export async function transcriptEndTime(file: unknown, configRoot: string, now = new Date()): Promise<Date | null> {
  if (typeof file !== 'string' || !file || !path.isAbsolute(file) || !file.endsWith('.jsonl')) return null;
  let resolved: string, projects: string;
  try {
    resolved = await realpath(file);
    projects = await realpath(path.join(configRoot, 'projects'));
  } catch { return null; }
  if (!inside(resolved, projects)) return null;
  let handle;
  try {
    handle = await open(resolved, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return null;
    const length = Math.min(stat.size, MAX_TAIL);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    const lines = buffer.toString('utf8').split('\n');
    // 从文件中间开始读取时，首行可能被截断，跳过它。
    const first = stat.size > length ? 1 : 0;
    for (let index = lines.length - 1; index >= first; index--) {
      const line = lines[index].trim();
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type !== 'assistant' || typeof record.timestamp !== 'string') continue;
      const time = new Date(record.timestamp);
      if (!Number.isFinite(time.getTime())) continue;
      const age = now.getTime() - time.getTime();
      // 防止把上一轮或异常时钟当成这次结束时间。
      if (age > MAX_AGE || age < -MAX_SKEW) return null;
      return time;
    }
  } catch { return null; }
  finally { await handle?.close(); }
  return null;
}
