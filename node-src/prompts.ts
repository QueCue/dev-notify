import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { ConfigError } from './config.js';

export class Cancelled extends Error {}
export interface Prompts {
  text(label: string): Promise<string>;
  secret(label: string): Promise<string>;
  out(text: string): void;
}
export function terminalPrompts(): Prompts {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new ConfigError('配置向导需要在交互终端中运行。自动化场景可以改用 setup --template --yes 搭配环境变量。');
  return {
    out: text => console.log(text),
    text: label => readText(label),
    secret: label => readHidden(label),
  };
}
export async function readText(label: string, input = process.stdin, output = process.stdout): Promise<string> {
  const terminal = createInterface({ input, output });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  terminal.once('SIGINT', cancel);
  terminal.once('close', cancel);
  try { return (await terminal.question(label, { signal: controller.signal })).trim(); }
  catch { throw new Cancelled('已取消。'); }
  finally {
    terminal.off('SIGINT', cancel);
    terminal.off('close', cancel);
    terminal.close();
  }
}
export async function readHidden(label: string, input = process.stdin, output = process.stdout): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new ConfigError('当前终端不支持隐藏输入。为了不暴露密钥，这里不会改用明文输入；请在支持的终端中运行，或用环境变量配置。');
  const wasRaw = input.isRaw, wasPaused = input.isPaused();
  return new Promise((resolve, reject) => {
    let value = '';
    let finished = false;
    const cleanup = () => {
      input.off('keypress', keypress);
      input.off('error', failed);
      input.off('end', cancelled);
      try { input.setRawMode(wasRaw); } catch { /* 终端已关闭时不泄漏输入。 */ }
      if (wasPaused) input.pause();
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      cleanup(); output.write('\n');
      const result = value.trim(); value = '';
      error ? reject(error) : resolve(result);
    };
    const failed = () => finish(new ConfigError('隐藏输入没有完成，凭据没有保存。'));
    const cancelled = () => finish(new Cancelled('已取消。'));
    const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string } = {}) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) return cancelled();
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace' || key.name === 'delete') { value = Array.from(value).slice(0, -1).join(''); return; }
      if (key.ctrl && key.name === 'u') { value = ''; return; }
      if (key.ctrl || key.meta || !text || /[\x00-\x1f\x7f]/.test(text)) return;
      if (value.length + text.length > 8192) return finish(new ConfigError('凭据输入过长，没有保存。'));
      value += text;
    };
    try {
      // 先进入 raw mode 再展示提示，任何失败都不退回明文输入。
      input.setRawMode(true);
      emitKeypressEvents(input);
      input.on('keypress', keypress); input.on('error', failed); input.on('end', cancelled);
      input.resume(); output.write(label);
    } catch { failed(); }
  });
}
