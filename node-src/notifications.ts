import path from 'node:path';
import type { Config } from './config.js';

export type NotifyEvent = 'stop' | 'waiting';
export interface QuietHours { start: string; end: string }

const minutesOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

/** 按本机本地时间判断；start > end 表示跨午夜，start === end 已在配置解析时视为未启用。 */
export function quietNow(quietHours: QuietHours | null, now = new Date()): boolean {
  if (!quietHours) return false;
  const start = minutesOf(quietHours.start), end = minutesOf(quietHours.end);
  if (start === end) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
function normalize(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function under(cwd: string, prefix: string): boolean {
  const base = normalize(cwd), target = normalize(prefix);
  if (base === target) return true;
  return base.startsWith(target.endsWith(path.sep) ? target : target + path.sep);
}
/** deny 优先；allow 非空时只放行匹配的项目；缺少 cwd 时 allow 不匹配，deny 不匹配。 */
export function projectAllowed(projects: { allow: string[]; deny: string[] }, cwd: unknown): boolean {
  const value = typeof cwd === 'string' ? cwd.trim() : '';
  if (!value) return projects.allow.length === 0;
  if (projects.deny.some(prefix => under(value, prefix))) return false;
  return projects.allow.length === 0 || projects.allow.some(prefix => under(value, prefix));
}
/** 只决定是否发送普通通知；回复桥接、答题和工具权限事件不受这里影响。 */
export function shouldNotify(config: Config, event: NotifyEvent, cwd: unknown, now = new Date()): boolean {
  if (!config.notifications.events[event]) return false;
  if (!projectAllowed(config.notifications.projects, cwd)) return false;
  return !quietNow(config.notifications.quietHours, now);
}
