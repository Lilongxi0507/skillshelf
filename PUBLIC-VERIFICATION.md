# SkillShelf 0.2.0-preview.1 验证与发布记录

截至 2026-09-24，**发布未完成：7/10 个包已发布并核验**。余下发布受到 npm 注册表 `429 Too Many Requests` 限制；等待约 5 分钟后仅重试缺失包，仍返回相同错误。CLI 错误未显示恢复时间；本次没有保存 429 的原始响应头，无法确认具体限流规则。CLI 和目录的公共 `next` 仍指向 `0.1.0-preview.2`。

账号身份复核与信任配置读写成功。npm 客户端将 HTTP 状态直接转换为 `E429`；`user undefined` 不能单独证明登录失效，也不能据此确定每天的发布额度。官方仓库的[相同问题记录](https://github.com/npm/cli/issues/9313)也未给出可确认的额度或恢复时间。

## 冻结候选与 CI

- 代码提交：[`bba4656`](https://github.com/Lilongxi0507/skillshelf/commit/bba46567f0da9a38cedcc9325bd388087f57cb79)。后续状态文档不改变此候选的包字节。
- [候选 CI 35964196995](https://github.com/Lilongxi0507/skillshelf/actions/runs/35964196995)：打包作业与六组原生平台作业全部成功；各平台下载、审计并安装同一组真实 tarball。
- 10 个候选包的逐文件清单、SHA-512、目录与 CLI 审计通过；技能内容仍是 8 个完整套件、83 个子技能。
- 修复：草稿创作、任务组合与 MCP 定义首次写入时，先初始化 SkillShelf 私有目录，避免 Windows ACL 继承导致后续入库失败。既有不合规目录仍拒绝自动改权限。

| 平台 | Node 22 | Node 24 | 补充证据 |
| --- | --- | --- | --- |
| Linux | 161 通过 / 0 失败 / 1 跳过 | 161 通过 / 0 失败 / 1 跳过 | 40/80/120 列 POSIX PTY、无颜色、取消、实际包安装 |
| macOS | 161 通过 / 0 失败 / 1 跳过 | 161 通过 / 0 失败 / 1 跳过 | 同上，原生 macOS Runner |
| Windows | 125 通过 / 0 失败 / 37 跳过 | 125 通过 / 0 失败 / 37 跳过 | 原生 CLI、NTFS ACL、链接/副本、安装与中断恢复 |

Windows 跳过项主要依赖 POSIX 权限或模拟可执行文件；不将其标为通过。POSIX PTY 不代表 Windows 交互终端验收。

## 公共 npm 进度

所有目标版本均为 `0.2.0-preview.1`，标签为 `next`，scope 为 `@llx17669475`。

| 包 | 状态 |
| --- | --- |
| `skillshelf-pack-taste` | 已发布；公共 tarball SHA-512 匹配 |
| `skillshelf-pack-ui-ux-pro-max` | 已发布；公共 tarball SHA-512 匹配 |
| `skillshelf-pack-skillshelf-web-search` | 已发布；公共 tarball SHA-512 匹配 |
| `skillshelf-pack-skillshelf-media-generation` | 已发布；公共 tarball SHA-512 匹配 |
| `skillshelf-pack-archify` | 已发布；公共 tarball SHA-512 匹配 |
| `skillshelf-pack-matt-pocock` | 已发布；公共 tarball SHA-512 匹配 |
| `skillshelf-pack-superpowers` | 已发布；公共 tarball SHA-512 匹配 |
| `skillshelf-pack-gitnexus` | npm 429 拒绝；精确版本尚不存在 |
| `skillshelf-catalog` | 待完整套件发布后提交 |
| `skillshelf` | 待目录发布后提交 |

新包必须先存在于 registry 才能配置 npm Trusted Publishing，因此前 7 个新套件使用官方浏览器 2FA 首次发布，其新版本没有 OIDC provenance。它们随后已绑定并回读确认 `Lilongxi0507/skillshelf` 的 `publish.yml`；CLI 与目录的既有绑定也已确认。GitNexus 仍需首次发布与单独绑定。

已发布版本不可覆盖，不重新打包后复用同一版本。恢复时先核对已存在版本的公共字节，仅处理缺失包。CLI/目录计划通过手动 OIDC 工作流发布；本次尚未触发该工作流，也未执行新版公共 npm 安装 smoke。

## 验证边界与后续步骤

1. 注册表允许发布后，提交原冻结 GitNexus tarball并配置其 Trusted Publisher。
2. 核对 10 个包的绑定，再从审定源码手动触发 `publish.yml`；已有 7 个确切版本必须按原摘要跳过。
3. 回读所有包的确切版本、`next`、下载 SHA-512 和 provenance 状态，再运行 `public-smoke.yml` 的六组公共安装测试。
4. 完整通过后才更新为“已发布”。本次没有升级用户本机 CLI、共享库或 Agent 配置。

各 Agent 实际加载、Windows 交互终端矩阵、两个 Agent 的真实外部 MCP 会话与付费服务调用不因 CI 或包审计视为已通过。当前 MCP 管理提供中央定义、诊断和原生配置预览；原生配置自动写入不在本候选已验证能力中。

复现步骤见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [docs/release.md](docs/release.md)。
