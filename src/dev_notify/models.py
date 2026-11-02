"""与应用来源无关的消息和投递结果。"""

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Message:
    title: str
    content: str
    level: str = "info"
    footer: str = ""

    def __post_init__(self) -> None:
        if not self.title.strip():
            raise ValueError("通知标题不能为空")
        if self.level not in ("info", "success", "warn", "error"):
            raise ValueError("未知通知级别")


@dataclass(frozen=True)
class DeliveryPlan:
    channel: str
    payloads: tuple[dict[str, Any], ...] = field(repr=False)
    recipients: int = 1


@dataclass(frozen=True)
class DeliveryResult:
    channel: str
    planned: int
    sent: int
    error: str = ""

    @property
    def ok(self) -> bool:
        return self.planned > 0 and self.sent == self.planned and not self.error
