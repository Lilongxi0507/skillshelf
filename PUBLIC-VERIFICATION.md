# 0.1.0-preview.1 公开验证记录

验证日期：2026-09-22（UTC）。发布目标为 `@llx17669475`、`next/public`。

**本记录编写时尚未执行 npm 发布。** 以下是实际运行的本地发布门禁，不是 registry 可用性或 GitHub Actions 运行成功的替代证明。发布与 Actions 的最终状态须另行核对并更新。

## 实际验证结果

| 检查 | 环境与结果 |
| --- | --- |
| TypeScript 编译 | 严格 NodeNext ESM 编译通过 |
| 完整 Node 测试 | Linux x64，Node.js **22.20.0：110/110 通过，0 跳过** |
| 完整 Node 测试 | Linux x64，Node.js **26.7.0：110/110 通过，0 跳过** |
| 生命周期测试输入 | 设置独立测试 home、`SKILLSHELF_TEST_TMP` 和实际打包生成的 `SKILLSHELF_TEST_CATALOG` |
| 崩溃恢复 | 真实子进程 SIGKILL、写前日志恢复、目标锁竞争覆盖通过 |
| 真实终端 | POSIX PTY：40/80/120 列 NO_COLOR 和 80 列彩色，共 **4/4 通过**；含 SIGWINCH、取消返回、多选预览且不确认写入 |
| 数据包 | 16 个实际技能 tgz：SHA-512、完整 manifest、逐文件 SHA-256、权限、许可与 NOTICE 校验通过 |
| UI/UX Pro Max 完整性 | **74 个文件、3,580,413 字节**，没有缩减为单页技能 |
| Catalog 包 | 固定 4 个元数据/法律文件，不含技能正文；bootstrap 与本次技能包 SRI 一致 |
| CLI 包 | 实际 npm pack 后审计：**58 个白名单文件、304,085 字节解包大小**；不含技能正文、凭据或 lifecycle hooks |
| 完整发布计划 | 从实际 18 个包生成，固定 scope、确切版本、`next/public`；没有使用 dry-run 的虚拟文件名代替实物 |
| 真正 npm 安装 | 将实际 CLI tgz 以 `--ignore-scripts` 安装到独立 prefix，真实 `skillshelf --version` 返回 `0.1.0-preview.1` |
| 安装后按需读取 | 安装 UI/UX Pro Max 和两个第一方工具并完整 `verify` 通过；无 Agent 原生目录写入 |
| 本地 Python | Python **3.10.12**，两个第一方工具在 `--offline run <id> -- --help` 下实际执行并成功，无 provider 配置或计费请求 |
| 已知依赖漏洞 | `npm audit --omit=dev` 当次 registry 结果：**0 项已知漏洞**；不是未来无漏洞承诺 |

## 首发检查中修复的问题

- 正式命名空间与 `next` 更新渠道统一，拒绝任意其他 scope/tag。
- `run` 透传参数时移除一个 CLI 层的前置 `--` 分隔符，避免 Python 将 `--help` 错当位置参数。新增真实 CLI/Python 回归测试，包含有/无分隔符两种调用；技能正文未因此修改。
- 打包工具增加固定真实 CLI 文件清单、完整目录一致性与拒绝覆盖不同已有产物的检查。

## 仍未验证，不作通过声明

- macOS 和 Windows 的真实设备、ACL、链接/junction/copy、恢复行为；Windows 路径/ACL 纯测试夹具不等于原生验收。
- 各 Agent 对技能的原生发现与执行；路径存在和可投影不等于 Agent 认可。
- Tavily/Brave、图片和视频提供商的真实付费调用、取消与计费结果。测试仅用无收费夹具或本地帮助。
- 首次 GitHub Actions Linux Node.js 22/24 作业，在这份初始记录编写时尚未运行。
- npm registry 的 18 包读回、`next` 标签、下载 SRI 和公开安装，在这份初始记录编写时尚未执行。
- OIDC Trusted Publishing 与 provenance 签名尚未配置；内容摘要校验不是来源签名或执行沙箱。

复现步骤见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [docs/release.md](docs/release.md)。测试应使用私有临时目录，不复用真实用户技能库；发布者必须单独审查公开源码与真实包文件。
