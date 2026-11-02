"""当前用户目录；计算路径不创建目录、不改变工作目录。"""

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


@dataclass(frozen=True)
class AppPaths:
    config: Path
    data: Path


def app_paths(platform: str | None = None, env: Mapping[str, str] | None = None,
              home: Path | None = None) -> AppPaths:
    platform = platform or sys.platform
    env = os.environ if env is None else env
    if env.get("DEV_NOTIFY_HOME"):
        root = Path(env["DEV_NOTIFY_HOME"]).expanduser()
        if not root.is_absolute():
            raise ValueError("DEV_NOTIFY_HOME 必须是绝对路径")
        return AppPaths(root / "config" / "config.json", root / "data")
    if home is None:
        try:
            home = Path.home()
        except RuntimeError:
            raise ValueError("无法确定用户目录，请设置绝对路径 DEV_NOTIFY_HOME") from None
    if platform == "win32":
        config_root = Path(env.get("APPDATA") or home / "AppData" / "Roaming")
        data_root = Path(env.get("LOCALAPPDATA") or home / "AppData" / "Local")
        return AppPaths(config_root / "DevNotify" / "config.json", data_root / "DevNotify" / "data")
    if platform == "darwin":
        root = home / "Library" / "Application Support" / "DevNotify"
        return AppPaths(root / "config" / "config.json", root / "data")
    # Linux 为开发辅助路径，首发验收范围仍为 Windows/macOS。
    config_root = Path(env.get("XDG_CONFIG_HOME") or home / ".config")
    data_root = Path(env.get("XDG_STATE_HOME") or home / ".local" / "state")
    return AppPaths(config_root / "dev-notify" / "config.json", data_root / "dev-notify")
