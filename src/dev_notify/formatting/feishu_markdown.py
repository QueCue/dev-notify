#!/usr/bin/python
# -*- coding: utf-8 -*-

# 把 通知正文中的 Markdown 转成飞书卡片 `markdown` 组件可渲染的内容。
# 该组件支持代码块和列表，但不支持标题、引用和表格：
# 标题转成加粗，引用加 ▎ 前缀，表格转成等宽代码块。

import re


from . import telegram_markdown

FENCE_PATTERN = re.compile(r'^\s*(`{3,}|~{3,})(.*)$')
HEADING_PATTERN = re.compile(r'^\s{0,3}(#{1,6})\s+(.*)$')
HR_PATTERN = re.compile(r'^\s*([-*_])(?:\s*\1){2,}\s*$')
QUOTE_PATTERN = re.compile(r'^\s*>\s?')
TASK_PATTERN = re.compile(r'^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$')


def RenderTable(rows):
    body = []
    for line in rows:
        if telegram_markdown.IsTableSeparator(line):
            continue
        body.append([
            telegram_markdown.PlainCell(cell)
            for cell in telegram_markdown.SplitTableRow(line)
        ])

    if not body:
        return ''

    columnCount = max(len(row) for row in body)
    for row in body:
        row.extend([''] * (columnCount - len(row)))

    widths = [0] * columnCount
    for row in body:
        for column, cell in enumerate(row):
            widths[column] = max(widths[column], telegram_markdown.DisplayWidth(cell))

    rendered = []
    for rowIndex, row in enumerate(body):
        rendered.append(' | '.join(
            telegram_markdown.PadRight(cell, widths[column])
            for column, cell in enumerate(row)
        ))
        if 0 == rowIndex:
            rendered.append('-+-'.join('-' * max(3, width) for width in widths))

    return '```text\n%s\n```' % '\n'.join(rendered)


def ToMarkdown(text):
    if not text:
        return ''

    text = text.replace('\r\n', '\n').replace('\r', '\n')
    lines = text.split('\n')
    output = []
    index = 0

    while index < len(lines):
        line = lines[index]

        fence = FENCE_PATTERN.match(line)
        if fence:
            marker = fence.group(1)
            closing = re.compile(r'^\s*%s{3,}\s*$' % re.escape(marker[0]))
            block = [marker + fence.group(2).strip()]
            index += 1
            while index < len(lines) and not closing.match(lines[index]):
                block.append(lines[index])
                index += 1
            block.append(marker)
            if index < len(lines):
                index += 1
            output.append('\n'.join(block))
            continue

        if telegram_markdown.IsTableStart(lines, index):
            rows, index = telegram_markdown.CollectTable(lines, index)
            output.append(RenderTable(rows))
            continue

        heading = HEADING_PATTERN.match(line)
        if heading:
            output.append('**%s**' % heading.group(2).strip())
            index += 1
            continue

        if HR_PATTERN.match(line):
            output.append('---')
            index += 1
            continue

        if QUOTE_PATTERN.match(line):
            quoteLines = []
            while index < len(lines) and QUOTE_PATTERN.match(lines[index]):
                quoteLines.append('▎ ' + QUOTE_PATTERN.sub('', lines[index], count=1))
                index += 1
            output.append('\n'.join(quoteLines))
            continue

        task = TASK_PATTERN.match(line)
        if task:
            mark = '☑' if 'x' == task.group(2).lower() else '☐'
            output.append('%s- %s %s' % (task.group(1), mark, task.group(3)))
            index += 1
            continue

        output.append(line)
        index += 1

    return '\n'.join(output)
