# dev-notify

跨平台开发任务通知工具，使用 **TypeScript / Node.js**，通过 npm 分发，不需要独立可执行文件或其他脚本运行时。通用通知不依赖 Claude Code、Unity 或项目目录。

**npm 包名为 `@quecue/dev-notify`。`0.1.0-alpha.3` 提供 Claude Code 回复、原生 PC 与 Telegram 双端答题及结果反馈。** 版本变更与升级说明见 [CHANGELOG.md](CHANGELOG.md)；公开版本以 npm registry 为准。

## 安装与使用

要求 Node.js 22 或以上，首发目标 Windows、macOS。运行时依赖锁定版本的 `@napi-rs/keyring`，由 npm 安装对应系统的预编译原生组件，不需要额外的语言工具链或编译器。请保留 npm 的 optional 依赖。

从 npm 安装当前已发布的 Alpha：

```sh
npm install -g @quecue/dev-notify@alpha
dev-notify --version
dev-notify setup
```

也可用环境变量覆盖凭据和接收人：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` / `TELEGRAM_CHAT_IDS`、`FEISHU_WEBHOOK`、`FEISHU_SECRET`；路径变量 `DEV_NOTIFY_HOME`、`CLAUDE_CONFIG_DIR`。显式存在的变量优先，空值也会覆盖；完整规则和自定义变量名见下文「路径、模板和环境变量」。

`0.1.0-alpha.1` 不含 Claude Code hooks；以下回复交互要求 `0.1.0-alpha.3` 或以上。升级后须重新运行 `dev-notify integration claude-code install` 更新完整 hooks，并停止、重新启动已有回复桥接；已有有效授权和通知凭据无需重新配置。使用自定义配置时，继续传入原来的 `--config` 路径。源码开发可在工程目录构建后执行：

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js setup
node dist/cli.js doctor
```

配置完成后发送：

```sh
node dist/cli.js send --title "构建完成" --content "安装包已生成"
node dist/cli.js send --title "测试结果" --content-file result.txt
node dist/cli.js send --title "任务输出" --stdin
node dist/cli.js send --title "分段预览" --content-file result.txt --dry-run
```

若需要本地安装为 `dev-notify` 命令，在构建后运行 `npm install --global .`，之后可执行 `dev-notify setup`、`dev-notify send ...`。这是本地源码安装，不是从公开 registry 安装；本工程不会自动进行全局安装或发布。

正式包的安装、升级和卸载由 npm 负责。**卸载前建议先清理凭据**：npm 卸载不会自动删除用户凭据。请先交互执行 `dev-notify credentials clear`，再卸载。该命令只删除当前配置引用的 Node 凭据，不会动其他账号、其他配置或旧版原型凭据。

## 已提供的功能

- Telegram、飞书双渠道通知，按渲染后的长度分段，不会悄悄截断内容。
- 文本、严格 UTF-8 文件或标准输入；支持渠道选择、通知级别、辅助信息。
- 交互配置、隐藏输入、系统凭据存储、环境变量覆盖。
- 配置更新冲突检测、失败恢复、凭据清理。
- 安装时默认随汇总确认发送测试通知，可用 `--no-test` 跳过；测试失败不会撤销已保存的配置。
- 默认随汇总确认安装 Claude Code 集成：最终回复、等待通知；可用 `--no-hooks` 跳过，支持独立查询和移除。
- 独立授权的 Telegram 按钮回复、直接回复消息、飞书跳转；逐段映射到具体会话。
- 普通回复本地排队、终端提交与 `UserPromptSubmit` 收到确认，状态不混淆。
- `AskUserQuestion` 原始选项、单选/多选、自定义答案，通过官方 hook JSON 直接回传。
- 另外选择启用后，可逐次允许或拒绝工具权限，或填写自定义拒绝说明；不写永久权限规则。
- `paths`、`doctor`、`status`、`send --dry-run` 离线诊断；`reply start/status/stop/disable/run` 管理桥接。

**通用通知不依赖 Claude Code。** npm 安装不会修改其他应用的配置，也不会启动后台服务。通知 hooks 和远程输入是两层独立授权：默认只发送通知，授权后才启用回复桥接。没有自动配对、远程 shell 执行器或系统开机自启。

