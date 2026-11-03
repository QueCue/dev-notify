// 先解析为独立文本块，再在渲染后的可见文本上分段，不切断 HTML 实体或标签。
import { t } from './i18n.js';

export interface Span { text: string; tags: string[] }
export interface Block { spans: Span[]; code: boolean }
export const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const partTitle = (title: string, index: number, total: number) => total > 1 ? `${title} (${index + 1}/${total})` : title;

function inline(text: string, tags: string[] = [], depth = 0): Span[] {
  if (depth > 8) return [{ text, tags }];
  // 不在生成的 HTML 上执行 Markdown 正则，避免修改链接属性。
  const expression = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*(\S(?:.*?\S)?)\*\*|__(\S(?:.*?\S)?)__|~~(\S(?:.*?\S)?)~~|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])/g;
  const spans: Span[] = [];
  let cursor = 0;
  for (const match of text.matchAll(expression)) {
    if (match.index! > cursor) spans.push({ text: text.slice(cursor, match.index), tags });
    if (match[1] !== undefined) spans.push({ text: match[1], tags: [...tags, 'code'] });
    else if (match[2] !== undefined) {
      // 链接地址同样保留在可见文本中；任何纯文本回退都不会丢失地址。
      spans.push(...inline(match[2], tags, depth + 1), { text: ` (${match[3]})`, tags });
    } else {
      const content = match[4] ?? match[5] ?? match[6] ?? match[7] ?? match[8];
      const tag = match[4] !== undefined || match[5] !== undefined ? 'b' : match[6] !== undefined ? 's' : 'i';
      spans.push(...inline(content, [...tags, tag], depth + 1));
    }
    cursor = match.index! + match[0].length;
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor), tags });
  return spans.length ? spans : [{ text: '', tags }];
}
function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => inline(cell.trim()).map(s => s.text).join(''));
}
function separator(line: string): boolean {
  return line.includes('|') && line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').every(cell => /^:?-{3,}:?$/.test(cell.trim()));
}
function width(text: string): number {
  let size = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    size += code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7af || code >= 0xff01 && code <= 0xff60 || code >= 0x1f300) ? 2 : 1;
  }
  return size;
}
function table(lines: string[]): string {
  const rows = lines.filter((_, index) => index !== 1).map(cells);
  const count = Math.max(...rows.map(row => row.length));
  const widths = Array.from({ length: count }, (_, col) => Math.max(3, ...rows.map(row => width(row[col] ?? ''))));
  const output: string[] = [];
  rows.forEach((row, index) => {
    output.push(widths.map((size, col) => (row[col] ?? '') + ' '.repeat(size - width(row[col] ?? ''))).join(' | '));
    if (!index) output.push(widths.map(size => '-'.repeat(size)).join('-+-'));
  });
  return output.join('\n');
}
export function parseMarkdown(content: string): Block[] {
  const lines = content.replace(/\r\n?/g, '\n').replace(/\0/g, '').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const closing = new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      index++;
      while (index < lines.length && !closing.test(lines[index])) body.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push({ spans: [{ text: body.join('\n'), tags: [] }], code: true });
      continue;
    }
    if (index + 1 < lines.length && line.includes('|') && separator(lines[index + 1])) {
      const rows = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) rows.push(lines[index++]);
      blocks.push({ spans: [{ text: table(rows), tags: [] }], code: true });
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    const list = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    let spans: Span[];
    if (heading) spans = inline(heading[1], ['b']);
    else if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) spans = [{ text: '────────', tags: [] }];
    else if (quote) spans = inline(quote[1], ['blockquote']);
    else if (list) spans = inline(`${list[1]}• ${list[2].replace(/^\[ \] /, '☐ ').replace(/^\[x\] /i, '☑ ')}`);
    else spans = inline(line);
    blocks.push({ spans, code: false });
    index++;
  }
  return blocks;
}
export function visibleText(blocks: Block[]): string {
  return blocks.map(block => block.spans.map(span => span.text).join('')).join('\n');
}
function cut(text: string, budget: number, measure: (text: string) => number): [string, string] {
  if (budget < 1) throw new Error(t('format.noSpace'));
  let used = 0, end = 0;
  for (const ch of text) {
    const size = measure(ch);
    if (used + size > budget) break;
    used += size;
    end += ch.length;
  }
  if (!end && text) throw new Error(t('format.oneChar'));
  if (end < text.length) {
    for (const boundary of ['\n\n', '\n', ' ']) {
      const offset = text.slice(0, end).lastIndexOf(boundary);
      if (offset >= end / 2) { end = offset + boundary.length; break; }
    }
  }
  return [text.slice(0, end), text.slice(end)];
}
export function telegramParts(blocks: Block[], budget: number): { html: string; plain: string }[] {
  if (budget < 2) throw new Error(t('format.telegramHeader'));
  const output: { html: string; plain: string }[] = [];
  let html = '', plain = '';
  const flush = () => { if (plain) output.push({ html, plain }); html = ''; plain = ''; };
  blocks.forEach((block, index) => {
    const spans = index ? [{ text: '\n', tags: [] }, ...block.spans] : block.spans;
    for (const span of spans) {
      let rest = span.text;
      while (rest) {
        if (budget - plain.length < [...rest][0].length) flush();
        const [piece, remaining] = cut(rest, budget - plain.length, text => text.length);
        // 块间换行不包裹为代码，其余内容每片均使用完整标签。
        const actualTags = block.code && !(index && span === spans[0]) ? ['pre'] : span.tags;
        html += actualTags.map(tag => `<${tag}>`).join('') + escapeHtml(piece) + [...actualTags].reverse().map(tag => `</${tag}>`).join('');
        plain += piece;
        rest = remaining;
        if (rest) flush();
      }
    }
  });
  flush();
  return output.length ? output : [{ html: '', plain: '' }];
}
export function feishuParts(blocks: Block[], budget: number): string[] {
  if (budget < 128) throw new Error(t('format.feishuHeader'));
  const output: string[] = [];
  let current = '';
  const size = (text: string) => Buffer.byteLength(text, 'utf8');
  const flush = () => { if (current) output.push(current); current = ''; };
  blocks.forEach((block, index) => {
    if (index) { if (size(current) + 1 > budget) flush(); current += '\n'; }
    for (const span of block.spans) {
      let rest = span.text;
      let prefix = '', suffix = '';
      if (block.code) {
        const runs = rest.match(/`+/g) ?? [];
        const marker = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
        prefix = marker + 'text\n'; suffix = '\n' + marker;
        // 极端围栏长度下保留字面正文，不无限增大包装。
        if (size(prefix + suffix) > budget / 2) { prefix = ''; suffix = ''; }
      } else {
        for (const tag of span.tags) {
          const wrapper = tag === 'b' ? '**' : tag === 'i' ? '*' : tag === 's' ? '~~' : tag === 'code' ? '`' : '';
          if (tag === 'blockquote') prefix += '▎ ';
          else { prefix += wrapper; suffix = wrapper + suffix; }
        }
      }
      while (rest) {
        const overhead = size(prefix + suffix);
        if (size(current) + overhead + size([...rest][0]) > budget) flush();
        const [piece, remaining] = cut(rest, budget - size(current) - overhead, size);
        current += prefix + piece + suffix;
        rest = remaining;
        if (rest) flush();
      }
    }
  });
  flush();
  return output.length ? output : [''];
}
