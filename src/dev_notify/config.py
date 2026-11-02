"""严格读取非敏感配置；环境变量优先，按需读取系统凭据引用。"""

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping
from urllib.parse import urlparse

from . import credentials


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class TelegramConfig:
    token: str = field(default="", repr=False)
    chat_ids: tuple[str, ...] = ()
    enabled: bool = True

    @property
    def configured(self) -> bool:
        return self.enabled and bool(self.token and self.chat_ids)


@dataclass(frozen=True)
class FeishuConfig:
    webhook: str = field(default="", repr=False)
    secret: str = field(default="", repr=False)
    enabled: bool = True

    @property
    def configured(self) -> bool:
        return self.enabled and bool(self.webhook)


@dataclass(frozen=True)
class Config:
    telegram: TelegramConfig
    feishu: FeishuConfig


EXAMPLE = {
    "version": 1,
    "telegram": {"enabled": True, "chat_ids": [], "token_env": "TELEGRAM_BOT_TOKEN"},
    "feishu": {"enabled": True, "webhook_env": "FEISHU_WEBHOOK", "secret_env": "FEISHU_SECRET"},
}


def _keys(value: object, allowed: set[str], section: str) -> dict:
    if not isinstance(value, dict):
        raise ConfigError(f"{section} 必须是 JSON 对象")
    if set(value) - allowed:
        # 不回显未知键和值，防止误填的密钥泄漏到日志。
        raise ConfigError(f"{section} 包含不支持的字段；密钥请使用环境变量或系统凭据引用")
    return value


def _enabled(section: dict) -> bool:
    value = section.get("enabled", True)
    if not isinstance(value, bool):
        raise ConfigError("enabled 必须是布尔值")
    return value


def _secret(section: dict, key: str, default: str, env: Mapping[str, str], fallback) -> str:
    name = section.get(key, default)
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
        raise ConfigError("凭据引用必须是合法的环境变量名称")
    # 显式空环境变量也是覆盖，不恢复系统中的旧密钥。
    if name in env:
        return env[name].strip()
    return fallback().strip() if _enabled(section) else ""


def _chat_ids(values: object) -> tuple[str, ...]:
    if not isinstance(values, list):
        raise ConfigError("telegram.chat_ids 必须是数组")
    result = []
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            raise ConfigError("接收人必须是 Telegram 数字 chat_id")
        value = str(value).strip()
        if not re.fullmatch(r"-?[1-9][0-9]*", value):
            raise ConfigError("接收人必须是非零 Telegram 数字 chat_id")
        if value not in result:
            result.append(value)
    return tuple(result)


def load_config(path: Path, *, required: bool = False,
                env: Mapping[str, str] | None = None) -> Config:
    env = os.environ if env is None else env
    data = {}
    try:
        with path.open(encoding="utf-8-sig") as stream:
            data = json.load(stream)
    except FileNotFoundError:
        if required:
            raise ConfigError("指定的配置文件不存在") from None
    except (OSError, UnicodeError, ValueError):
        raise ConfigError("配置文件无法读取或不是合法的 UTF-8 JSON") from None
    return parse_config(data, path, env=env)


def parse_config(data: dict, path: Path, *, env: Mapping[str, str] | None = None,
                 bundle_loader=None) -> Config:
    env = os.environ if env is None else env
    data = _keys(data, {"version", "telegram", "feishu", "credentials"}, "配置")
    reference = data.get("credentials")
    if reference is not None:
        reference = _keys(reference, {"backend", "id"}, "credentials")
        if reference.get("backend") != "system":
            raise ConfigError("不支持的凭据后端")
        credentials.validate_id(reference.get("id"))
    cached = None

    def stored(name):
        nonlocal cached
        if reference is None:
            return ""
        if cached is None:
            loader = bundle_loader or credentials.load_bundle
            cached = loader(path, reference["id"])
        return cached.get(name, "")
    version = data.get("version", 1)
    if type(version) is not int or version != 1:
        raise ConfigError("不支持的配置版本")
    tg = _keys(data.get("telegram", {}), {"enabled", "chat_ids", "token_env"}, "telegram")
    fs = _keys(data.get("feishu", {}), {"enabled", "webhook_env", "secret_env"}, "feishu")
    chat_values = tg.get("chat_ids", [])
    if "TELEGRAM_CHAT_ID" in env or "TELEGRAM_CHAT_IDS" in env:
        chat_values = [value.strip() for value in
                       (env.get("TELEGRAM_CHAT_ID", "") + "," + env.get("TELEGRAM_CHAT_IDS", "")).split(",")
                       if value.strip()]
    token = _secret(tg, "token_env", "TELEGRAM_BOT_TOKEN", env, lambda: stored("telegram_token"))
    if token and not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token):
        raise ConfigError("Telegram Token 格式无效")
    webhook = _secret(fs, "webhook_env", "FEISHU_WEBHOOK", env, lambda: stored("feishu_webhook"))
    if webhook:
        url = urlparse(webhook)
        if (url.scheme != "https" or url.netloc != "open.feishu.cn"
                or not url.path.startswith("/open-apis/bot/v2/hook/")
                or not url.path.removeprefix("/open-apis/bot/v2/hook/")
                or url.query or url.fragment):
            raise ConfigError("飞书 webhook 必须是 open.feishu.cn 的 HTTPS 自定义机器人地址")
    return Config(
        TelegramConfig(token, _chat_ids(chat_values), _enabled(tg)),
        FeishuConfig(webhook, _secret(fs, "secret_env", "FEISHU_SECRET", env,
            lambda: stored("feishu_secret")), _enabled(fs)),
    )


def create_config(path: Path) -> None:
    """只创建模板，排他写入，永不覆盖已存在的用户配置。"""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(EXAMPLE, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