## 配置向导

```sh
node dist/cli.js setup
```

1. 选择 Telegram、飞书或两者；编辑已有配置时显示当前选择，直接回车保留。
2. Token、webhook 和签名密钥均以隐藏输入读取（不回显）。终端无法安全隐藏输入时，向导会停止，不会改用明文输入。
3. Telegram 手动填写数字 chat_id，多个用逗号分隔；用户需要先启动 Bot。这里不会自动启动 getUpdates 配对。
4. 汇总展示渠道、接收人数、测试通知、Claude Code 用户级设置路径和发送范围，一次确认后保存。输入错误可以重试，Ctrl+C 取消。
5. 确认后默认发送固定内容的测试通知（`--no-test` 跳过）。测试失败不会撤销已成功保存的配置。
6. 确认后默认合并安装 Claude Code 通知 hooks（`--no-hooks` 跳过）。已有集成保持原样，不重复添加。
7. 远程回复授权不在 setup 中询问；Telegram 可用时提示另行运行 `reply setup`，选择具体可信私聊用户并单独确认。

编辑已有配置不再二次询问是否继续；密钥留空保留已存值，可选签名输入 `-` 清除。没有选中的渠道会被禁用，新条目只保留所选渠道的凭据。环境变量仍然优先（`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` / `TELEGRAM_CHAT_IDS`、`FEISHU_WEBHOOK`、`FEISHU_SECRET`）；向导会提示哪些变量正在覆盖配置，测试和最终保存也都使用生效后的值。完整列表见「路径、模板和环境变量」。

自动化使用无密钥模板和 CI secrets：

```sh
node dist/cli.js setup --template --yes
```

需要只保存配置、不发送测试或不安装 hooks 时，使用 `setup --no-test` / `setup --no-hooks`（可组合）。模板不会覆盖已有配置。`--yes` 只能配合 `--template` 使用；保存密钥前仍然需要交互确认。

## Claude Code 通知集成

要求使用支持命令 hook `command` + `args`（无 shell exec 形式）及 `async` 的新版 Claude Code。实际加载情况在 Claude Code 的 `/hooks` 中确认；如果旧版本不支持这些字段，请升级 Claude Code，本工具不会退回不安全的路径拼接方式。

已有通知渠道配置时，无需重新输入凭据：

```sh
dev-notify integration claude-code install
dev-notify integration claude-code status
dev-notify integration claude-code remove
```

源码验证时将上述 `dev-notify` 替换为 `node dist/cli.js`。安装可用 `--config <绝对或相对路径>` 绑定指定通知配置；执行时将其解析为绝对路径并保存到 hook 参数。自定义 `DEV_NOTIFY_HOME` 的使用者应在安装时设置该变量。

