# 0.1.0-preview.1 公开验证记录

最近验证日期：2026-09-23（UTC）。发布命名空间为 `@llx17669475`，指定发布标签为 `next`、访问权限为 `public`；冻结源码为公开仓库 [`f5fe8f4`](https://github.com/Lilongxi0507/skillshelf/commit/f5fe8f4)。

**18 个 npm 包已发布并完成公共 registry 回读。** [GitHub Actions 运行记录](https://github.com/Lilongxi0507/skillshelf/actions/runs/35820368322)中的生产作业及 Linux、macOS、Windows 上的 Node.js 22/24 作业均为成功。公开 registry 中全部 18 个确切版本、`next` 标签和下载 tarball 的 SHA-512 与冻结发布计划一致。Linux 的全新公共 npm 安装与核心流程已通过；macOS/Windows 的公共 npm 安装仍待验证。首次发布还自动出现指向预览版的 `latest` 标签，它不代表稳定版。

## 原生平台结果

生产作业在 Linux/Node.js 22 上生成并审计了同一组 **18 个实际 tgz**（16 个完整技能包、1 个目录包、1 个 CLI 包），并将同一份 bundle 交给六组平台作业。CLI tarball 为 **58 个白名单文件、309,492 字节解包大小**。各平台重新校验收到的包及发布计划，再运行适用测试并从该 CLI tarball 安装验证。

| 原生 CI 系统 | Node.js | 测试总数 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Linux | 22 | 118 | 117 | 0 | 1 |
| Linux | 24 | 118 | 117 | 0 | 1 |
| macOS | 22 | 118 | 117 | 0 | 1 |
| macOS | 24 | 118 | 117 | 0 | 1 |
| Windows | 22 | 118 | 84 | 0 | 34 |
| Windows | 24 | 118 | 84 | 0 | 34 |

Linux/macOS 唯一跳过项为 **Windows 原生 ACL** 测试；Windows 跳过的 34 项主要为 POSIX 权限/符号链接或假解释器夹具，另含条件不适用的纯路径夹具及以真实 `.cmd` 安装测试替代的 npm symlink 入口测试，均不能算作通过。Linux/macOS 另行通过 POSIX PTY 终端 smoke；Windows 通过实际打包 CLI 的 PowerShell `.cmd` 入口、私有 ACL、Python 帮助输出及原生中断恢复测试。各平台使用独立测试 home 和实际打包生成的开发目录，验证 CLI 版本、目录读取、按需安装、`verify`、受管 Agent 目标、项目锁与冻结恢复、离线更新/回滚等核心流程；未写入真实用户 Agent 目录。

## 公共 npm 发布与安装

- 16 个技能包先发布，随后是目录包和 CLI 包。逐包读取公共 registry 的确切版本与 `next` 标签，下载公开 tarball，核对 SHA-512 与冻结 `publication-plan.json` 以及原始候选包一致；18/18 均通过。
- Linux 从公共 npm 的 `@llx17669475/skillshelf@next` 全新安装 CLI，执行版本检查、`catalog refresh`、`list`（16 项）、按需安装 `brandkit`、自定义 Agent 受管复制和 `verify`，均通过。该验证使用隔离的 home 与目标目录。
- macOS/Windows 已通过上述候选包的原生 CI；针对公共 npm 下载版本的独立安装与核心流程尚未运行。仓库准备了手动触发的 `public-smoke.yml`，其存在本身不是验收结果。

## 首发检查中修复的问题

- 正式命名空间与 `next` 更新渠道统一，拒绝任意其他 scope/tag。
- `run` 透传参数时移除一个 CLI 层的前置 `--` 分隔符，避免 Python 将 `--help` 错当位置参数；Windows Python 子进程固定使用 UTF-8 输出。
- Windows 事务日志按原生文件身份验证，恢复检查不因平台文件标识差异误判；私有目录/文件 ACL 通过原生检查并拒绝过宽授权。
- 打包工具增加固定真实 CLI 文件清单、完整目录一致性与拒绝覆盖不同已有产物的检查。

## 仍未验证，不作通过声明

- 这次记录覆盖 GitHub 托管的原生 CI 环境；其他系统版本、设备和用户配置没有逐一实测。
- 各 Agent 对技能的原生发现与执行；路径存在和受管投影成功不等于 Agent 已识别技能。
- Tavily/Brave、图片和视频提供商的真实付费调用、取消与计费结果；测试仅用无收费夹具或本地帮助。
- macOS/Windows 的公共 npm 下载、安装与核心流程；目前只有相同候选包的原生 CI 结果。
- OIDC Trusted Publishing 尚未在 npm 为全部目标包配置或用 `publish.yml` 实测；provenance 签名也尚未验证。内容摘要校验不是来源签名或执行沙箱。

复现步骤见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [docs/release.md](docs/release.md)。测试应使用私有临时目录，不复用真实用户技能库；发布者必须单独审查公开源码与真实包文件。
