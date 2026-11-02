#!/usr/bin/python
# -*- coding: utf-8 -*-

# 通知分段：保留完整正文，优先在段落、行或空白处分割。

import html
import re


def TextLength(text):
    # Telegram 实体偏移使用 UTF-16；按此保守计数，避免 emoji 超限。
    return len(text.encode('utf-16-le')) // 2


def PlainHtml(text):
    return html.unescape(re.sub(r'<[^>]+>', '', text))


def PartTitle(title, index, total):
    if total <= 1:
        return title
    return '%s (%s/%s)' % (title, index + 1, total)


def TakeText(text, limit, measure=TextLength):
    if limit <= 0:
        raise ValueError('通知标题或辅助信息过长，正文没有可用空间')
    if measure(text) <= limit:
        return text, ''
    low, high = 0, min(len(text), limit)
    while low < high:
        middle = (low + high + 1) // 2
        if measure(text[:middle]) <= limit:
            low = middle
        else:
            high = middle - 1
    if not low:
        raise ValueError('分段空间不足以容纳一个字符')
    prefix = text[:low]
    # 不为过早的边界产生大量短消息。
    for separator in ('\n\n', '\n', ' '):
        boundary = prefix.rfind(separator)
        if boundary >= low // 2:
            low = boundary + len(separator)
            break
    return text[:low], text[low:]


def SplitHtml(text, limit):
    # 输入只来自本工具的 HTML 转换器；闭合并重开跨段标签。
    parts = []
    current = []
    stack = []
    used = 0

    def Flush():
        nonlocal current, used
        if used:
            parts.append(''.join(current) + ''.join('</%s>' % name for name, _ in reversed(stack)))
            current = [opening for _, opening in stack]
            used = 0

    for token in re.findall(r'<[^>]+>|&(?:#\d+|#x[0-9a-fA-F]+|\w+);|[^<&]+|[<&]', text):
        if token.startswith('<') and token.endswith('>'):
            if token.startswith('</'):
                if stack:
                    stack.pop()
            else:
                name = token[1:-1].split()[0]
                stack.append((name, token))
            current.append(token)
            continue
        if token.startswith('&') and token.endswith(';'):
            size = TextLength(html.unescape(token))
            if used + size > limit:
                Flush()
            if size > limit:
                raise ValueError('分段空间不足以容纳一个字符')
            current.append(token)
            used += size
            continue
        while token:
            if used >= limit or TextLength(token[0]) > limit - used:
                Flush()
            piece, token = TakeText(token, limit - used)
            current.append(piece)
            used += TextLength(piece)
            if token:
                Flush()
    Flush()
    return parts or ['']


def SplitMarkdown(text, limit):
    # 飞书正文已转换为 markdown；使用 UTF-8 字节预算同时约束请求大小。
    # 先保护行内格式，跨段行内代码/粗体重开标记；超长链接保留文本和地址。
    measure = lambda value: len(value.encode('utf-8'))
    parts = []
    current = ''
    fence = ''

    def Flush():
        nonlocal current
        if current:
            parts.append(current + ('\n' + fence if fence else ''))
            current = fence + '\n' if fence else ''

    for line in text.splitlines(keepends=True):
        marker = re.match(r'^\s*(`{3,}|~{3,})(.*?)(?:\n)?$', line)
        if marker:
            if measure(current + line) + 16 > limit:
                Flush()
            current += line
            if fence and marker.group(1)[0] == fence[0] and len(marker.group(1)) >= len(fence) and not marker.group(2).strip():
                fence = ''
            elif not fence:
                fence = marker.group(1)
            continue
        tokens = [line] if fence else re.findall(r'`[^`\n]+`|\*\*[^\n]+?\*\*|\[[^\]\n]+\]\([^\n)]+\)|[^`*\[]+|.', line, re.DOTALL)
        for token in tokens:
            if measure(current + token) + len(fence) + 16 <= limit:
                current += token
                continue
            if measure(token) + len(fence) * 2 + 16 <= limit:
                Flush()
                current += token
                continue
            # 超长行（包括表格与代码）必须拆开；代码围栏在每段闭合。
            wrapper = ''
            if not fence:
                if token.startswith('`') and token.endswith('`'):
                    wrapper = '`'
                elif token.startswith('**') and token.endswith('**'):
                    wrapper = '**'
            if wrapper:
                token = token[len(wrapper):-len(wrapper)]
                while token:
                    available = limit - measure(current) - 2 * len(wrapper) - 16
                    if available < 4:
                        Flush()
                        available = limit - measure(current) - 2 * len(wrapper) - 16
                    piece, token = TakeText(token, available, measure)
                    current += wrapper + piece + wrapper
                    if token:
                        Flush()
                continue
            if not fence and token.startswith('['):
                from . import telegram_markdown
                token = telegram_markdown.PlainCell(token)
            while token:
                available = limit - measure(current) - len(fence) - 16
                if available < 4:
                    Flush()
                    available = limit - measure(current) - len(fence) - 16
                piece, token = TakeText(token, available, measure)
                current += piece
                if token:
                    Flush()
    if current:
        parts.append(current + ('\n' + fence if fence else ''))
    return parts or ['']