- **配置范围**：默认用户级 `~/.claude/settings.json`，设置 `CLAUDE_CONFIG_DIR` 时使用该绝对目录下的 `settings.json`，覆盖该 Claude Code 配置目录下的全部项目。不会扫描或修改每个项目的设置。
- **发送范围**：Stop 直接使用事件的 `last_assistant_message` 转发最终回复；没有正文时会发送明确的完成提示，不会回读可能滞后的 transcript。不会发送思考过程或工具结果。通知底部附带项目绝对路径、会话名称（本地会话注册表可读取时）和会话 ID。启用远程回复后还会发送结构化问题、选项，以及另行授权的工具权限请求参数；它们可能含敏感信息，启用前请检查接收目标。
- **等待提醒**：转发 `permission_prompt`、`elicitation_dialog`、`elicitation_url_dialog`、`agent_needs_input`；忽略 `idle_prompt`、认证成功等其他通知。当前会话最后一项调用为选择题、没有其他未结束调用，且结构化通知已完整投递时，按接收人抑制重复的 `permission_prompt`；飞书会单独核对投递成功及目标。短期保留已结束题目的覆盖状态，以处理迟到提醒；新一轮输入、后续其他工具调用、会话切换或交互有效期结束后不再沿用。没有覆盖到的接收人、只投递了一部分或投递失败、以及无法核验的情况，仍会发送通用提醒；其他通知类型不受影响。Notification 事件本身不包含完整选项，因此不会根据提示文字猜测答案；可靠的选项交互见下节。不支持的 MCP 表单/URL 等请求保留在本机处理。
- **合并与移除**：保留权限、环境变量和其他 hooks；重复安装不会累加。同一用户级设置中的本工具 hooks 会在确认后更新到当前 Node、CLI 和通知配置路径。只移除带本工具标记及匹配参数结构的处理器，不删除设置文件或凭据。
- **与旧工具共存**：旧版、项目级或插件 hooks 不会被自动删除，可能造成重复通知。安装时会提示当前用户级文件中的其他处理器；旧集成需由用户自行确认停用。
- **事件与时序**：安装 Stop、Notification、SessionStart、UserPromptSubmit、SessionEnd、PreToolUse、PermissionRequest、PostToolUse、PostToolUseFailure、PermissionDenied，共 10 类。Notification 异步；其他事件同步登记状态。PreToolUse 只登记调用身份，不发送通知、不等待 Telegram，超时上限 10 秒；PermissionRequest 才等待远程答案。Stop 包含通知发送，可能延迟本地返回；通知/生命周期上限 120 秒。
- **交互与失败**：PermissionRequest hook 上限 360 秒，远程答题窗口 5 分钟；普通交互终端保留原生窗口，由 Claude 仲裁先到的完整答案。hook 保持同步，不会改成 async，也不会模拟按键。没有回答、撤销授权、超时或发送失败时，都不会默认选择。内部错误会把安全摘要输出到 stderr，并以 0 退出；这里不使用会让 Stop 继续的退出码 2。当前已核对 Claude Code 2.1.316 的并行实现；其他版本、后台子任务及特殊宿主需要另行验收，不能据此推断所有宿主都并行。
- **输入边界**：hook stdin 最多 8 MiB，接收超时 15 秒；超限拒绝而非截断。正常长正文沿用双渠道分段。`stop_hook_active: true` 的继续轮次不发送完成通知。
- **加载限制**：安装后在 `/hooks` 检查并按界面确认，必要时重启会话。不会解除 `disableAllHooks`，也不会绕过托管策略。`status` 只检查该用户级文件，不检查运行时加载状态或网络连通性。
- **环境和路径**：异步进程使用 Claude Code 的环境，可能与手动终端不同；环境变量优先规则不变。切换 Node 版本或移动源码/包目录后，应重新运行 `install` 更新固定路径。
- **写入保护**：使用排他 `.dev-notify.lock`、内容快照、同目录临时文件及原子替换；无效 JSON 不会被覆盖。外部编辑器不遵守锁，安装期间请勿并发编辑。强杀或断电可能留下锁或 `.dev-notify-*.tmp`，请确认没有安装进程后再清理。

启用过回复时先运行 `reply disable` 撤销授权并停止桥接，再运行 `integration claude-code remove` 后卸载 npm 包；npm 卸载不会自动移除 hooks。若先卸载了包，需重新安装后移除，或在 `/hooks` 中手动处理对应条目。单独移除 hooks 不会清除通知凭据。

## Claude Code 回复与选项交互

已有渠道配置时，使用以下有限流程（源码使用 `node dist/cli.js` 替换 `dev-notify`）：

```sh
dev-notify integration claude-code install
dev-notify reply setup
dev-notify reply start
dev-notify reply status
```

第一条在确认后更新到本版完整 hooks；缺少生命周期事件、Stop 仍异步、绑定其他配置或用户级 hooks 被禁用时，会拒绝启用或使用回复。普通终端回复还要求实际观察到该会话的 UserPromptSubmit，因此升级中途未登记的旧轮次可能只有通知，下一次正常提交后才开放按钮。第二条**另行授权**具体 Telegram 私聊用户。通知接收人、群聊成员、能看到飞书卡片的人不会自动获得输入权。`reply setup` 默认不授予工具权限批准能力，需要单独选择 Yes。不会自动迁移旧凭据，也不会默认同意权限。

