# dev-notify

简体中文 | [English](README.en.md)

通过 **Telegram 和飞书**接收任务通知；配合 Claude Code，可远程回复会话、回答选择题，并在单独授权后逐次确认工具权限。

- npm 包：`@quecue/dev-notify`
- 源码：[QueCue/dev-notify](https://github.com/QueCue/dev-notify)
- 版本与升级说明：[CHANGELOG.md](CHANGELOG.md)
- 安全与隐私：[SECURITY.md](SECURITY.md)

通用通知不依赖 Claude Code。通讯使用标准 npm 依赖 [`@quecue/notify-core`](https://github.com/QueCue/notify-core)（`^0.2.1`），由 npm 自动安装，无需另行安装。

飞书自建应用双向通讯要求 **0.3.0 或以上**。已有 Webhook 通知方式及 Webhook + Telegram 回复路径不变。

## 安装与快速开始

要求 **Node.js 22 或以上**，支持 Windows、macOS。请保留 npm 的 optional 依赖，不要使用 `--omit=optional`；系统凭据组件由 npm 安装。

```sh
npm install -g @quecue/dev-notify
dev-notify --version
dev-notify setup
```

向导会引导你选择渠道、填写凭据和接收人，并在保存前汇总确认：

1. Telegram：准备 Bot Token，先向 Bot 发送消息，再选择接收人或手动填写数字 chat_id。多个接收人用逗号分隔。
2. 飞书：先选择模式。默认 `webhook` 保留中国站自定义机器人的 Webhook 和可选签名密钥，仅单向通知；选择 `app` 则使用自建应用机器人，填写 App ID、App Secret 和接收人的 `open_id`。
3. 凭据（包括应用的 App ID／App Secret）隐藏输入、不回显；终端无法隐藏输入时会停止。
4. 确认后默认发送一条测试通知，并安装 Claude Code 通知 hooks；可分别用 `--no-test`、`--no-hooks` 跳过。
5. 已有配置可再次运行 `setup` 编辑，凭据留空保留，选填签名输入 `-` 清除。

凭据保存到 Windows Credential Manager／macOS Keychain，不明文写入配置；也可使用下文所列环境变量。系统可能弹出凭据访问授权；失败时不会自动降级为明文存储。

### 飞书自建应用准备

仅自建应用机器人支持飞书内远程回复；Webhook 地址和签名密钥不能接收消息。

1. 在飞书开放平台创建自建应用并开启机器人能力。
2. 在“事件与回调”中选择长连接模式，订阅消息事件 `im.message.receive_v1`。
3. 申请发送权限 `im:message:send_as_bot` 和私聊消息接收权限 `im:message.p2p_msg:readonly`。本工具不接受群聊输入，无需为远程回复申请群聊接收权限；具体审批要求以平台为准。
4. 发布应用版本，设置可用范围并确保授权用户在范围内。准备该应用下用户的 `open_id`，不要使用群 chat_id、手机号或其他应用的用户 ID 替代。
5. 运行 `dev-notify setup` 选择飞书 `app` 模式；需要远程输入时，再运行 `dev-notify reply setup` 单独授权。

运行机器需能向外连接飞书服务；WebSocket 接收入站消息、HTTP API 发送／回复，不需要公网入口，也不支持卡片动作回调。

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

`reply setup` 在 Telegram 和飞书应用均可用时提供 **1) Telegram、2) 飞书、3) 两者同时**。选择 `3` 后，分别填写两边要授权的私聊用户，并分别决定是否允许逐次处理工具权限；所选渠道全部填写完成后直接保存，不再追加汇总确认。工具权限仍默认 `N`；用户名单留空可取消，未完成时不保存部分授权。双渠道回复要求 **0.4.0 或以上**；若没有选项 `3`，请先升级。

只授权当前通知名单中的可信用户：Telegram 私聊 chat_id，或飞书应用用户的 `open_id`。两边授权独立，通知接收人、群成员、卡片查看者不会自动获得输入权；工具权限能力也不会从一个渠道继承到另一个。已有单渠道授权保持有效，不会因升级自动扩大授权。

重新授权或切换回复渠道后，先运行 `dev-notify reply stop`，再运行 `dev-notify reply start`，确保旧桥接退出且新授权已加载。

### 回复会话

