# 贡献与开发

简体中文 | [English](CONTRIBUTING.en.md)

用户安装和使用见 [README.md](README.md)。本文只面向源码贡献者；版本变更和验证结果记录在 [CHANGELOG.md](CHANGELOG.md)，安全边界见 [SECURITY.md](SECURITY.md)。

## 本地构建

要求 Node.js 22 或以上。从 [QueCue/dev-notify](https://github.com/QueCue/dev-notify) 克隆后，在仓库目录执行：

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js --version
npm test
npm pack --dry-run
```

`node-src/` 是 TypeScript 源码，`dist/` 是编译输出，`test-js/` 是回归测试。源码 CLI 可用 `node dist/cli.js` 代替 README 中的 `dev-notify`，无需全局安装。交互配置和真实发送会改变本机状态或向外部发送内容，应使用独立的测试配置与 Bot，不要意外使用个人凭据。

通讯功能依赖标准 npm 包 [QueCue/notify-core](https://github.com/QueCue/notify-core)，无需检出兄弟仓库。锁文件固定依赖来源和完整性，`npm ci` 精确还原；不要通过复制编译文件或打包依赖副本替代标准依赖。

## 测试要求

- 默认回归使用临时目录、假凭据、模拟网络和系统后端，不向真实 Claude 会话注入输入。
- Windows 原生凭据往返测试需显式设置 `DEV_NOTIFY_NATIVE_TEST=1`，只操作本轮随机 ID 的假条目并清理，不应读取已有凭据。
- 原生输入帮助类的编译/布局测试不等于真实输入验收；模拟 API、终端和权限错误也不能证明所有平台可用。
- 增加故障回归时覆盖成功、明确失败、结果未知及敏感信息不泄漏；输入和消息结果未知时不能盲目重放。
- 用户界面错误码集中维护在 `node-src/error-codes.ts`，翻译由 `i18n.ts` 渲染。既有码不改变含义或随语言变更；新增已确认的失败类别时再新增码，不编码 Token、路径、用户身份或推测根因。未细分的 CLI 校验／凭据失败分别使用 `DN-CONFIG`／`DN-CREDENTIAL`；未知系统异常使用 `DN-UNKNOWN`，不展示原异常。结构化 hook 控制 JSON 与退出码语义保持不变。
- 发布验证结果写入 CHANGELOG，区分自动化、实机确认和未验证项，不把它们添加到用户 README。

## 文档分工

- README：用户安装、配置、操作、限制和必要排障，不放开发过程或版本迭代记录。
- CHANGELOG：按版本记录变更、升级影响及对应验证结果。
- SECURITY：凭据、授权、网络、状态和平台安全边界。
- CONTRIBUTING：构建、测试和贡献约定。
- 中英文文档同步维护；涉及其他仓库时使用对应的公开 GitHub 地址。

## 提交与发行

普通修复先提交并积累到 Unreleased，不把每次修改都变成正式发行。测试版本使用预发行号及非 `latest` 标签；正式发行由维护者明确决定。

发行需同步 `package.json`、`package-lock.json`、`node-src/cli.ts` 的版本及双语 CHANGELOG。构建后使用 `scripts/verify-package.mjs` 核验 npm pack 清单、依赖声明和 SHA512；测试、真实配置、状态、日志及依赖 tarball 不得进入包。

npm 安装包只包含白名单运行文件和用户/安全/版本说明；贡献文档保留在源码仓库。维护者发行步骤见 [npm 发布说明](.github/NPM_PUBLISH.md)。不要覆盖已发布版本或在普通分支推送时发布。