### 普通回复

- 完成通知每段都提供「💬 回复 Claude」，点击后自动进入回复状态；也可直接回复对应 Telegram 消息。飞书按钮跳到同一 Bot 的 Telegram 私聊，并通过一条普通提示清除旧的自动回复目标，不会自动拉起回复框；请长按提示或目标通知并选择「回复」后输入。手动选择的回复目标不会被清除，需要先自行关闭回复栏。通用 `send` 不附带会话回复功能。
- Bot 启动并核验成功、会话可精确定位时才展示按钮；桥接未就绪时仍会发送普通通知，并报告安全错误。请从启用后的新通知进入；旧版消息和新授权前的映射不会被继承。
- 文本清理换行和控制字符后作为**一次**终端输入提交；最多 4000 Unicode 字符，超限会拒绝，不会截断，也不会拆成多个任务。输入可以包含 Claude 命令，效果等同于在本机提交内容，并非只读操作。
- Claude 工作中收到的普通回复先进入本地队列；只在 Stop 后尝试输入，普通回复不会被用来填写工具权限弹窗。排队超过 5 分钟会取消；本地提交新任务会取消尚未注入的队列，不抢占本地输入。
- 「已排队」「已转发」「Claude 已收到回复」是三个不同状态：只有相同会话/进程、匹配文本摘要的 `UserPromptSubmit` 才会发出收到确认。收到确认说明 Claude 已经收到回复，任务完成后还会发送最终通知。确认会发回原 Telegram 私聊，并向已配置飞书发送不含回复原文的收到提示。注入失败或结果未知时，不会自动重试。
- 映射有效期 24 小时；目标必须匹配会话 ID、PID、进程出生标识及 TTY。会话关闭或切换、PID 重用、多个匹配或目标不确定时，会拒绝提交。每个会话只保留一个未确认的远程回复；Telegram update 在处理前登记 offset，崩溃时可能丢失这条更新，但已提交的输入不会被重放。

### 等待选项与自定义输入

- **AskUserQuestion**：展示实际问题和全部选项正文，长内容会分段。单选点击提交；多选逐项选择后提交；每题都有「自定义输入」。多题逐题完成，原始 `questions` 与 `answers` 通过官方 `PermissionRequest.decision.updatedInput` 回传，不会模拟方向键或 Enter。旧题按钮和过期自定义输入不会回答新题。
- **工具权限**：仅在 `reply setup` 另外授权后，展示工具名称/参数及「本次允许」「拒绝」「自定义拒绝说明」。通过 `PermissionRequest` 输出一次性的 allow/deny；自定义说明只用于拒绝反馈，不会变相批准。不会输出 `updatedPermissions`，不会修改默认模式，也不会写入持久规则；相关操作仍受 Claude 的托管和 deny 规则限制。
- **本地按钮不会被完整复刻**：官方明确 `permission_suggestions` 并非本地权限 UI 的完整选项列表，因此这里不会伪造「始终允许」等按钮。MCP Elicitation 表单/URL 等目前只有等待提醒，需要回到本机处理。
- 本机原生界面始终保留。Telegram 提供「关闭远程答题（本机仍可操作）」入口；远程超时或关闭时不会默认作答。Telegram 是选项点击入口，飞书使用跳转链接，不提供飞书回调服务。
- **两阶段反馈**：每次答案提交先报告「已登记，等待确认」；多题必须全部完成才回传。随后以 PostToolUse 的实际答案反馈「答案内容已生效」或「本次提交未生效」。两端同时提交相同答案时，只会确认内容一致，不会声称 Telegram 一定生效。权限允许以工具完成作保守确认；拒绝、取消或工具执行失败无法证明确实采用的远程决定时，会明确报告结果未知。
- **失效与异常**：本机先答后结束远端请求，桥接会尝试把旧选项替换为「已处理／已过期」状态按钮，不再接受答案；编辑失败时也会拒绝旧回调。回传后最多等待 5 分钟确认，缺少结果时反馈「暂时无法确认」，不会重放答案。反馈依赖桥接在线；网络异常、进程被强杀或撤销授权后，反馈可能无法送达。本工具不会为了补发通知而重新授权，也不会无限重发。最终反馈发送前会登记状态，发送失败记为投递未知，防止崩溃后重复发送；若只收到等待提示而没有最终反馈，请检查终端及 reply status。
- **防误投**：PreToolUse 保存 tool_use_id 与输入摘要，PermissionRequest 仅绑定唯一匹配调用；完成事件按 tool_use_id 结束请求。缺关联、同一 prompt 内重复同内容导致歧义、字段被其他 hook 改写或调用已结束时拒绝远程答题，保留本机处理，不猜测目标。

