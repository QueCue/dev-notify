#!/usr/bin/python
# -*- coding: utf-8 -*-

# 把 通知正文中的 Markdown 转换成 Telegram Bot API 支持的 HTML。
# Telegram 的 HTML 模式只支持有限标签，这里处理代码块、行内代码、标题、
# 引用、列表、链接、粗体、斜体、删除线和表格，其余内容按纯文本转义。

import html
import re
import unicodedata

CODE_PLACEHOLDER = '\x00code%d\x00'
FENCE_PATTERN = re.compile(r'^\s*(`{3,}|~{3,})(.*)$')
HEADING_PATTERN = re.compile(r'^\s{0,3}(#{1,6})\s+(.*)$')
HR_PATTERN = re.compile(r'^\s*([-*_])(?:\s*\1){2,}\s*$')
QUOTE_PATTERN = re.compile(r'^\s*>\s?')
LIST_PATTERN = re.compile(r'^(\s*)[-*+]\s+(.*)$')
TABLE_SEPARATOR_CELL = re.compile(r'^:?-{3,}:?$')


def EscapeHtml(text):
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def DisplayWidth(text):
    width = 0
    for ch in text:
        if 'W' == unicodedata.east_asian_width(ch) or 'F' == unicodedata.east_asian_width(ch):
            width += 2
        else:
            width += 1
    return width


def PadRight(text, targetWidth):
    spaces = targetWidth - DisplayWidth(text)
    if 0 < spaces:
        return text + ' ' * spaces
    return text


def PlainCell(text):
    text = re.sub(r'`([^`]*)`', r'\1', text)
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'__(.+?)__', r'\1', text)
    text = re.sub(r'~~(.+?)~~', r'\1', text)
    text = re.sub(r'\[([^\]]+)\]\((https?://[^)]+)\)', r'\1 (\2)', text)
    return text.strip()


def InlineFormat(raw):
    codes = []

    def ReplaceCode(match):
        codes.append(EscapeHtml(match.group(1)))
        return CODE_PLACEHOLDER % (len(codes) - 1)

    text = re.sub(r'`([^`\n]+)`', ReplaceCode, raw)
    text = EscapeHtml(text)

    def ReplaceLink(match):
        return '<a href="%s">%s</a>' % (
            match.group(2).replace('"', '&quot;'),
            match.group(1),
        )

    text = re.sub(r'\[([^\]\n]+)\]\((https?://[^\s)]+)\)', ReplaceLink, text)
    text = re.sub(r'\*\*(?=\S)(.+?)(?<=\S)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])', r'<b>\1</b>', text)
    text = re.sub(r'~~(?=\S)(.+?)(?<=\S)~~', r'<s>\1</s>', text)
    text = re.sub(r'(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])', r'<i>\1</i>', text)
    text = re.sub(r'(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])', r'<i>\1</i>', text)

    for index, code in enumerate(codes):
        text = text.replace(CODE_PLACEHOLDER % index, '<code>%s</code>' % code)
    return text


def SplitTableRow(line):
    text = line.strip()
    if text.startswith('|'):
        text = text[1:]
    if text.endswith('|'):
        text = text[:-1]
    return [cell.strip() for cell in text.split('|')]


def IsTableSeparator(line):
    if '|' not in line:
        return False
    cells = SplitTableRow(line)
    if not cells:
        return False
    for cell in cells:
        if not TABLE_SEPARATOR_CELL.match(cell):
            return False
    return True


def IsTableStart(lines, index):
    if index + 1 >= len(lines):
        return False
    if '|' not in lines[index]:
        return False
    return IsTableSeparator(lines[index + 1])


def CollectTable(lines, index):
    rows = [lines[index], lines[index + 1]]
    cursor = index + 2
    while cursor < len(lines) and lines[cursor].strip() and '|' in lines[cursor]:
        rows.append(lines[cursor])
        cursor += 1
    return rows, cursor


def RenderTable(rows):
    body = []
    separatorIndex = -1
    for rowIndex, line in enumerate(rows):
        if IsTableSeparator(line):
            separatorIndex = rowIndex
            continue
        body.append([PlainCell(cell) for cell in SplitTableRow(line)])

    if not body:
        return ''

    columnCount = max(len(row) for row in body)
    for row in body:
        row.extend([''] * (columnCount - len(row)))

    widths = [0] * columnCount
    for row in body:
        for column, cell in enumerate(row):
            widths[column] = max(widths[column], DisplayWidth(cell))

    rendered = []
    for rowIndex, row in enumerate(body):
        rendered.append(' | '.join(
            PadRight(cell, widths[column]) for column, cell in enumerate(row)
        ))
        if 1 == separatorIndex and 0 == rowIndex:
            rendered.append('-+-'.join('-' * max(3, width) for width in widths))

    return '<pre>%s</pre>' % EscapeHtml('\n'.join(rendered))


def ToHtml(text):
    if not text:
        return ''

    text = text.replace('\x00', '').replace('\r\n', '\n').replace('\r', '\n')
    lines = text.split('\n')
    output = []
    index = 0

    while index < len(lines):
        line = lines[index]

        fence = FENCE_PATTERN.match(line)
        if fence:
            marker = fence.group(1)[0]
            closing = re.compile(r'^\s*%s{3,}\s*$' % re.escape(marker))
            codeLines = []
            index += 1
            while index < len(lines) and not closing.match(lines[index]):
                codeLines.append(lines[index])
                index += 1
            if index < len(lines):
                index += 1
            output.append('<pre>%s</pre>' % EscapeHtml('\n'.join(codeLines)))
            continue

        if IsTableStart(lines, index):
            rows, index = CollectTable(lines, index)
            output.append(RenderTable(rows))
            continue

        heading = HEADING_PATTERN.match(line)
        if heading:
            output.append('<b>%s</b>' % InlineFormat(heading.group(2).strip()))
            index += 1
            continue

        if HR_PATTERN.match(line):
            output.append('────────')
            index += 1
            continue

        if QUOTE_PATTERN.match(line):
            quoteLines = []
            while index < len(lines) and QUOTE_PATTERN.match(lines[index]):
                quoteLines.append(QUOTE_PATTERN.sub('', lines[index], count=1))
                index += 1
            output.append('<blockquote>%s</blockquote>' % '\n'.join(
                InlineFormat(item) for item in quoteLines
            ))
            continue

        listMatch = LIST_PATTERN.match(line)
        if listMatch:
            indent, item = listMatch.group(1), listMatch.group(2)
            if item.startswith('[ ] '):
                item = '☐ ' + item[4:]
            elif item.lower().startswith('[x] '):
                item = '☑ ' + item[4:]
            output.append('%s• %s' % (indent, InlineFormat(item)))
            index += 1
            continue

        output.append(InlineFormat(line))
        index += 1

    return '\n'.join(output)


def ToPlainText(text):
    # HTML 解析失败时的回退，保留可读文字但去掉标记
    htmlText = ToHtml(text)
    return html.unescape(re.sub(r'<[^>]+>', '', htmlText))