- Telegram 回复渠道：点击 Telegram 完成通知上的回复按钮，或直接回复该条消息。
- 保留 Webhook + Telegram 路径：飞书通知上的「在 Telegram 回复 Claude」会跳转到对应 Bot；按提示长按消息并选择「回复」后输入。Webhook 本身不能接收回复。
- 飞书回复渠道：在与自建应用机器人的私聊中，**引用（回复）要继续的任务完成通知**并输入文字。不引用通知的普通消息不能用于猜测目标会话；群聊、机器人和非文本消息会被拒绝。
- 飞书完成卡片先显示 **🟡 回复准备中**；消息关联保存成功并经桥接核验后，原卡片改为 **🟢 可回复**。未授权、桥接未就绪等情况显示 **⚪ 不可回复** 并说明原因；通知接收人不会自动获得回复权限。
- 动态状态请使用 **0.3.2 或以上**：桥接定期更新原卡片，可显示 **🔵 工作中·回复将排队**、**🟡 核验暂停**、**⚪ 已过期／会话已关闭／会话已切换**。回复关联最长 24 小时，卡片注明有效期；会话可提前关闭或切换。状态检查通常每 10 秒一轮，批量更新可能稍晚。
- 状态不是永久保证：断网、电脑关机、桥接退出或撤权后，旧卡片可能来不及刷新；以标注有效期和实际核验为准，接收回复时仍会重新核验。升级前的旧通知不会自动补上动态状态。
- 只有桥接就绪且会话身份可核验时才开放回复入口；飞书使用消息引用，不使用卡片动作回调。
- 双渠道共用同一会话的待提交位置：一边已有待处理回复时，另一边不会覆盖或追加一次重复提交；回执发回实际提交的渠道。同一道题或同一次权限决定只采纳先登记的有效回答，另一边随后显示已登记／已处理；多题进度会同步。
- Claude 工作时，普通回复先排队，结束后再尝试提交。5 分钟过期、新的本地输入或目标变化会取消旧任务。
- 单条最多 4000 个 Unicode 字符。换行和控制字符会清理，内容作为一次终端输入提交，不按 Shell 执行。
- 「已排队」「已转发」「Claude 已收到」不同；只有收到匹配的本地输入事件后才确认 Claude 已收到。输入失败或结果未知时不自动重试。

远程输入可以包含 Claude 命令，具有真实控制风险，不是只读功能。回复期间请避免同时在目标终端编辑或切换会话。

### 选择题与工具权限

- 支持实际问题的单选、多选、逐题自定义输入；本机界面仍可操作。
- 飞书答题须引用对应的**题目消息**：单选输入一个编号（如 `2`），多选输入逗号分隔的编号（如 `1,3`），也可按题目提示输入自定义文字。
- 单独启用工具权限确认后，Telegram 可选「本次允许」「拒绝」或填写拒绝说明；飞书须引用对应的**权限消息**，输入 `/allow` 一次允许、`/deny` 拒绝、`/close` 关闭远程处理并交回本机。其他文字仅作为拒绝说明，绝不视为批准；不提供永久批准规则。
- 「通用权限提醒」不能引用作答；请回复包含完整题目与选项或权限指令的交互消息。题目完整投递后会按接收人抑制重复提醒；若异步提醒先到，仍可能看到两条。
- 提示「核验暂停」不代表题目过期；本机会话恢复后，可在有效期内重新引用原题，系统会重新核验，不会自动补交先前失败的答案。
- 超时、撤销授权或无法核验目标时，不默认回答或批准；旧按钮和旧引用不能处理新问题。
- 答案先显示已登记，再根据 Claude 的实际结果反馈生效、未生效或未知。
- MCP 表单／URL 等未支持的交互需回到本机处理。

### 平台和桥接