### 平台与后台服务

- **Windows**：原生 `claude` 进程，系统 PowerShell 编译控制台帮助类，核验出生标识后使用 AttachConsole / WriteConsoleInputW，不抢占前台。共享控制台存在另一个 claude 进程时会拒绝。Node 托管的旧 CLI 不在当前可验证输入范围。
- **macOS**：核验前台 claude 进程及精确 TTY，优先 tmux 字面粘贴缓冲区，否则使用 Ghostty AppleScript；文本不会作为 shell 参数执行。系统可能要求辅助功能/Automation 权限，权限被拒绝时不会改投任意窗口。两条适配器已做模拟验证，**尚未做 macOS 实机输入验收**。
- 不支持 VS Code 集成终端、WSL、SSH、其他终端的自动回退；元数据缺失、CLI 升级改变内部会话文件格式时，会拒绝输入，不会扫描 transcript 猜测目标。原生输入与本地活动不是原子操作：回复期间请不要在相同终端手工编辑或切换会话。
- 桥接是本机 Node 后台进程，不监听公网端口，也不设置系统自启动。明确授权后可手动 `reply start`，也可由支持的后续 hook 事件按需启动。24 小时没有 Telegram 更新会退出；连续轮询失败 5 次或遇到 409 冲突会退出，状态中只报告安全摘要。
- 一个 Bot 只能有一个 getUpdates 消费者。请先自行停用旧版桥接和其他机器上的同 Bot 实例；同一用户的本工具会用 Bot 指纹锁互斥，但无法跨机器或约束不遵守锁的程序。本工具不会删除 webhook，也不会强制结束其他进程；多个实例共用会导致冲突和消息丢失。

```sh
dev-notify reply stop       # 请求停止本次桥接，不撤销授权；后续 hook 可再启动
dev-notify reply disable    # 确认后撤销授权并请求停止；彻底关闭用此命令
dev-notify reply run        # 前台诊断启动/网络问题，不与 start 实例并行
```

停止通过实例随机标识的控制文件请求，不会根据旧 PID 强制结束进程。已经开始的系统输入无法撤回。`status` 只反映本地进程和心跳，Telegram 端到端和真实 Claude 仍需另行验收。

授权在 `<通知配置>.reply.json`，消息/会话/offset/队列/交互状态在 `<通知配置>.reply-data/`；Bot 锁在 `paths` 所示 data 目录的 `reply-bots/`。排队回复原文、问题、工具输入和待回传答案会短暂写入本地状态；提交前会移除普通回复原文；结构化交互保留到完成或确认超时，随后清除问题、参数与答案正文，短期保留结果收据和消息 ID，用于反馈及拒绝旧按钮。有效期检查只是逻辑判断，停机后文件不会自动擦除。POSIX 使用 0700/0600，Windows 依赖账号目录 ACL；同一用户的其他进程仍然可以读取。请不要提交、共享或打包这些文件（已加入忽略规则及 npm 白名单）。

强杀可能留下锁；请先确认相应桥接/写入进程已经退出，再手工处理残留锁，不要在进程运行中删除。`reply disable` 不会擅自删除历史状态；需要清除时，请先禁用或停止，确认后手工删除上述专属文件。清理凭据、移除 hooks 和删除回复状态是三项独立操作。

## 系统凭据与兼容性

Node 版使用 **Windows Credential Manager / macOS Keychain**，通过原生 Node API 传递秘密，不将秘密放进命令行参数，不写入明文 JSON。

