# 0.1.0-preview.2 公开验证记录

最近验证日期：2026-09-23（UTC）。发布命名空间为 `@llx17669475`，指定发布标签为 `next`、访问权限为 `public`；验证源码为公开仓库 [`c048be9`](https://github.com/Lilongxi0507/skillshelf/commit/c048be9)。

**18 个 npm 包已通过 GitHub Actions Trusted Publishing 发布，并完成公共 registry 回读。** [发布运行 35893524822](https://github.com/Lilongxi0507/skillshelf/actions/runs/35893524822) 的打包、六组原生作业和 OIDC 发布作业均成功。公共 registry 中 18 个确切版本、`next` 标签和下载 tarball 的 SHA-512 均与发布计划一致；18 个包均带有 npm provenance（SLSA provenance v1）。

## 原生候选验证

发布运行从同一份冻结 bundle 验证 Linux、macOS、Windows 的 Node.js 22/24。Linux 和 macOS 还运行 POSIX terminal smoke；Windows 使用原生权限、`.cmd` 入口和中断恢复测试，POSIX smoke 按平台条件跳过。

| 原生 CI 系统 | Node.js | 结果 |
| --- | ---: | --- |
| Linux | 22 | 通过 |
| Linux | 24 | 通过 |
| macOS | 22 | 通过 |
| macOS | 24 | 通过 |
| Windows | 22 | 通过 |
| Windows | 24 | 通过 |

各平台使用独立测试 home 和目标目录，验证 CLI 版本、目录读取、按需安装、受管 Agent 目标、项目锁、`verify`、更新/回滚和中断恢复；没有写入真实用户 Agent 目录。

## 公共 npm 安装 smoke

[公共 smoke 运行 35918416358](https://github.com/Lilongxi0507/skillshelf/actions/runs/35918416358) 从 npm 安装 `@llx17669475/skillshelf@next`，并在 Linux、macOS、Windows 的 Node.js 22/24 上执行 CLI 版本、目录和核心流程检查；六组作业全部通过。

## 公共 registry 回读

- 16 个技能包先发布，随后是目录包和 CLI 包，共 18 个包身份。
- 每个包的 `0.1.0-preview.2` 元数据、`next` 标签和公开 tarball 均已读取；重新计算的 SHA-512 与 registry `dist.integrity` 一致。
- 每个包的 npm 元数据都暴露了由 GitHub OIDC 产生的 SLSA provenance v1 attestation。
- CLI 从公共 npm 安装后，真实 `skillshelf` bin 返回 `0.1.0-preview.2`。

## 仍未验证，不作通过声明

- 其他操作系统版本、CPU 架构、用户配置和真实用户 Agent 目录没有逐一实测。
- 各 Agent 对技能的原生发现与执行仍需单独验证；路径存在或受管投影成功不等于 Agent 已识别技能。
- Tavily/Brave、图片和视频提供商的真实付费调用、取消与计费结果不属于本次发布 smoke。
- npm provenance 证明发布工作流来源和构建链，不等于技能内容经过安全审计，也不构成操作系统沙箱。

复现步骤见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [docs/release.md](docs/release.md)。测试应使用私有临时目录，不复用真实用户技能库。
