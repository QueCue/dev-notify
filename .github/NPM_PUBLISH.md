# npm 自动发布

工作流：`.github/workflows/publish-npm.yml`，GitHub Actions 页面显示为 **Publish npm**。

使用 npm Trusted Publishing（OIDC），不配置 `NPM_TOKEN`、`NODE_AUTH_TOKEN`、密码或 OTP secret。工作流由 GitHub 托管 runner 执行，固定 Node.js 24 与 npm 11.21.0；只有发布任务有 `id-token: write`，测试任务没有该权限。

## 一次性 npm 设置

由包维护者登录 npm，打开 `@quecue/dev-notify` 的包设置，在 **Trusted Publisher** 中选择 **GitHub Actions**，填写：

| 字段 | 值 |
| --- | --- |
| GitHub 用户/组织 | `QueCue` |
| 仓库 | `dev-notify` |
| Workflow filename | `publish-npm.yml` |
| GitHub environment | 留空，当前工作流没有配置 environment |

字段区分大小写，工作流字段只填文件名，不填 `.github/workflows/` 路径。

允许该可信发布者直接执行 `npm publish`，同时启用 **Allow npm dist-tag**。直接发布权限不等于标签管理权限；缺少后者时，版本可能已发布，但 `latest` 等标签更新会失败。配置保存时不一定验证字段是否正确；按 npm 当前规则，新的可信发布配置须在创建后的两天内完成首次成功发布，超时需要重新创建配置。

如果 npm 要求浏览器进行 Windows Hello、通行密钥或其他账户二次认证，由维护者在网页中完成。不要把认证材料放入仓库或聊天。

## 首次发布已有的 alpha.3 标签

`v0.1.0-alpha.3` 已经推送，新增工作流不会追溯触发旧标签，也不应删除/重打标签。

1. 将工作流提交到 GitHub 默认分支。
2. 打开仓库 **Actions → Publish npm → Run workflow**。
3. 选择包含此工作流的 `main` 分支，`tag` 填 `v0.1.0-alpha.3`。
4. 本次已确认同时更新 `alpha` 和 `latest`，因此勾选 **update_latest**。
5. 运行任务。只有回归、打包白名单、远端压缩包完整性和目标标签均核验成功，任务才显示发布完成。

手动运行构建的是该工作流运行提交，不是悄悄 checkout 另一提交；这使自动来源证明对应实际构建提交。首次引入 CI 可以仅新增/修改 `.github/` 下的文件，其余所有发布源码必须与既有版本标签相同，工作流会执行差异门禁。若 `main` 已有其他源码或文档修改，任务将拒绝用旧版本标签发布，须先准备新版本和新标签。

## 后续发布

完成版本更新与回归，将 `package.json`、`package-lock.json` 和更新说明提交后，创建并推送与版本完全一致的 `v*` 标签：

- `v0.1.0-alpha.4` → npm `alpha`。
- `v0.1.0-beta.1` → npm `beta`。
- `v0.1.0-rc.1` → npm `rc`。
- `v0.1.0` → npm `latest`。

这里只支持正式版本或 `alpha.N`、`beta.N`、`rc.N`。推普通分支不会自动发布。预发布不会默认覆盖 `latest`；只有维护者手动运行并显式勾选 `update_latest` 才会额外更新它。该操作会改变无标签安装的默认版本，应谨慎使用。

## 失败与重跑

- 版本标签与包版本不符、源码与标签不符、编译/测试失败或包白名单异常：发布前失败，不上传 npm。
- OIDC/权限配置错误：检查 npm 的仓库大小写、工作流文件名、直接发布权限和标签管理权限，不添加 token 绕过。
- npm 查询网络错误：不当作版本不存在，不盲目发布。
- 发布过程失败或结果未知：不自动重发；核验状态后可重新运行工作流。
- 版本已存在：只有远端 SHA-512 与本次已验证包完全一致才跳过重复发布，并继续核验/补全目标标签；不同内容必须使用新版本号，不能覆盖版本。
- Linux CI 不等于 Windows/macOS 实机验收；平台专属测试可能跳过。此前 Windows 双端答题验收记录见 CHANGELOG.md。

实际发布记录以 Actions 日志、步骤摘要和 npm registry 为准。配置文件通过本地检查不等于 GitHub OIDC 发布已验收。

## 官方文档

- https://docs.npmjs.com/trusted-publishers
- https://docs.npmjs.com/generating-provenance-statements