- 底层库：`@napi-rs/keyring`，固定版本记录于 lockfile。
- service：`dev-notify.node.credentials.v1`；account：随机 32 位十六进制 ID。
- 配置引用：`"credentials": {"backend":"keyring","id":"..."}`。
- 为兼容 Windows 通用凭据 blob 大小，凭据包限制 2400 UTF-8 字节，超限报错，不截断。
- 原生组件加载失败、存储锁定或拒绝访问时会明确报错，不会降级为明文文件。macOS 可能要求系统授权；离线环境仍可能出现系统提示。
- 默认不枚举系统条目，只访问当前引用或本次新建的随机条目。

旧版原型使用 `backend: "system"`，Windows 上是 DPAPI 文件，与 Node Credential Manager 不是同一存储。Node 不会读取或删除它。遇到旧配置时，可以运行 `setup` 重新输入并生成 Node 引用，原凭据保持不变。早期原型的源码、测试和文档已从主分支移除，仍可在 Git 历史中查阅。

## 路径、模板和环境变量

| 平台 | 配置 | 数据预留目录 |
| --- | --- | --- |
| Windows | `%APPDATA%\DevNotify\config.json` | `%LOCALAPPDATA%\DevNotify\data` |
| macOS | `~/Library/Application Support/DevNotify/config/config.json` | `~/Library/Application Support/DevNotify/data` |

`DEV_NOTIFY_HOME` 必须是绝对路径，配置位于其 `config/config.json` 下。也可用 `--config <路径>` 显式指定文件。显式文件缺失时报错；默认文件缺失时允许仅使用环境变量。

```json
{
  "version": 1,
  "telegram": {"enabled": true, "chat_ids": [], "token_env": "TELEGRAM_BOT_TOKEN"},
  "feishu": {"enabled": true, "webhook_env": "FEISHU_WEBHOOK", "secret_env": "FEISHU_SECRET"}
}
```

### 凭据与接收人

- `TELEGRAM_BOT_TOKEN`：Telegram Bot Token。
- `TELEGRAM_CHAT_ID`、`TELEGRAM_CHAT_IDS`：主接收人和逗号分隔接收人，任一显式存在即完全替换文件名单；两者同时存在时合并去重。显式空名单撤销接收人。大整数 chat_id 必须用字符串。
- `FEISHU_WEBHOOK`：飞书中国站 HTTPS 自定义机器人地址。
- `FEISHU_SECRET`：可选签名密钥。
- 配置中的 `token_env`、`webhook_env`、`secret_env` 可把上述变量名改成其他合法的环境变量名。

### 路径

- `DEV_NOTIFY_HOME`：绝对路径，配置位于其 `config/config.json`，数据位于其 `data/`。
- `CLAUDE_CONFIG_DIR`：Claude Code 配置目录的绝对路径，hooks 写入其中的 `settings.json`；未设置时为 `~/.claude`。
- Windows 还可用 `APPDATA`、`LOCALAPPDATA` 覆盖默认配置/数据根目录；Linux 开发辅助路径可用 `XDG_CONFIG_HOME`、`XDG_STATE_HOME`。

凭据环境变量显式存在时优先，包括空值；不存在时才延迟读取系统引用，同次配置加载只读取一次。禁用渠道不会仅为读取系统秘密而打开后端。Token、webhook 和 secret 不能直接写进 JSON。

## 更新与清理安全

保存流程：写入新随机系统条目 → 校验可读 → 原子替换 JSON → 删除旧 Node 条目。配置切换前失败保留旧配置，并尝试清理本次新凭据；清理失败只报告非敏感引用 ID。旧版原型的条目从不删除。

配置写入使用排他 `.setup.lock`，写入前及切换前都会核对原文件。请在向导保存期间避免用编辑器并发修改配置；编辑器不遵守这个锁。断电或强杀可能留下锁或孤立条目，存储和 JSON 也不是跨系统原子事务。确认没有向导运行后，才能处理残留锁；程序不会主动扫描或删除未知条目。

```sh
node dist/cli.js credentials clear
```

清理必须交互确认，先去除当前 JSON 引用，再尝试删除其 Node 条目；环境变量保持不变。共享同一旧引用的配置副本也会受影响，操作前会告知。删除失败会明确警告，不会显示为已清理。

