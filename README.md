# dev-notify

跨平台开发任务通知工具，使用 **TypeScript / Node.js**，通过 npm 分发，无需 Python 或独立可执行文件。通用通知不依赖 Claude Code、Unity 或项目目录。

**当前为未发布的 `0.1.0-alpha.1`，`private: true` 防止误发布。npm 包名尚未核定，请勿安装未经确认的同名公开包。**

## 安装与使用

要求 Node.js 22 或以上，首发目标 Windows、macOS。运行时依赖锁定版本的 `@napi-rs/keyring`，由 npm 安装对应系统的预编译原生组件，不需要 Python、Rust 或 C++ 编译器。不要省略 npm optional 依赖。

在工程目录执行：

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

正式包的安装/升级/卸载由 npm 负责。**卸载程序不会自动清除用户凭据**；如需清理，请先交互执行 `dev-notify credentials clear`，再卸载。该命令只删除当前配置引用的 Node 凭据，不删除其他账号、其他配置或 Python 原型凭据。

## 已提供的功能

- Telegram、飞书双渠道通知，按渲染后的长度分段，不静默截断。
- 文本、严格 UTF-8 文件或标准输入；支持渠道选择、通知级别、辅助信息。
- 交互配置、隐藏输入、系统凭据存储、环境变量覆盖。
- 配置更新冲突检测、失败恢复、凭据清理。
- 可选测试通知：只有额外确认后才发送，默认不发送。
- `paths`、`doctor`、`status`、`send --dry-run` 离线诊断。

**交付范围是“安装 → 配置 → 存储凭据 → 发送 → 清理凭据”的通用通知链路。**当前不安装应用 hooks、不启动后台服务、不做远程控制。`integration list` 仅报告集成未启用；Claude Code 回复、自动配对、任务队列不属于本版已实现能力。

## 配置向导

```sh
node dist/cli.js setup
```

1. 选择 Telegram、飞书或两者。
2. 隐藏输入 Token、webhook 和可选签名密钥。无法安全隐藏输入时停止，不回退到明文回显。
3. Telegram 手动填写数字 chat_id，多个用逗号分隔；用户需要先启动 Bot。不会自动启动 getUpdates 配对。
4. 展示渠道和接收人数，最终确认后保存。输入错误可以重试，Ctrl+C 取消。
5. 保存后单独询问是否发送固定内容的测试通知。测试失败不会撤销已成功保存的配置。

编辑已有配置需要先确认；密钥留空保留已存值，可选签名输入 `-` 清除。未选渠道会禁用，新条目只保留所选渠道的凭据。环境变量仍然优先；向导会提示存在覆盖，测试使用最终生效值，而不是忽略环境的刚输入值。

自动化使用无密钥模板和 CI secrets：

```sh
node dist/cli.js setup --template --yes
```

模板永不覆盖已有配置。`--yes` 只能配合 `--template`，不能跳过交互密钥保存确认。

## 系统凭据与兼容性

Node 版使用 **Windows Credential Manager / macOS Keychain**，通过原生 Node API 传递秘密，不调用 Python，不将秘密放进命令行参数，不写入明文 JSON。

- 底层库：`@napi-rs/keyring`，固定版本记录于 lockfile。
- service：`dev-notify.node.credentials.v1`；account：随机 32 位十六进制 ID。
- 配置引用：`"credentials": {"backend":"keyring","id":"..."}`。
- 为兼容 Windows 通用凭据 blob 大小，凭据包限制 2400 UTF-8 字节，超限报错，不截断。
- 原生组件加载失败、存储锁定或拒绝访问时明确报错，不降级为明文文件。macOS 可能要求系统授权；离线不代表一定无系统提示。
- 默认不枚举系统条目，只访问当前引用或本次新建的随机条目。

保留的 Python 原型使用 `backend: "system"`，Windows 是 DPAPI 文件，与 Node Credential Manager 不是同一存储。Node 不会读取或删除它。遇到旧配置可运行 `setup` 重新输入生成 Node 引用；原 Python 凭据保持不变。不要用 Python 原型编辑 Node 的 `keyring` 配置。

Python 源码及测试仍在 `src/dev_notify/`、`tests/`、`tools/`，本轮没有删除。历史文档位于 `docs/PYTHON_PROTOTYPE.md`、`docs/PYTHON_SECURITY.md`，不进入 npm 包。

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

