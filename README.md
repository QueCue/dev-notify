# dev-notify

简体中文 | [English](README.en.md)

通过 **Telegram 和飞书**接收任务通知；配合 Claude Code，可远程回复会话、回答选择题，并在单独授权后逐次确认工具权限。

- npm 包：`@quecue/dev-notify`
- 源码：[QueCue/dev-notify](https://github.com/QueCue/dev-notify)
- 版本与升级说明：[CHANGELOG.md](CHANGELOG.md)
- 安全与隐私：[SECURITY.md](SECURITY.md)

通用通知不依赖 Claude Code。通讯依赖 [QueCue/notify-core](https://github.com/QueCue/notify-core) 由 npm 自动安装，无需另行安装。

## 安装与快速开始

要求 **Node.js 22 或以上**，支持 Windows、macOS。请保留 npm 的 optional 依赖，不要使用 `--omit=optional`；系统凭据组件由 npm 安装。

```sh
npm install -g @quecue/dev-notify
dev-notify --version
dev-notify setup
```

向导会引导你选择渠道、填写凭据和接收人，并在保存前汇总确认：

1. Telegram：准备 Bot Token，先向 Bot 发送消息，再选择接收人或手动填写数字 chat_id。多个接收人用逗号分隔。
2. 飞书：填写中国站自定义机器人的 Webhook，可选填签名密钥。
3. 密钥隐藏输入、不回显；终端无法隐藏输入时会停止。
4. 确认后默认发送一条测试通知，并安装 Claude Code 通知 hooks；可分别用 `--no-test`、`--no-hooks` 跳过。
5. 已有配置可再次运行 `setup` 编辑，密钥留空保留，选填签名输入 `-` 清除。

凭据保存到 Windows Credential Manager／macOS Keychain，不明文写入配置。系统可能弹出凭据访问授权；失败时不会自动降级为明文存储。

```sh
dev-notify send --title "构建完成" --content "安装包已生成"
dev-notify send --title "测试结果" --content-file result.txt
dev-notify send --title "任务输出" --stdin
dev-notify send --title "分段预览" --content-file result.txt --dry-run
```

支持 `--channel telegram|feishu|all`、`--level info|success|warn|error`、`--footer`。文件必须是 UTF-8。`--dry-run` 不联网，也不输出正文或凭据。

## 升级与测试版

```sh
dev-notify update           # 检查并确认升级
dev-notify update --yes     # 跳过升级确认
dev-notify update --check   # 只检查
dev-notify update --no-post # 仅更新包，跳过 hooks/桥接维护
```

`update` 会维护绑定当前配置的现有 Claude Code hooks，并恢复或重启已授权的回复桥接；即使版本已最新，也会执行维护。已有凭据和有效回复授权无需重新配置。自定义配置请继续传入 `--config <路径>`。

若 npm 更新了另一份 Node/npm 安装，命令会报告入口不匹配，不会从旧入口继续维护。切换 Node 版本后，请从目标 Node 环境重新安装本工具，并更新 hooks。

默认安装使用 npm `latest`；普通 `update` 不会自动转到 `beta`。仅在需要测试版时显式安装：

```sh
npm view @quecue/dev-notify dist-tags
npm install -g @quecue/dev-notify@beta
dev-notify --version
dev-notify update --yes
```

测试版可能不稳定。回到正式版时显式安装 `@quecue/dev-notify@latest`，再执行 `dev-notify update --yes`。

## Claude Code 通知

如果已有渠道配置，可单独管理集成，无需再次输入凭据：

```sh
dev-notify integration claude-code install
dev-notify integration claude-code status
dev-notify integration claude-code remove
```

`install`／`remove` 可加 `--yes` 跳过确认。安装后在 Claude Code `/hooks` 中确认已加载，必要时重启会话。要求 Claude Code 支持命令 hook 的 `command` + `args` 形式及 `async`。

- 默认写入用户级 `~/.claude/settings.json`，对该配置目录下的项目生效；保留其他设置和 hooks。
- 完成通知发送 Claude 提供的最终回复；等待提醒覆盖权限请求和需要输入的事件，不发送思考过程或工具结果。
- 通知底部可含项目路径、会话名称、会话 ID 和结束时间，请确认接收人有权查看。
- 重复安装不累加本工具的 hooks；旧工具、项目级或插件通知可能仍同时生效，需自行确认是否停用。
- 项目或托管策略可能限制 hooks；本工具不会绕过禁用或权限策略。状态检查不等于真实事件已成功执行。
- Claude Code 启动环境可能与手动终端不同。移动安装目录或切换 Node 后，应重新安装 hooks。

## 远程回复与问答

**远程输入需要独立授权，不会因安装通知 hooks 自动开启。**

```sh
dev-notify reply setup
dev-notify reply start
dev-notify reply status
```

只授权可信的 Telegram 私聊用户，且这些用户必须在通知接收人名单中。群成员、飞书卡片查看者不会自动获得输入权。工具权限确认需要在 `reply setup` 中另行选择启用。

### 回复会话

- 点击 Telegram 完成通知上的「💬 回复 Claude」，或直接回复该条消息。
- 飞书的「在 Telegram 回复 Claude」会跳转到对应 Bot；按提示长按消息并选择「回复」后输入。
- 只有桥接就绪且会话身份可核验时才显示按钮；请使用最新通知，旧消息不会自动补上按钮。
- Claude 工作时，普通回复先排队，结束后再尝试提交。5 分钟过期、新的本地输入或目标变化会取消旧任务。
- 单条最多 4000 个 Unicode 字符。换行和控制字符会清理，内容作为一次终端输入提交，不按 Shell 执行。
- 「已排队」「已转发」「Claude 已收到」不同；只有收到匹配的本地输入事件后才确认 Claude 已收到。输入失败或结果未知时不自动重试。

远程输入可以包含 Claude 命令，具有真实控制风险，不是只读功能。回复期间请避免同时在目标终端编辑或切换会话。

### 选择题与工具权限

- 支持实际问题的单选、多选、逐题自定义输入；本机界面仍可操作。
- 单独启用工具权限确认后，可「本次允许」「拒绝」或填写拒绝说明，不提供永久批准规则。
- 超时、撤销授权或无法核验目标时，不默认回答或批准；旧按钮不能处理新问题。
- 答案先显示已登记，再根据 Claude 的实际结果反馈生效、未生效或未知。
- MCP 表单／URL 等未支持的交互需回到本机处理。

### 平台和桥接

- Windows：支持原生 `claude` 控制台；共享控制台中有多个 Claude 进程时拒绝输入。
- macOS：支持前台原生 `claude` 的 tmux／Ghostty。Ghostty 可能需要系统 Automation 授权；拒绝授权时不会转投其他窗口。
- 不支持向 VS Code 集成终端、WSL、SSH 或其他终端自动回退。macOS 原生输入及其他兼容性限制见 [SECURITY.md](SECURITY.md)。
- 桥接是本机后台进程，不监听公网端口，也不配置系统开机自启；后续受支持的事件可以按需启动。
- **同一个 Bot 只能有一个更新消费者**。不同机器的回复桥接请使用不同 Bot，不要并行运行 `reply start` 与 `reply run`。

```sh
dev-notify reply stop    # 停止当前桥接；保留授权，后续事件可重新启动
dev-notify reply disable # 确认后撤销授权并请求停止
dev-notify reply run     # 前台排障；先确认没有其他桥接运行
```

## 配置、语言和环境变量

```sh
dev-notify paths
dev-notify language       # 查看当前语言
dev-notify language zh    # 保存为中文；en 为英文
```

| 平台 | 默认配置 | 数据目录 |
| --- | --- | --- |
| Windows | `%APPDATA%\DevNotify\config.json` | `%LOCALAPPDATA%\DevNotify\data` |
| macOS | `~/Library/Application Support/DevNotify/config/config.json` | `~/Library/Application Support/DevNotify/data` |

使用 `--config <路径>` 指定配置，或将 `DEV_NOTIFY_HOME` 设为绝对路径，配置位于其 `config/config.json`、数据位于 `data/`。`CLAUDE_CONFIG_DIR` 可指定 Claude Code 配置的绝对目录，默认 `~/.claude`。

| 环境变量 | 用途 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_CHAT_ID`／`TELEGRAM_CHAT_IDS` | 单个／逗号分隔的接收人 |
| `FEISHU_WEBHOOK` | 飞书中国站自定义机器人 Webhook |
| `FEISHU_SECRET` | 可选签名密钥 |
| `DEV_NOTIFY_LANG` | 当前环境语言，`zh` 或 `en` |
| `DEV_NOTIFY_HOME` | 本工具配置与数据根目录 |
| `CLAUDE_CONFIG_DIR` | Claude Code 配置目录 |

Windows 还可用 `APPDATA`／`LOCALAPPDATA` 覆盖默认根目录；Linux 辅助路径可用 `XDG_CONFIG_HOME`／`XDG_STATE_HOME`。

凭据和接收人环境变量显式存在时优先，**空值也会覆盖**。接收人变量会完全替换文件名单；两种接收人变量同时存在时合并去重。大整数 chat_id 请用字符串。配置中的 `token_env`、`webhook_env`、`secret_env` 可指定自定义变量名。不要将 Token、Webhook 或签名密钥直接写入 JSON。

语言优先级：`--lang zh|en` > `DEV_NOTIFY_LANG` > 配置 `language` > 默认中文。

自动化可生成不含凭据的模板，模板不会覆盖已有配置：

```sh
dev-notify setup --template --yes
```

### 通知过滤与静默时段

以下配置只影响 Claude Code 的普通通知，不影响通用 `send` 或远程输入授权：

```json
"notifications": {
  "events": {"stop": true, "waiting": false},
  "projects": {"allow": ["/Users/me/work"], "deny": []},
  "quiet_hours": {"start": "22:00", "end": "08:00"}
}
```

省略时默认发送完成和等待通知。项目列表按绝对路径前缀匹配，`deny` 优先；Windows 不区分大小写。静默时段按本机时间计算，可跨午夜；期间不发送普通通知或生成回复按钮，但桥接和交互仍运行，不应依赖静默期间的通知处理权限请求。

### 通知底部模板

```json
"templates": {"footer": "项目：{project}\n结束：{time}\n会话：{session}"}
```

支持 `{project}`、`{topic}`、`{session}`、`{time}`，最多 1000 字符；空字符串隐藏底部。`{time}` 使用本机时间格式 `YYYY-MM-DD HH:mm:ss`，完成通知优先使用 Claude 实际结束时间，读取不到时回退到事件触发时间。只有使用该变量才读取本地会话文件尾部的时间戳，不读取或发送正文。

## 排障

```sh
dev-notify doctor
dev-notify status
dev-notify integration claude-code status
dev-notify reply status
```

`doctor`／`status` 检查本地配置，可能触发系统凭据授权，但不验证网络。桥接显示就绪，也不保证每条通知已经投递成功。

错误提示使用 `[DN-…]` 标识，切换语言不会改变错误码。反馈问题时提供错误码、失败阶段（如有）和发生时间即可，不需要提供密钥或完整配置。常见例子：

| 错误码 | 含义与处理 |
| --- | --- |
| `DN-BRIDGE-CONNECTION-RESET` | 桥接连接被重置，重置来源未知；先运行 `dev-notify reply status` 核对当前状态。 |
| `DN-BRIDGE-START-TIMEOUT` | 等待就绪超时，不能据此认定进程已退出；不要另起消费者或删除锁。 |
| `DN-REPLY-IDENTITY` | 按钮身份查询失败；普通通知仍独立尝试，不等于通知已经送达。 |
| `DN-NOTIFY-INCOMPLETE` | 投递或发送后处理未全部完成；查看渠道和 API 确认段数，不要盲目重发。 |

`reply status` 标注为“保留的失败”的信息不是新的失败事件；若当前已就绪，不要仅凭历史失败重启桥接。

- **没有回复按钮**：确认已授权、桥接就绪、hooks 实际加载，并在目标会话正常提交一次新任务；会话无法核验时不会开放输入。
- **只有一个渠道收到**：检查该次通知的渠道错误。各渠道独立投递；失败消息不会因后来恢复而自动补发。
- **更新后入口不可用**：核对 `dev-notify --version` 和当前 Node 环境，重新安装 hooks；不要仅凭 hooks 条目存在认定可用。
- **权限或锁错误**：先检查目录所有者、访问权限及是否仍有进程运行，不要一律删除锁或用 `sudo`／管理员身份重跑。
- **网络错误**：保留安全错误提示和时间；只读身份查询的有限重试不等于通知发送会自动重试。

本地诊断位于 `<配置文件>.reply-data/`：`notification-diagnostics/` 保存最新通知摘要，`notification-failures/` 保存每会话最近失败，`bridge-failures/` 保存最近的启动／工作进程失败。恢复成功不会清除保留的失败，排障时应核对时间。这些文件不含正文、凭据或收件人，不用于补发；不会自动过期删除，可在停用并确认后随回复状态清理。向他人提供前仍请检查内容，不要共享完整配置、凭据或会话状态。

## 卸载与清理

```sh
dev-notify reply disable
dev-notify integration claude-code remove
dev-notify credentials clear
npm uninstall -g @quecue/dev-notify
```

前几步仅在已启用对应功能、并希望清理时执行。凭据清理需要交互确认，共享同一凭据引用的配置也会受影响；环境变量不受影响。npm 卸载不会自动删除用户配置、凭据或回复历史。

## 格式与退出码

支持常用 Markdown、代码块、列表和表格；长消息自动分段，不保证复杂 Markdown 完全还原。单个接收人发送失败会停止其后续分段，其他接收人仍会尝试。明确的格式拒绝或限流可能触发有界回退；网络结果未知时不盲目重发，不能保证恰好一次投递。

| 代码 | 含义 |
| --- | --- |
| 0 | 所选渠道完整发送成功，或配置／只读操作成功 |
| 1 | 投递或维护未全部成功，或状态检查未就绪 |
| 2 | 参数、配置、文件或凭据操作错误 |
| 130 | 用户取消 |

Claude Code hooks 会报告安全错误，但不以阻止宿主的退出码结束；因此 hook 退出成功不等于通知送达。向导保存与测试通知结果也会分别报告。

## 反馈与贡献

问题反馈：[GitHub Issues](https://github.com/QueCue/dev-notify/issues)。请提供版本、系统和脱敏后的错误，不要提交 Token、Webhook 或消息正文。

源码构建与测试见[贡献指南](https://github.com/QueCue/dev-notify/blob/main/CONTRIBUTING.md)，版本修复记录见 [CHANGELOG.md](CHANGELOG.md)。采用 MIT，见 [LICENSE](LICENSE)；详细安全边界见 [SECURITY.md](SECURITY.md)。