- Windows：支持原生 `claude` 控制台；共享控制台中有多个 Claude 进程时拒绝输入。
- macOS：支持前台原生 `claude` 的 tmux／Ghostty。Ghostty 可能需要系统 Automation 授权；拒绝授权时不会转投其他窗口。
- 不支持向 VS Code 集成终端、WSL、SSH 或其他终端自动回退。macOS 原生输入及其他兼容性限制见 [SECURITY.md](SECURITY.md)。
- 桥接是本机后台进程，不监听公网端口，也不配置系统开机自启；后续受支持的事件可以按需启动。
- **同一个 Telegram Bot 只能有一个更新消费者；同一个飞书应用只运行一个回复桥接**。飞书多个长连接消费者会分流事件，不是广播，可能导致某台机器收不到回复。不同机器请使用不同 Bot／应用，不要并行运行 `reply start` 与 `reply run`。
- 飞书入站接收与本地处理分离，不会因为消息被接收或入队就确认 Claude 已收到。两渠道的会话核验、排队和平台限制相同，不会因改用飞书而扩展终端支持范围。
- 回复状态可能暂存正文、工具参数和答案，**不是加密存储**。不要共享整个回复状态目录；清理前先禁用并停止桥接，详见 [SECURITY.md](SECURITY.md)。

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
| `FEISHU_SECRET` | Webhook 模式可选签名密钥 |
| `FEISHU_APP_ID`／`FEISHU_APP_SECRET` | 飞书自建应用 App ID／App Secret（`app` 模式） |
| `FEISHU_OPEN_IDS` | 飞书应用接收人的 `open_id`，多个用逗号分隔 |
| `DEV_NOTIFY_LANG` | 当前环境语言，`zh` 或 `en` |
| `DEV_NOTIFY_HOME` | 本工具配置与数据根目录 |
| `CLAUDE_CONFIG_DIR` | Claude Code 配置目录 |

Windows 还可用 `APPDATA`／`LOCALAPPDATA` 覆盖默认根目录；Linux 辅助路径可用 `XDG_CONFIG_HOME`／`XDG_STATE_HOME`。

凭据和接收人环境变量显式存在时优先，**空值也会覆盖**，不会回退旧值。接收人变量会完全替换文件名单；Telegram 的 `TELEGRAM_CHAT_ID` 与 `TELEGRAM_CHAT_IDS` 同时存在时合并去重。大整数 chat_id 请用字符串。飞书 `FEISHU_OPEN_IDS` 完全替换 `feishu.open_ids`，显式空值即空收件人名单，不保留文件中的用户，也不沿用旧授权。

配置中的 `token_env`、`webhook_env`、`secret_env` 以及飞书的 `app_id_env`、`app_secret_env` 可指定自定义凭据变量名。JSON **禁止明文凭据**：不要写入 Token、Webhook、签名密钥、App ID 或 App Secret；向导只保存系统 keyring 引用，自动化配置使用环境变量名。

例如，将下列字段合入配置中的 `feishu` 对象，并在运行环境中设置应用凭据（不要把真实凭据填入此示例）：

```json
"feishu": {
  "mode": "app",
  "app_id_env": "FEISHU_APP_ID",
  "app_secret_env": "FEISHU_APP_SECRET",
  "open_ids": ["ou_example"]
}
```

省略 `feishu.mode` 时仍使用 `webhook`；设置应用凭据不会自动切换模式。收件人配置不等于回复授权，修改后请用同一配置运行 `reply setup` 核对授权。

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

- **没有回复入口**：确认已授权、所选回复渠道正确、桥接就绪、hooks 实际加载，并在目标会话正常提交一次新任务；会话无法核验时不会开放输入。飞书应用模式使用引用消息，不依赖卡片按钮。
- **飞书发出通知但回复无效**：确认 `mode` 为 `app`、`reply setup` 选择了飞书、发件人 `open_id` 已获授权且仍在有效接收人名单中；必须在机器人私聊中引用对应的完成／题目／权限消息并发送文本。Webhook 不能接收回复。
- **飞书收不到入站事件**：核对机器人能力、长连接模式、`im.message.receive_v1`、发送／私聊接收权限、应用版本发布及可用范围；确认应用没有其他消费者分流。运行 `reply status`，不要以再启动一个消费者作为修复。
- **只有一个渠道收到**：检查该次通知的渠道错误。各渠道独立投递；失败消息不会因后来恢复而自动补发。
- **更新后入口不可用**：核对 `dev-notify --version` 和当前 Node 环境，重新安装 hooks；不要仅凭 hooks 条目存在认定可用。
- **权限或锁错误**：先检查目录所有者、访问权限及是否仍有进程运行，不要一律删除锁或用 `sudo`／管理员身份重跑。
- **网络错误**：保留安全错误提示和时间。完成通知的 Telegram 发送仅在确认请求尚未写出（建连失败）时有限重连；请求已写出或结果未知时不会重发。

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

支持常用 Markdown、代码块、列表和表格；长消息自动分段，不保证复杂 Markdown 完全还原。单个接收人发送失败会停止其后续分段，其他接收人仍会尝试。明确的格式拒绝或限流可能触发有界回退；完成通知在确认请求未写出时会有限重连，网络结果未知时不盲目重发，不能保证恰好一次投递。

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
