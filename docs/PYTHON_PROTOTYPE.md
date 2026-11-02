> 本文仅描述保留的 Python 原型，不代表 Node/npm 主实现能力。

# dev-notify

跨平台开发任务通知与交互工具。**当前为 `0.1.0a1` 源码基础版，不是已发布的一行安装产品。**

通用通知核心不依赖 Claude Code、Unity、任何项目目录或终端注入。首发目标是 Windows 与 macOS；Claude Code 将作为可选应用集成，不是整个产品。

## 当前实现

- `send`：Telegram / 飞书通知，支持文本、UTF-8 文件和标准输入。
- Markdown 转换后分段；长消息不静默截断，每段标注 `(1/N)`。
- Telegram HTML 格式失败回退纯文本、明确限流时有限重试。
- 飞书卡片 markdown 组件回退和分段节流。
- `setup`：交互选择渠道、隐藏输入凭据、配置接收人，最终确认后保存；支持编辑已有配置。
- Windows 用户级 DPAPI / macOS Keychain 凭据后端；环境变量优先，JSON 只记录引用。
- `setup --template --yes`：仅创建无密钥模板，已有文件永不覆盖。
- `paths`、`doctor`、`status`：离线路径与配置诊断。
- Windows/macOS 用户级目录，独立配置；不会读取原工具的 `notify.local.json`、`.claude_notify` 或应用 settings。
- 标准库运行时，无第三方运行依赖；Python 3.10 及以上。

尚未实现：自动获取/配对 Telegram chat_id、Claude Code hooks/远程回复、通知队列、命令包装 `run`、独立可执行文件、一行安装器、升级与卸载。`integration list` 如实显示规划状态，不会安装 hooks。macOS Keychain 原生调用尚待实机验收。

## 从源码运行

在工程目录下运行（macOS 将 `python` 替换为 `python3`）：

```text
python -I -B tools/dev.py --help
python -I -B tools/dev.py paths
python -I -B tools/dev.py setup
python -I -B tools/dev.py doctor
```

`setup` 是交互向导：选择 Telegram/飞书/两者，隐藏输入 Token、webhook 和签名密钥，再输入数字 chat_id。最终确认前不写入配置和凭据，也不联网。输入无效会报错退出，不会保存半成品。

自动化环境使用 `setup --template --yes` 创建无密钥模板，再通过环境变量提供凭据。兼容旧版 `setup --yes`，它仍然只创建模板，绝不自动同意保存凭据。

编辑已有配置时先确认继续，凭据留空保留已存值，可选的飞书签名密钥输入 `-` 清除。只保留本次所选渠道的凭据。旧凭据缺失或不可读取时，向导允许在明确确认后重新输入。系统不支持隐藏输入时停止，不降级为回显密码。

### 可选：安装到自己的虚拟环境

