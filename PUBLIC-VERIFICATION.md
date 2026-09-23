# 0.1.0-preview.1 公开验证记录

最近验证日期：2026-09-23（UTC）。发布目标为 `@llx17669475`、`next/public`；验证源码为公开仓库 [`f6351a1`](https://github.com/Lilongxi0507/skillshelf/commit/f6351a1)。

**六组原生平台 CI 已通过，npm 尚未发布。** [GitHub Actions 运行记录](https://github.com/Lilongxi0507/skillshelf/actions/runs/35818945791)中的生产作业及 Linux、macOS、Windows 上的 Node.js 22/24 作业均为成功。检查时公共 npm registry 尚无计划中的 18 个确切版本；安装命令仍需等待维护者完成官方交互认证、发布与公共 registry 回读。

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

## 首发检查中修复的问题

- 正式命名空间与 `next` 更新渠道统一，拒绝任意其他 scope/tag。
- `run` 透传参数时移除一个 CLI 层的前置 `--` 分隔符，避免 Python 将 `--help` 错当位置参数；Windows Python 子进程固定使用 UTF-8 输出。
- Windows 事务日志按原生文件身份验证，恢复检查不因平台文件标识差异误判；私有目录/文件 ACL 通过原生检查并拒绝过宽授权。
- 打包工具增加固定真实 CLI 文件清单、完整目录一致性与拒绝覆盖不同已有产物的检查。

## 仍未验证，不作通过声明

- 这次记录覆盖 GitHub 托管的原生 CI 环境；其他系统版本、设备和用户配置没有逐一实测。
- 各 Agent 对技能的原生发现与执行；路径存在和受管投影成功不等于 Agent 已识别技能。
- Tavily/Brave、图片和视频提供商的真实付费调用、取消与计费结果；测试仅用无收费夹具或本地帮助。
- npm registry 的 18 包读回、`next` 标签、下载 SRI 和公开安装；它们须在真正发布后验证。
- OIDC Trusted Publishing 与 provenance 签名尚未配置；内容摘要校验不是来源签名或执行沙箱。

复现步骤见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [docs/release.md](docs/release.md)。测试应使用私有临时目录，不复用真实用户技能库；发布者必须单独审查公开源码与真实包文件。