- `TELEGRAM_BOT_TOKEN`：Token。
- `TELEGRAM_CHAT_ID`、`TELEGRAM_CHAT_IDS`：主接收人和逗号分隔接收人，任一显式存在即完全替换文件名单；显式空名单撤销接收人。大整数 chat_id 必须用字符串。
- `FEISHU_WEBHOOK`：飞书中国站 HTTPS 自定义机器人地址。
- `FEISHU_SECRET`：可选签名密钥。

凭据环境变量显式存在时优先，包括空值；不存在才延迟读取系统引用，同次配置加载只读取一次。禁用渠道不会仅为读取系统秘密而打开后端。Token/webhook/secret 不能直接填写进 JSON。

## 更新与清理安全

保存流程：写入新随机系统条目 → 校验可读 → 原子替换 JSON → 删除旧 Node 条目。配置切换前失败保留旧配置，并尝试清理本次新凭据；清理失败只报告非敏感引用 ID。旧 Python 条目从不删除。

配置写入使用排他 `.setup.lock`，写前及切换前核对原文件。不要在向导保存时用编辑器并发改配置；编辑器不遵守此锁。断电/强杀可能留下锁或孤立条目，存储和 JSON 不是跨系统原子事务。确认没有向导运行后才能处理残留锁；程序不会擅自扫描并删除不明条目。

```sh
node dist/cli.js credentials clear
```

清理必须交互确认，先去除当前 JSON 引用，再尝试删除其 Node 条目；环境变量保持不变。共享同一旧引用的配置副本也会受影响，操作前会告知。删除失败明确警告，不伪装成已清理。

## 格式、发送与退出码

支持标题、粗体、斜体、删除线、行内代码、代码块、引用、列表、任务列表、等宽表格。Telegram 按 UTF-16 长度，飞书按 UTF-8 请求预算分段，emoji 不从代理对中切开。跨段标签补齐，标题 `(1/N)`，每段保留辅助信息。链接显示为“文字 (URL)”，纯文本回退保留地址。不是完整 CommonMark 引擎，复杂转义或嵌套不保证完全原样排版。

单接收人中途失败停止其后续分段，Telegram 继续其他接收人。HTML/卡片格式错误回退；Telegram 明确 `429` 按服务端要求有限重试。超时不盲目重发，不承诺恰好一次投递。

- `send` 会把指定内容上传到第三方，请检查接收人与敏感信息。
- `--dry-run` 不输出正文/凭据，不联网。
- `doctor` / `status` 可能读取本地凭据，不验证网络和实际授权。
- 文件缺失、损坏配置、UTF-8 错误立即报错，不退回发送标题。

| 代码 | 含义 |
| --- | --- |
| 0 | 所选已配置渠道完整发送成功，或配置/只读操作成功 |
| 1 | 部分/全部投递失败；或 doctor/status 没有可用渠道 |
| 2 | 参数、配置、文件或凭据操作错误 |
| 130 | 用户取消 |

向导保存成功后测试通知失败，命令仍以保存成功结束，并明确显示测试失败，两者不混淆。

## 开发与验证

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run
```

`node-src/` 是 TypeScript 源码，`dist/` 是编译输出，`test-js/` 是测试。默认测试只用假凭据和模拟后端/网络；本机原生假条目往返测试需显式设置 `DEV_NOTIFY_NATIVE_TEST=1`，且只在 Windows 启用，使用随机 ID，结束后清理。

npm 发布白名单只有 `dist/*.js`、README、SECURITY、LICENSE 和必需的 package.json；不包含 Python、测试、配置或密文。无 postinstall、自动启动和自写下载脚本；预编译原生依赖由 npm 的平台 optional 包解析，**不应使用 `--omit=optional`**。macOS x64/arm64 和 Windows x64/arm64 预编译包由依赖提供，提供包不等于本项目已实机验收。

本机验证环境为 Windows x64、Node 24。macOS 实机、Node 最低版本、版本管理器切换及公开发布审计仍未验证；不把路径模拟或依赖支持宣称为实机完成。

采用 MIT，见 [LICENSE](LICENSE)。安全边界见 [SECURITY.md](SECURITY.md)。未创建远程仓库、未发布 npm 包。
