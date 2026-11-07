# npm 自动发布

简体中文 | [English](NPM_PUBLISH.en.md)

适用于 [QueCue/dev-notify](https://github.com/QueCue/dev-notify) 的 `.github/workflows/publish-npm.yml`，Actions 名称为 **Publish npm**。这是维护者流程，普通 npm 用户无需配置发布权限。

`@quecue/dev-notify` 已有多个发行版。版本变更见 [CHANGELOG](../CHANGELOG.md)；不要把分支修改当作已经发布，更不能以内容不同的相同版本覆盖 npm。查询实际状态：

```sh
npm view @quecue/dev-notify dist-tags versions --json --registry=https://registry.npmjs.org/
```

## Trusted Publisher 配置

已有正常工作的可信发布配置无需因阅读本文而删除重建。需要首次配置或修复时，由维护者在 npm 的包设置选择 GitHub Actions：

| 字段 | 值 |
| --- | --- |
| GitHub 用户／组织 | `QueCue` |
| 仓库 | `dev-notify` |
| Workflow filename | `publish-npm.yml`，不含目录 |
| GitHub environment | 留空，工作流未指定 environment |

本流程使用 GitHub 托管 runner 和 OIDC，不向仓库存储 `NPM_TOKEN`、密码、OTP 或长期认证 secret。只在发布任务授予 `id-token: write`；固定 Node.js 24 和 npm 11.21.0。此固定版本是工作流选择，不等于所有 npm 用户的最低版本。

发布权限与 **Allow npm dist-tag** 权限独立；本工作流需要后者核对／修正目标标签。npm 官方目前要求新建可信配置在两天内成功首次发布以完成身份绑定；已绑定配置不应当作两天后就失效。账户验证、实际可用选项和规则以 [npm 官方说明](https://docs.npmjs.com/trusted-publishers) 为准。浏览器二次认证由维护者本人完成，不将认证材料写入仓库。

公开包从公开 GitHub 仓库使用受支持的 OIDC 流程发布时可生成 provenance；这不代表包已经安全审计，也不能仅从本地 YAML 检查证明发布身份配置成功。

## 常规新版本

1. 在本仓库执行 `npm ci --ignore-scripts`、`npm test`，并检查变更记录和中英文说明。
2. 选择未发布的新版本，同步更新 package.json／package-lock、`node-src/cli.ts` 的 `VERSION` 和 CHANGELOG。`0.2.2` 已发布；后续依赖范围调整等变更必须使用新版本，不能覆盖历史版本。
3. 将源码、运行时依赖范围、registry 锁文件和发布所需脚本纳入同一版本提交。当前通讯依赖范围为 `^0.1.0`，锁文件仍固定已验证的 `0.1.0`。通讯库源码见 [QueCue/notify-core](https://github.com/QueCue/notify-core)。先确认 `@quecue/notify-core@0.1.0` 已在 npm 可用，再生成并核验锁文件；CI 通过 npm 安装，不读取兄弟仓库或 vendor tarball。
4. 在本地生成并校验候选包：

   ```sh
   node -e "require('node:fs').mkdirSync('build/release-check', {recursive: true})"
   npm pack --ignore-scripts --json --pack-destination build/release-check > build/release-check/pack.json
   node scripts/verify-package.mjs build/release-check/pack.json build/release-check
   ```

   此处 `--ignore-scripts` 是因为前一步 `npm test` 已完成构建；直接使用它不会自动更新陈旧 dist。
5. 维护者确认后提交版本，并创建、推送与 package.json 完全匹配的 `v<版本>` 标签。普通分支推送不触发发布。

映射规则：正式 `vX.Y.Z` → `latest`；`vX.Y.Z-alpha.N` → `alpha`；`beta.N` → `beta`；`rc.N` → `rc`。这里只接受这些格式，文中的占位符不是可以原样执行的标签。

预发布默认不更新 `latest`。手动勾选 `update_latest` 会额外将无标签安装的默认版本指向本次版本，可能包括较旧版本；仅在明确需要且已核实影响时使用，不因首次配置就默认勾选。

## 手动运行或核验重跑

在 Actions → Publish npm → Run workflow 选择含工作流的分支，填写**与该次运行源码和 package.json 一致的已存在标签**。不再默认填旧 alpha 标签。

手动任务构建的是工作流运行提交，而非静默切换到输入标签。与标签相比，仅允许 `.github/` 和 `test-js/` 的非包内容修正；其余源码、脚本、依赖声明、锁文件和文档须与标签一致。若当前分支已有其他变更，使用旧标签会被拒绝，应准备新版本，不能删除或重打历史标签。

整个流程依次进行版本门禁、依赖还原、测试、构建文件清单和 SHA512 校验，随后上传同一个已验证 tarball，再由独立任务发布。`scripts/verify-package.mjs` 同时用于本地和 CI，校验 CLI 文件清单及归档中通讯运行时依赖的兼容范围声明；不能为了通过检查而放开任意 dist 文件。

## 失败与重跑边界

- 标签／源码不符、测试失败、文件清单异常或包完整性不符：发布前停止。
- OIDC／权限错误：核对仓库大小写、工作流名、直接发布及标签权限，不用新增长期 Token 绕过配置错误。
- 查询失败：不当作版本不存在。发布失败或结果未知：不盲目重发。
- npm 接受上传后，版本端点可能延迟可见；工作流最多约 10 分钟只读核验版本完整性，再最多约 1 分钟核对标签。超时可能是已发布但未完成核验，不代表上传失败。
- 相同版本只有远端 SHA512 与本次 tarball 一致时才跳过重复发布并继续核验标签；内容不同必须使用新版本，不能覆盖。
- Linux CI 不代表 Windows／macOS 实机验收，平台特定测试可能跳过。结果范围见 CHANGELOG 与 SECURITY。

是否发布成功以 Actions 摘要及 npm registry 的目标版本、integrity 和 dist-tags 为准。本文和本地测试不会替维护者执行推送或发布。

## 官方参考

- [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
- [Provenance](https://docs.npmjs.com/generating-provenance-statements)
- [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish)
