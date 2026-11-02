"""跨平台 CLI；只有 send（非 dry-run）执行网络发送。"""

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .channels import feishu, telegram
from .config import ConfigError, create_config, load_config
from .models import Message
from .paths import app_paths
from .setup import wizard


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="dev-notify", description="跨平台开发任务通知工具")
    root.add_argument("--version", action="version", version=f"dev-notify {__version__}")
    root.add_argument("--config", type=Path, help="显式配置文件；不存在时不会静默使用默认配置")
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("paths", help="只读显示配置与数据路径")
    setup = commands.add_parser("setup", help="交互配置渠道并安全保存凭据，不修改应用 hooks")
    setup.add_argument("--template", action="store_true", help="仅创建无密钥模板，不打开凭据后端")
    setup.add_argument("--yes", action="store_true", help="确认创建模板；兼容旧版，不自动确认凭据写入")
    commands.add_parser("doctor", help="离线检查配置和能力，不发消息、不创建目录")
    commands.add_parser("status", help="显示当前配置状态，不探测网络")
    integration = commands.add_parser("integration", help="查看应用集成实现状态")
    integration.add_argument("action", choices=("list",))
    send = commands.add_parser("send", help="发送通知；会将正文上传到所选第三方渠道")
    send.add_argument("--title", required=True)
    send.add_argument("--level", choices=("info", "success", "warn", "error"), default="info")
    source = send.add_mutually_exclusive_group()
    source.add_argument("--content", help="正文，不指定时使用标题")
    source.add_argument("--content-file", type=Path, help="UTF-8 正文文件")
    source.add_argument("--stdin", action="store_true", help="从标准输入读取 UTF-8 正文")
    send.add_argument("--footer", default="")
    send.add_argument("--channel", choices=("all", "telegram", "feishu"), default="all")
    send.add_argument("--dry-run", action="store_true", help="只生成分段计划，不联网，不打印正文或凭据")
    return root


def _report(config, config_path: Path) -> int:
    ready = False
    print(f"配置路径: {config_path}")
    print("检查模式: 离线；不验证 Token、网络连通性或接收人授权")
    for name in ("telegram", "feishu"):
        channel = getattr(config, name)
        state = "配置齐全，网络未验证" if channel.configured else "未启用或配置不完整"
        print(f"{name}: {state}")
        ready = ready or channel.configured
    print("凭据来源: 环境变量优先，缺省按配置引用读取系统存储")
    print("系统后端: Windows 用户级 DPAPI / macOS Keychain；不显示凭据值")
    print("应用集成/远程回复/后台队列: 当前基础版未启用")
    if sys.platform not in ("win32", "darwin"):
        print("当前系统不在首发验收范围内（Windows/macOS）")
    return 0 if ready else 1


def _send(args, config) -> int:
    if args.content_file is not None:
        content = args.content_file.read_text(encoding="utf-8-sig")
    elif args.stdin:
        stream = getattr(sys.stdin, "buffer", None)
        content = stream.read().decode("utf-8-sig") if stream is not None else sys.stdin.read()
    else:
        content = args.title if args.content is None else args.content
    message = Message(args.title, content, args.level, args.footer)
    selected = ("telegram", "feishu") if args.channel == "all" else (args.channel,)
    plans = []
    failed = False
    for name in selected:
        channel_config = getattr(config, name)
        if not channel_config.configured:
            if args.channel != "all":
                raise ConfigError("指定渠道未启用或配置不完整")
            continue
        module = telegram if name == "telegram" else feishu
        try:
            plans.append((module, channel_config, module.plan(message, channel_config)))
        except ValueError as error:
            print(f"{name}: 无法生成发送计划：{error}", file=sys.stderr)
            failed = True
    if not plans:
        if not failed:
            raise ConfigError("没有可发送的渠道，请先配置环境凭据和接收人")
        return 1
    for module, channel_config, plan in plans:
        if args.dry_run:
            print(f"{plan.channel}: 接收目标 {plan.recipients}，预计请求 {len(plan.payloads)}；未发送")
            continue
        result = module.send(plan, channel_config)
        print(f"{result.channel}: 已发送 {result.sent}/{result.planned}")
        if not result.ok:
            failed = True
            print(result.error, file=sys.stderr)
    # 独立 CLI 的语义：所有选中的已配置渠道都完整成功才返回 0。
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        paths = app_paths()
        config_path = args.config.expanduser().resolve() if args.config else paths.config
        if args.command == "paths":
            print(json.dumps({"config": str(config_path), "data": str(paths.data)}, ensure_ascii=False, indent=2))
            return 0
        if args.command == "integration":
            print("claude-code: 规划中，尚未接入；未安装 hooks、未启用远程回复")
            return 0
        if args.command == "setup":
            if not args.template and not args.yes:
                if not wizard(config_path):
                    print("已取消，未写入配置或凭据。")
                return 0
            print(f"将创建无密钥配置模板: {config_path}")
            print("不会安装 hooks、启动进程或发送通知。")
            if not args.yes:
                if not sys.stdin.isatty():
                    raise ConfigError("非交互环境请显式使用 setup --yes")
                if input("确认创建？[y/N] ").strip().lower() not in ("y", "yes"):
                    print("已取消")
                    return 0
            create_config(config_path)
            print("已创建。请设置环境凭据和接收人，然后运行 doctor。")
            return 0
        config = load_config(config_path, required=args.config is not None)
        if args.command in ("doctor", "status"):
            return _report(config, config_path)
        return _send(args, config)
    except FileExistsError:
        print("配置已存在，未覆盖。请编辑现有配置或选择其他路径。", file=sys.stderr)
        return 2
    except (ConfigError, ValueError) as error:
        print(f"错误: {error}", file=sys.stderr)
        return 2
    except OSError:
        print("文件操作失败，请检查路径和权限；未发送该输入。", file=sys.stderr)
        return 2
    except (KeyboardInterrupt, EOFError):
        print("已取消。", file=sys.stderr)
        return 130
