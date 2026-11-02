"""飞书卡片通知：按最终请求字节限制分段，逐段降级 markdown 组件。"""

import base64
import copy
import hashlib
import hmac
import json
import time
from collections.abc import Callable

from ..config import FeishuConfig
from ..formatting import feishu_markdown as markdown, message_parts as parts
from ..models import DeliveryPlan, DeliveryResult, Message
from ..transport import TransportError, request_json

COLORS = {"info": "blue", "success": "green", "warn": "yellow", "error": "red"}
MAX_CARD_BYTES = 28000


def card(message: Message, title: str, content: str) -> dict:
    elements = []
    if content:
        elements.append({"tag": "markdown", "content": content})
    if message.footer:
        elements.extend([{"tag": "hr"}, {"tag": "note", "elements": [
            {"tag": "plain_text", "content": message.footer}]}])
    return {"msg_type": "interactive", "card": {
        "config": {"wide_screen_mode": True},
        "header": {"template": COLORS[message.level], "title": {"tag": "plain_text", "content": title}},
        "elements": elements,
    }}


def encoded_size(body: dict) -> int:
    return len(json.dumps(body, ensure_ascii=False).encode("utf-8"))


def plan(message: Message, config: FeishuConfig) -> DeliveryPlan:
    if not config.configured:
        raise ValueError("飞书未启用或缺少 webhook")
    overhead = encoded_size(card(message, message.title, "")) + 512
    # 最坏 JSON 控制字符转义膨胀为 6 倍；实际大小仍在组装后再次检查。
    budget = min(10000, (MAX_CARD_BYTES - overhead) // 6)
    if budget < 128:
        raise ValueError("飞书标题或辅助信息过长")
    chunks = parts.SplitMarkdown(markdown.ToMarkdown(message.content), budget)
    payloads = []
    for index, chunk in enumerate(chunks):
        body = card(message, parts.PartTitle(message.title, index, len(chunks)), chunk)
        if encoded_size(body) + 128 > MAX_CARD_BYTES:
            raise ValueError("飞书分段超过请求大小限制")
        payloads.append(body)
    return DeliveryPlan("feishu", tuple(payloads))


def sign(body: dict, secret: str) -> None:
    if secret:
        timestamp = str(int(time.time()))
        signature = hmac.new(f"{timestamp}\n{secret}".encode("utf-8"), digestmod=hashlib.sha256).digest()
        body.update(timestamp=timestamp, sign=base64.b64encode(signature).decode("ascii"))


def send(plan: DeliveryPlan, config: FeishuConfig, *, request: Callable = request_json,
         sleep: Callable = time.sleep) -> DeliveryResult:
    sent = 0
    for index, item in enumerate(plan.payloads):
        body = copy.deepcopy(item)
        try:
            sign(body, config.secret)
            response = request(config.webhook, body)
            if response.get("code") != 0:
                # 只有存在 markdown 正文时，才有组件回退的意义。
                changed = False
                for i, element in enumerate(body["card"]["elements"]):
                    if element["tag"] == "markdown":
                        body["card"]["elements"][i] = {
                            "tag": "div", "text": {"tag": "lark_md", "content": element["content"]}}
                        changed = True
                if changed:
                    sign(body, config.secret)
                    response = request(config.webhook, body)
            if response.get("code") != 0:
                return DeliveryResult("feishu", len(plan.payloads), sent,
                                      "飞书拒绝发送，请检查机器人权限、签名和频率限制")
        except TransportError as exc:
            return DeliveryResult("feishu", len(plan.payloads), sent, str(exc))
        sent += 1
        if index + 1 < len(plan.payloads):
            sleep(0.25)
    return DeliveryResult("feishu", len(plan.payloads), sent)