## 格式、发送与退出码

支持标题、粗体、斜体、删除线、行内代码、代码块、引用、列表、任务列表、等宽表格。Telegram 按 UTF-16 长度，飞书按 UTF-8 请求预算分段，emoji 不会从代理对中切开。跨段标签会补齐，标题带 `(1/N)`，每段保留底部信息。链接显示为“文字 (URL)”，纯文本回退时保留地址。这不是完整的 CommonMark 引擎；复杂的转义或嵌套可能无法完全按原样排版。

单接收人中途失败会停止其后续分段，Telegram 继续发送给其他接收人。HTML/卡片格式错误时会回退；Telegram 明确返回 `429` 时，按服务端要求有限重试。超时后不会盲目重发，也无法承诺恰好一次投递。

- `send` 会把指定内容上传到第三方，请检查接收人与敏感信息。
- `--dry-run` 不输出正文/凭据，不联网。
- `doctor` / `status` 可能读取本地凭据，不验证网络和实际授权。
- 文件缺失、配置损坏或 UTF-8 错误会立即报错，不会退回为只发送标题。

| 代码 | 含义 |
| --- | --- |
| 0 | 所选已配置渠道完整发送成功，或配置/只读操作成功 |
| 1 | 部分/全部投递失败；或 doctor/status 没有可用渠道 |
| 2 | 参数、配置、文件或凭据操作错误 |
| 130 | 用户取消 |

向导保存成功后测试通知失败，命令仍以保存成功结束，并明确显示测试失败，两者会清楚区分。保存后取消 hook 配置仍返回 0 并保留渠道；hook 配置出错返回 1，明确提示渠道已保存。集成 `status` 在条目缺失、重复或当前用户级文件禁用 hooks 时返回 1。内部 hook 处理命令始终非阻塞退出，失败通过 stderr 报告。

## 开发与验证

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run
```

`node-src/` 是 TypeScript 源码，`dist/` 是编译输出，`test-js/` 是测试。默认测试只用假凭据和模拟后端/网络；本机原生假条目往返测试需显式设置 `DEV_NOTIFY_NATIVE_TEST=1`，且只在 Windows 启用，使用随机 ID，结束后清理。

npm 发布白名单只有 `dist/*.js`、README、SECURITY、CHANGELOG、LICENSE 和必需的 package.json；不包含测试、配置或密文。没有 postinstall、自动启动或自写下载脚本；预编译原生依赖由 npm 的平台 optional 包解析，**请勿使用 `--omit=optional`**。macOS x64/arm64 和 Windows x64/arm64 预编译包由依赖提供，提供包并不等同于本项目已完成实机验收。

本机验证环境为 Windows x64、Node 24。自动化回归 163 项：162 通过、0 失败、1 项需显式启用的原生凭据测试跳过。覆盖临时 hooks、回复/授权/过期/防重放、单选/多选/自定义、单次权限 JSON、双端竞争、反馈异常及按接收人的重复提醒去重。实际 CLI 子进程完成后台 start → PreToolUse 登记 → PermissionRequest → 假 Bot 按钮 → JSON 答案 → 模拟 PostToolUse → 最终反馈 → 通知去重/后续工具提醒 → stop；该闭环使用模拟网络和进程元数据，不能替代实机输入验证。另由用户在 Windows 原生 Claude Code 2.1.316 与真实 Telegram 完成本机优先、远端优先、多选、自定义、不同答案竞争，以及延迟通用提醒去重的实机验收。隔离编译和测试不会覆盖真实 hooks 引用的 dist；Windows 原生输入帮助类的自动化测试只做编译/布局验证，不会执行真实 Send。macOS 两条终端适配器只有模拟验证；macOS 实机、Node 最低版本、版本管理器切换、工具权限应答实机及完整公开发布审计尚未完成验收。

采用 MIT，见 [LICENSE](LICENSE)。安全边界见 [SECURITY.md](SECURITY.md)。版本更新需单独发布到 npm，GitHub 推送不会自动更新 npm 安装包。
