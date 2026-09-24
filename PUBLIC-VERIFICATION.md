# SkillShelf 0.2.0-preview.1 验证记录

本候选包含 8 个完整技能包、1 个目录包和 1 个 CLI 包，共 10 个 npm 包；预览通道为 `next`。源码与包已准备发布，但本文件在公共 registry 回读完成前不会声称已经发布。

## 已完成

- Linux、Node.js 24：162 项 Node 测试中 160 项通过、2 项按平台条件跳过。
- Linux PTY：40、80、120 列终端、无颜色、取消流程和子技能搜索均通过。
- 实际 CLI tarball：文件清单、编译产物、目录 bootstrap、版本和包审计通过。
- 独立 npm prefix：真实 `skillshelf` bin、版本输出、JSON 列表和核心离线读取通过。
- `npm run validate` 与 `git diff --check` 通过。

## 待完成

- GitHub Actions 将在发布前对同一候选执行 Linux、macOS、Windows 的 Node.js 22/24 测试。
- 公共 registry 发布后逐一核对 10 个包的确切版本、`next` 标签、tarball SHA-512 和 provenance。
- 公共 smoke 将从 registry 安装 CLI，并再次执行真实 bin 与核心流程。
- 各 Agent 的原生发现与执行、第三方技能附带脚本和付费服务调用不因目录或包审计自动视为通过。

复现步骤见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [docs/release.md](docs/release.md)。
