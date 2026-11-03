import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { ConfigError, type Env } from './config.js';
import { claudeSettingsPath } from './claude-code.js';
import type { SessionTarget } from './reply-state.js';

export interface CommandResult { code: number; stdout: string }
export type Runner = (command: string, args: string[], input?: string) => Promise<CommandResult>;
export const runCommand: Runner = (command, args, input = '') => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', overflow = false;
  const timer = setTimeout(() => { child.kill(); reject(new ConfigError('系统会话操作超时；输入可能已部分送达，不会自动重试')); }, 15000);
  const fail = () => { clearTimeout(timer); reject(new ConfigError('系统会话操作失败；未输出底层命令或输入')); };
  child.on('error', fail); child.stdin.on('error', () => {});
  child.stdout.on('data', data => { if (stdout.length + data.length > 1024 * 1024) { overflow = true; child.kill(); } else stdout += data.toString('utf8'); });
  child.stderr.resume();
  child.once('close', code => { clearTimeout(timer); overflow ? fail() : resolve({ code: code ?? 1, stdout }); });
  child.stdin.end(input, 'utf8');
});
function powershell(script: string, input: unknown, runner: Runner): Promise<CommandResult> {
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return runner(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], JSON.stringify(input));
}
const READ_PROCESS = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $x=[Console]::In.ReadToEnd()|ConvertFrom-Json; $p=Get-Process -Id $x.pid; if($p.ProcessName -ne 'claude'){exit 3}; @{birth=$p.StartTime.ToUniversalTime().Ticks.ToString()}|ConvertTo-Json -Compress`;
export function sanitizeReply(text: string): string {
  if (typeof text !== 'string' || !text.trim()) throw new ConfigError('回复内容为空');
  if (Array.from(text).length > 4000) throw new ConfigError('回复超过 4000 字符，未提交；不会截断或拆成多次任务');
  const value = text.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
  if (!value) throw new ConfigError('回复清理后为空');
  return value;
}
export async function processIdentity(pid: number, platform = process.platform, runner: Runner = runCommand): Promise<{ birth: string; tty: string } | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'win32') {
      const result = await powershell(READ_PROCESS, { pid }, runner);
      if (result.code !== 0) return null;
      const d = JSON.parse(result.stdout);
      return typeof d.birth === 'string' && /^\d+$/.test(d.birth) ? { birth: d.birth, tty: '' } : null;
    }
    if (platform === 'darwin') {
      const result = await runner('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'tty=', '-o', 'comm=']);
      const match = result.stdout.trim().match(/^(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(\S+)\s+(.+)$/);
      if (result.code !== 0 || !match || path.posix.basename(match[3]) !== 'claude' || !/^ttys\d+$/.test(match[2])) return null;
      const groups = await runner('/bin/ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'tpgid=']);
      const group = groups.stdout.trim().match(/^(\d+)\s+(\d+)$/);
      if (groups.code !== 0 || !group || group[1] !== group[2]) return null;
      return { birth: match[1].replace(/\s+/g, ' '), tty: '/dev/' + match[2] };
    }
  } catch { /* 目标不确定时拒绝，不向任意前台终端回退。 */ }
  return null;
}
export interface SessionOptions { env?: Env; platform?: NodeJS.Platform; home?: string; runner?: Runner }
export async function findSession(session: string, options: SessionOptions = {}): Promise<SessionTarget | null> {
  if (!session || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) return null;
  const directory = path.join(path.dirname(claudeSettingsPath(options.env, options.home ?? homedir())), 'sessions');
  let names;
  try { names = await readdir(directory); } catch { return null; }
  const matches: any[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const bytes = await readFile(path.join(directory, name));
      if (bytes.length > 128 * 1024) continue;
      const d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (d.sessionId === session && d.pid === Number(name.slice(0, -5))) matches.push(d);
    } catch { /* 其他损坏或写入中的会话文件不作为目标。 */ }
  }
  if (matches.length !== 1) return null;
  const d = matches[0], identity = await processIdentity(d.pid, options.platform, options.runner);
  if (!identity) return null;
  return { session, pid: d.pid, ...identity, title: typeof d.name === 'string' ? Array.from(d.name).slice(0, 60).join('') : '',
    cwd: typeof d.cwd === 'string' ? d.cwd : '', updated: Date.now(), working: false };
}
export async function validateTarget(target: SessionTarget, options: SessionOptions = {}): Promise<boolean> {
  const current = await findSession(target.session, options);
  return current !== null && current.pid === target.pid && current.birth === target.birth && current.tty === target.tty;
}
const WINDOWS_INJECT = `$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);$x=[Console]::In.ReadToEnd()|ConvertFrom-Json;$p=Get-Process -Id $x.pid;if($p.ProcessName -ne 'claude' -or $p.StartTime.ToUniversalTime().Ticks.ToString() -ne $x.birth){exit 3}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class DevNotifyConsole {
 [StructLayout(LayoutKind.Explicit, Size=20, CharSet=CharSet.Unicode)] public struct Record {
  [FieldOffset(0)] public ushort type;
  [FieldOffset(4)] public int down;
  [FieldOffset(8)] public ushort repeat;
  [FieldOffset(10)] public ushort key;
  [FieldOffset(14)] public char ch;
 }
 [DllImport("kernel32.dll")] static extern bool FreeConsole();
 [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string n,uint a,uint s,IntPtr p,uint c,uint f,IntPtr t);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool WriteConsoleInputW(IntPtr h,Record[] r,uint n,out uint written);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList([Out] uint[] ids,uint count);
 public static bool Send(uint pid,string text) {
  FreeConsole(); if(!AttachConsole(pid))return false;
  IntPtr h=new IntPtr(-1);
  try {
   var ids=new uint[1024];uint count=GetConsoleProcessList(ids,(uint)ids.Length);
   if(count==0||count>ids.Length)return false;
   foreach(uint id in ids){if(id==0||id==pid)continue;try{if(System.Diagnostics.Process.GetProcessById((int)id).ProcessName=="claude")return false;}catch{return false;}}
   h=CreateFileW("CONIN$",0xC0000000,3,IntPtr.Zero,3,0,IntPtr.Zero);
   if(h==new IntPtr(-1))return false;
   var records=new List<Record>();
   foreach(char c in text){records.Add(new Record{type=1,down=1,repeat=1,ch=c});records.Add(new Record{type=1,repeat=1});}
   records.Add(new Record{type=1,down=1,repeat=1,key=13,ch='\\r'});records.Add(new Record{type=1,repeat=1,key=13});
   uint written;var all=records.ToArray();return WriteConsoleInputW(h,all,(uint)all.Length,out written)&&written==all.Length;
  } finally {if(h!=new IntPtr(-1))CloseHandle(h);FreeConsole();}
 }
}
'@
if([DevNotifyConsole]::Send([uint32]$x.pid,[string]$x.text)){exit 0}else{exit 4}`;
export async function injectReply(target: SessionTarget, text: string, options: SessionOptions = {}): Promise<void> {
  const safe = sanitizeReply(text), runner = options.runner ?? runCommand, platform = options.platform ?? process.platform;
  if (!await validateTarget(target, options)) throw new ConfigError('会话已关闭、切换或无法核验，请从最新通知回复');
  if (platform === 'win32') {
    const result = await powershell(WINDOWS_INJECT, { pid: target.pid, birth: target.birth, text: safe }, runner);
    if (result.code !== 0) throw new ConfigError('Windows 控制台注入失败或部分写入；不会自动重试，请检查终端');
    return;
  }
  if (platform !== 'darwin') throw new ConfigError('远程回复仅支持 Windows 与 macOS');
  // 先确定 tmux pane，字面文本通过 stdin 缓冲区传入，绝不作为 shell 或按键名称执行。
  let listing: CommandResult | null = null;
  try { listing = await runner('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_tty}']); } catch { /* Ghostty 回退仅在尚未发送任何输入时使用。 */ }
  const pane = listing?.code === 0 ? listing.stdout.split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === target.tty && /^%\d+$/.test(parts[0]))?.[0] : undefined;
  if (pane) {
    const name = 'dev-notify-' + target.pid + '-' + Date.now();
    const loaded = await runner('tmux', ['load-buffer', '-b', name, '-'], safe);
    if (loaded.code !== 0) throw new ConfigError('tmux 输入缓冲区创建失败，未提交');
    try {
      if (!await validateTarget(target, options)) throw new ConfigError('会话已变化，未提交');
      if ((await runner('tmux', ['paste-buffer', '-d', '-b', name, '-t', pane])).code !== 0) throw new ConfigError('tmux 粘贴失败，可能部分送达，不重试');
      if ((await runner('tmux', ['send-keys', '-t', pane, 'Enter'])).code !== 0) throw new ConfigError('tmux 提交失败，文本可能已输入，不重试');
    } finally { await runner('tmux', ['delete-buffer', '-b', name]).catch(() => {}); }
    return;
  }
  const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const action = 'text:' + safe.replace(/\\/g, '\\\\') + '\\x0d';
  const script = `tell application "Ghostty"\nrepeat with w in windows\nrepeat with t in terminals of w\nif tty of t is "${escape(target.tty)}" then\nperform action "${escape(action)}" on t\nreturn "ok"\nend if\nend repeat\nend repeat\nreturn "notfound"\nend tell`;
  const result = await runner('/usr/bin/osascript', ['-'], script);
  if (result.code !== 0 || result.stdout.trim() !== 'ok') throw new ConfigError('Ghostty 未找到目标或注入失败；不会回退到任意窗口或重复输入');
}
