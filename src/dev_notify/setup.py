"""交互配置向导；确认后写入新凭据，再原子切换不含密钥的配置。"""

import copy
import getpass
import json
import os
import sys
import tempfile
import uuid
import warnings
from pathlib import Path

from .config import ConfigError, EXAMPLE, parse_config
from .credentials import CredentialError, decode_bundle, system_store


def snapshot(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def read_secret(prompt: str) -> str:
    # getpass 无安全输入终端时不得退回回显输入。
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            return getpass.getpass(prompt).strip()
        except getpass.GetPassWarning:
            raise ConfigError("当前终端不支持隐藏输入，请使用交互终端，或通过环境变量配置") from None


def persist(path: Path, data: dict, values: dict[str, str], expected: bytes | None,
            store) -> list[str]:
    """仅清理本次新建条目；旧条目在配置切换成功后才移除。"""
    identifier = uuid.uuid4().hex
    target = copy.deepcopy(data)
    old = data.get("credentials")
    target["credentials"] = {"backend": "system", "id": identifier}
    # 写前验证；不使用环境变量，避免错误输入被当前环境掩盖。
    parse_config(target, path, env={}, bundle_loader=lambda *_: values)
    payload = json.dumps(values, ensure_ascii=False).encode("utf-8")
    decode_bundle(payload)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = path.with_name(path.name + ".setup.lock")
    try:
        lock = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise ConfigError("另一个向导正在写入，或上次异常退出留下 setup.lock；确认没有运行中的向导后再清理锁") from None
    temporary = None
    created = False
    committed = False
    notices = []
    try:
        os.close(lock)
        if snapshot(path) != expected:
            raise ConfigError("配置在向导期间已改变，未覆盖；请重新运行向导")
        store.write(identifier, payload)
        created = True
        # 写入后验证可读取，避免配置引用不可用凭据。
        if decode_bundle(store.read(identifier)) != values:
            raise CredentialError("系统凭据写入校验失败，配置未切换")
        fd, name = tempfile.mkstemp(prefix=".config-", suffix=".tmp", dir=path.parent)
        temporary = Path(name)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(target, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if snapshot(path) != expected:
            raise ConfigError("配置在向导期间已改变，未覆盖；请重新运行向导")
        os.replace(temporary, path)
        committed = True
    finally:
        try:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            if created and not committed:
                try:
                    store.delete(identifier)
                except Exception:
                    # 不泄漏原始异常，只给出可定位的非敏感标识。
                    print(f"警告：配置未切换，但新凭据清理失败；残留引用 ID：{identifier}", file=sys.stderr)
        finally:
            lock_path.unlink(missing_ok=True)
    if old and old.get("id") != identifier:
        try:
            store.delete(old["id"])
        except Exception:
            notices.append("配置已更新，但旧系统凭据未能清理；旧引用 ID：" + old["id"])
    return notices


def wizard(path: Path, *, ask=None, secret=None, store_factory=None) -> bool:
    ask = input if ask is None else ask
    secret = read_secret if secret is None else secret
    store_factory = system_store if store_factory is None else store_factory
    if not sys.stdin.isatty():
        raise ConfigError("配置向导需要交互终端；自动化请使用 setup --template --yes 和环境变量")
    expected = snapshot(path)
    if expected is None:
        data = copy.deepcopy(EXAMPLE)
    else:
        try:
            data = json.loads(expected.decode("utf-8-sig"))
        except (ValueError, UnicodeError):
            raise ConfigError("现有配置无效，未覆盖；请先修复配置文件") from None
    # 先校验结构，不读取系统凭据，不允许损坏配置被隐式重置。
    parse_config(data, path, env={}, bundle_loader=lambda *_: {})
    print(f"配置路径: {path}")
    print("凭据保存到 Windows 用户级 DPAPI 或 macOS Keychain；不写入 JSON。")
    print("不发送测试消息、不安装 hooks、不启用远程回复。")
    print("环境变量若存在会优先覆盖，包括显式空值；向导不会修改环境变量。")
    if expected is not None:
        if ask("已有配置。继续编辑并在最终确认后替换？[y/N] ").strip().lower() not in ("y", "yes"):
            return False
    selection = ask("选择渠道：1 Telegram，2 飞书，3 两者（输入其他内容取消）：").strip()
    if selection not in ("1", "2", "3"):
        return False
    store = store_factory(path, interactive=True)
    previous = {}
    if data.get("credentials"):
        try:
            previous = decode_bundle(store.read(data["credentials"]["id"]))
        except CredentialError:
            print("旧系统凭据无法读取，可能缺失、锁定或不属于当前用户。")
            if ask("放弃读取旧值，重新输入全部所选渠道凭据？[y/N] ").strip().lower() not in ("y", "yes"):
                return False
    target = copy.deepcopy(data)
    target.setdefault("telegram", {})["enabled"] = selection in ("1", "3")
    target.setdefault("feishu", {})["enabled"] = selection in ("2", "3")
    values = {}

    def prompt_value(label: str, field: str, required: bool) -> str:
        existing = previous.get(field, "")
        suffix = "（留空保留已存值）" if existing else ""
        if not required:
            suffix += "（可选，输入 - 清除）"
        value = secret(label + suffix + ": ")
        value = value.strip()
        if value == "-" and not required:
            return ""
        value = value or existing
        if required and not value:
            raise ConfigError("必填凭据为空，未保存；请重新运行向导")
        return value

    if target["telegram"]["enabled"]:
        values["telegram_token"] = prompt_value("Telegram Bot Token", "telegram_token", True)
        existing_ids = target["telegram"].get("chat_ids", [])
        entered = ask("Telegram 数字 chat_id（多个用逗号分隔；留空保留已有名单）：").strip()
        ids = [item.strip() for item in entered.split(",")] if entered else existing_ids
        if not ids:
            raise ConfigError("Telegram 至少需要一个接收人，未保存")
        target["telegram"]["chat_ids"] = ids
    if target["feishu"]["enabled"]:
        values["feishu_webhook"] = prompt_value("飞书 webhook", "feishu_webhook", True)
        values["feishu_secret"] = prompt_value("飞书签名密钥", "feishu_secret", False)
    # 使用临时引用执行完整校验，秘密始终只在内存中。
    preview = copy.deepcopy(target)
    preview["credentials"] = {"backend": "system", "id": "0" * 32}
    parsed = parse_config(preview, path, env={}, bundle_loader=lambda *_: values)
    if parsed.telegram.enabled:
        print(f"Telegram: 接收人 {len(parsed.telegram.chat_ids)} 个，凭据已输入（未联网验证）")
    if parsed.feishu.enabled:
        print("飞书: 凭据已输入（未联网验证）")
    print("将保存配置和新系统凭据；不会保存未选渠道的旧凭据。")
    if data.get("credentials"):
        print("更新成功后删除原凭据条目；引用相同 ID 的配置副本也需同步更新。")
    if ask("确认保存？[y/N] ").strip().lower() not in ("y", "yes"):
        return False
    for notice in persist(path, target, values, expected, store):
        print("警告：" + notice, file=sys.stderr)
    print("已保存。可运行 doctor 离线检查；需要发送时显式使用 send。")
    return True
