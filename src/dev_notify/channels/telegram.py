"""Telegram 通知：渲染后分段，格式错误回退，有限的限流重试。"""

import time
from collections.abc import Callable

from ..config import TelegramConfig
from ..formatting import message_parts as parts, telegram_markdown as markdown
from ..models import DeliveryPlan, DeliveryResult, Message
from ..transport import TransportError, request_json

ICONS = {"info": "ℹ️", "success": "✅", "warn": "⚠️", "error": "❌"}


def format_text(title: str, content: str, footer: str, icon: str) -> str:
    sections = [f"{icon} <b>{markdown.EscapeHtml(title)}</b>"]
    if content:
        sections.append(content)
    if footer:
        sections.append("────────\n<i>" + markdown.EscapeHtml(footer) + "</i>")
    return "\n\n".join(sections)


def plan(message: Message, config: TelegramConfig) -> DeliveryPlan:
    if not config.configured:
        raise ValueError("Telegram 未启用或缺少凭据/接收人")
    rendered = markdown.ToHtml(message.content)
    icon = ICONS[message.level]
    overhead = parts.TextLength(parts.PlainHtml(format_text(message.title, "", message.footer, icon)))
    reserve = 2 * len(str(max(1, len(rendered)))) + 12
    budget = 3900 - overhead - reserve
    if budget < 2:
        raise ValueError("Telegram 标题或辅助信息过长")
    chunks = parts.SplitHtml(rendered, budget)
    payloads = []
    for chat_id in config.chat_ids:
        for index, chunk in enumerate(chunks):
            text = format_text(parts.PartTitle(message.title, index, len(chunks)), chunk, message.footer, icon)
            if parts.TextLength(parts.PlainHtml(text)) > 4096:
                raise ValueError("Telegram 分段超过消息长度限制")
            payloads.append({"chat_id": chat_id, "text": text, "parse_mode": "HTML",
                             "disable_web_page_preview": "true"})
    return DeliveryPlan("telegram", tuple(payloads), len(config.chat_ids))


def send(plan: DeliveryPlan, config: TelegramConfig, *, request: Callable = request_json,
         sleep: Callable = time.sleep) -> DeliveryResult:
    url = f"https://api.telegram.org/bot{config.token}/sendMessage"
    sent = 0
    failed_chats = set()
    error = ""

    def post(payload: dict) -> dict:
        response = request(url, payload, form=True)
        if response.get("error_code") == 429:
            parameters = response.get("parameters", {})
            delay = parameters.get("retry_after", 0) if isinstance(parameters, dict) else 0
            if type(delay) in (int, float) and 0 < delay <= 60:
                sleep(delay)
                response = request(url, payload, form=True)
        return response

    for item in plan.payloads:
        if item["chat_id"] in failed_chats:
            continue
        payload = dict(item)
        try:
            response = post(payload)
            if not response.get("ok"):
                description = str(response.get("description", "")).lower()
                if "parse" in description or "entit" in description:
                    payload.pop("parse_mode", None)
                    payload["text"] = parts.PlainHtml(payload["text"])
                    response = post(payload)
            if response.get("ok") is True:
                sent += 1
                continue
            error = "Telegram 拒绝发送，请检查接收人授权、Token 或限流状态"
        except TransportError as exc:
            error = str(exc)
        failed_chats.add(item["chat_id"])
    return DeliveryResult("telegram", len(plan.payloads), sent, error)