Windows：

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install .
.venv\Scripts\dev-notify --help
```

macOS：

```bash
python3 -m venv .venv
.venv/bin/python -m pip install .
.venv/bin/dev-notify --help
```

构建依赖为 setuptools，pip 可能需要联网安装构建工具。当前项目尚未上传 PyPI；不要使用未经核实的 `pip install dev-notify` 同名包代替本地安装。

## 配置

默认路径：

| 系统 | 配置 | 数据预留目录 |
| --- | --- | --- |
| Windows | `%APPDATA%\DevNotify\config.json` | `%LOCALAPPDATA%\DevNotify\data` |
| macOS | `~/Library/Application Support/DevNotify/config/config.json` | `~/Library/Application Support/DevNotify/data` |

`DEV_NOTIFY_HOME` 可设为绝对路径，将配置和数据放在其 `config/`、`data/` 下。也可使用全局参数 `--config <路径>`（放在子命令之前）。显式指定的文件不存在时返回错误；未指定时允许仅通过环境变量运行。Linux 提供开发辅助路径，尚不在首发验收范围内。

配置模板：

```json
{
  "version": 1,
  "telegram": {
    "enabled": true,
    "chat_ids": [],
    "token_env": "TELEGRAM_BOT_TOKEN"
  },
  "feishu": {
    "enabled": true,
    "webhook_env": "FEISHU_WEBHOOK",
    "secret_env": "FEISHU_SECRET"
  }
}
```

### 凭据

**不支持在 JSON 里直接填写 Token/webhook/secret**。支持两类来源：

1. 环境变量：只要显式存在就优先，包括空值（空值不会恢复系统中的旧凭据）。可用 `*_env` 自定义变量名。
2. 系统凭据：环境变量不存在且渠道启用时，按配置中的引用延迟读取；同次加载只读取一次。

系统后端：

- **Windows**：DPAPI 当前用户保护，不使用机器级保护；配置文件同级 `credentials/<id>.dpapi` 只存密文。不能仅复制到另一个用户或系统后就期待正常解密。
- **macOS**：使用 Security.framework 的 generic password，service 为 `dev-notify.credentials.v1`，account 为随机引用 ID。直接通过原生 API 传递秘密，不经 `security -w` 命令参数或 shell。默认钥匙串可能在向导期间要求授权；普通读取禁止交互提示，钥匙串锁定或未授权时明确报错。

向导生成的 JSON 会增加如下引用（ID 由程序生成，不是密钥）：

```json
"credentials": {"backend": "system", "id": "32位随机十六进制标识"}
```

`doctor`/`status`/`send --dry-run` 可能读取本地系统凭据以检查配置，不发送网络请求，也不显示秘密。凭据引用失效时不静默回退为空配置。原有纯环境变量配置无需迁移，不会打开系统存储。

- `TELEGRAM_BOT_TOKEN`：Bot Token。
- `TELEGRAM_CHAT_ID`：主接收人。
- `TELEGRAM_CHAT_IDS`：逗号分隔的接收人列表。
- `FEISHU_WEBHOOK`：飞书中国站自定义机器人 HTTPS 地址。
- `FEISHU_SECRET`：可选签名密钥。

任一接收人环境变量显式存在时，完整替换文件中的 `chat_ids`，不合并旧名单；两个环境变量之间去重。显式空名单撤销接收人。仅支持数字 chat_id；通用发送可以发到已授权的群，这不代表未来远程回复会向群开放。

请使用向导的隐藏输入或 CI secret 配置来提供凭据，避免将真实 Token 写进命令历史、仓库或截图。系统凭据存储防护的是落盘秘密，并不防御当前用户下已被控制的进程；秘密使用时会进入进程内存。

### 写入失败与恢复

向导先写入独立的新凭据条目并验证可读，再原子替换 JSON；切换前失败会保留旧配置，并尝试清理本次新条目。成功切换后删除旧引用条目，因此共享同一引用 ID 的配置副本也需要更新。删除旧条目失败会明确警告并输出非敏感 ID，不把配置更新误报为失败。

配置写入使用排他 `.setup.lock`，并在写前和切换前核对配置内容；不与其他向导并发覆盖。外部编辑器不遵守此锁，配置期间仍应避免手动编辑。强制结束或断电可能留下锁或孤立的加密凭据；程序不会擅自删除无法确认归属的数据。确认没有运行中的向导后才可清理残留锁；失败清理会报告需要人工处理的凭据 ID。

凭据存储与 JSON 并非跨系统原子事务，不承诺断电时完全无残留。当前没有自动清理所有孤立凭据或系统级卸载功能。

## 发送

以下命令中的 `dev-notify` 指虚拟环境内已安装的入口；源码运行时可以替换为 `python -I -B tools/dev.py`。

```text
dev-notify send --title "构建完成" --content "安装包已生成"
dev-notify send --channel telegram --title "测试结果" --content-file result.txt
dev-notify send --title "任务输出" --stdin
dev-notify send --title "预览分段" --content-file result.txt --dry-run
dev-notify --config /absolute/path/config.json doctor
```

- `send` 非 dry-run 会把正文发送到第三方平台；请检查接收人和内容敏感性。
- `--content`、`--content-file`、`--stdin` 互斥；未指定正文时使用标题。
- 文件不存在或 UTF-8 解码失败立即报错，不退回发送标题。
- `--channel all` 默认选择全部配置齐全且启用的渠道，配置不完整的渠道不参与。
- 显式指定的渠道未配置时返回错误。
- `--dry-run` 只显示接收目标数量、预计请求数，不输出正文/凭据，不联网。
- `doctor` 只检查配置结构和是否齐全，不验证实际 Token、网络或接收人授权。

### 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 所有选中的已配置渠道完整发送成功，或只读/初始化命令成功 |
| 1 | 投递失败或部分成功；doctor/status 无可用渠道也返回 1 |
| 2 | 参数、配置、输入文件错误，或无可发送渠道 |
| 130 | 用户取消 |

与原项目工具不同，独立 CLI 不以“任一渠道成功”掩盖其他已选渠道的失败。失败输出只显示安全摘要，不输出 URL、Token、服务端原始正文或通知正文。

### 分段限制

优先按段落、行、空白拆分；Telegram 按渲染后 UTF-16 长度计数，跨段标签闭合重开。飞书表格转为等宽代码块，跨段代码围栏、行内代码及粗体补齐。单个超长链接可能退为文本和地址。过长标题/辅助信息或无法安全分段的内容返回错误，不静默截断。

当前同步发送；极长通知需要等待。网络超时可能意味着服务端已发送但客户端没有收到响应，不承诺绝不重复，也不自动无限重试。Telegram 单个接收人中途失败时停止其后续分段，但继续其他接收人；飞书中途失败停止后续卡片。

## 测试

```text
python -I -B tools/test.py
```

测试使用假凭据、临时目录与模拟网络/Keychain，不访问已有真实配置或系统密钥，不发送消息或注入终端。Windows 上另外执行假密钥的原生 DPAPI 内存往返验证；macOS Keychain 目前仅有模拟接口测试，不能代替真实 macOS 权限和安装验收。

## 后续里程碑

1. 已实现：独立包、通用 CLI、双渠道和跨平台路径。
2. 已实现：系统凭据后端与交互配置向导；待完成 macOS 原生验收、自动接收人配对及可逆应用集成安装。
3. 通知队列和可选 Claude Code 回复桥接；按平台明确终端支持范围。
4. Windows x64、macOS arm64/x64 独立构建，一行安装、校验、升级与卸载。
5. 真实平台验收、签名/公证、安全扫描后发布。

没有 GitHub 仓库地址前不提供占位下载地址或可执行的伪安装命令。项目名暂未核对注册可用性。

## 开源

MIT，见 [LICENSE](LICENSE)。安全边界见 [SECURITY.md](SECURITY.md)。公开前需要核对源码权属、第三方声明以及整个待发布目录/历史，当前工作副本并未自动初始化 Git 或发布。
