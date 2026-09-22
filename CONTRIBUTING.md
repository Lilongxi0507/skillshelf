# 参与 SkillShelf

感谢帮助完善独立的 SkillShelf CLI、文档与精选目录。公开源码目标为 [Lilongxi0507/skillshelf](https://github.com/Lilongxi0507/skillshelf)。本文为 `0.1.0-preview.1` 发布候选编写，编写时仍在准备阶段；不要因安装命令、包名或工作流存在就声称已经发布或测试成功。

## 开发环境

- Node.js **>=22.20.0**，推荐 Node.js 22/24 的最新补丁版。
- npm；依赖使用仓库的 `package-lock.json`。
- Python **>=3.10** 用于 POSIX 终端 smoke 测试及第一方工具；测试不需要真实服务商 Key。
- 仓库外、当前用户可控的临时空间。不要用实际 SkillShelf home 或 Agent 技能目录做测试 fixture。

独立工程包含所需技能快照，不依赖其他工程的源码、数据库、服务配置或凭据。不需要来源导入器，不执行第三方技能脚本来准备构建。

## 安装依赖与构建

在普通开发环境的工程根目录执行：

```bash
npm ci --ignore-scripts
npm run build
npm run validate
```

`build` 编译 CLI 并复制公共 bootstrap。技能包被作为数据处理，不执行其生命周期或业务脚本。项目中的测试依赖编译后的 `packages/cli/dist/`，不要跳过构建。

## 完整本地验证

下面是 Linux/macOS 的 POSIX shell 示例。macOS 上可运行不代表已经获得实机验收；Windows 不适用这些 shell 与 PTY 步骤。

```bash
# 新建仓库外的临时根；只使用本次输出，不覆盖任何既有发布包。
work="$(node --input-type=module -e 'import {mkdtempSync,realpathSync} from "node:fs"; import {tmpdir} from "node:os"; import {join} from "node:path"; process.stdout.write(realpathSync(mkdtempSync(join(tmpdir(),"skillshelf-check-"))))')"
mkdir -m 700 "$work/tests"
export SKILLSHELF_TEST_TMP="$work/tests"
export SKILLSHELF_TEST_CATALOG="$work/packages/catalog.development.json"

node scripts/pack-skills.mjs --output "$work/packages" --write-bootstrap
node scripts/copy-catalog.mjs
npm run validate
node scripts/validate-catalog.mjs --catalog "$SKILLSHELF_TEST_CATALOG" --development
npm test
python3 tests/terminal-smoke.py --cli packages/cli/dist/index.js --catalog "$SKILLSHELF_TEST_CATALOG" --tmp "$SKILLSHELF_TEST_TMP"

npm pack --workspace packages/cli --ignore-scripts --pack-destination "$work/packages"
cli_tarball="$work/packages/llx17669475-skillshelf-0.1.0-preview.1.tgz"
node scripts/audit-cli-package.mjs "$cli_tarball"
node scripts/prepare-release.mjs --output "$work/packages" --cli-tarball "$cli_tarball"
```

注意：

- `--write-bootstrap` 会更新源码中的 `catalog/bootstrap.json`；这不是发布。若最终包字节变化，应审查新摘要，而不是手动替换 scope 或 SRI。
- `SKILLSHELF_TEST_CATALOG` 启用真实本地数据包的生命周期覆盖；缺失时部分测试会跳过。
- `SKILLSHELF_TEST_TMP` 必须是已有的私有临时目录；它也启用实际进程中断/恢复测试。只跑默认测试且忽略 skip 不能宣称完整覆盖。
- 测试使用合成 provider 配置或 mock，不需要服务商 Key，也不应发送计费请求。
- CLI 包名或版本变化后，使用 `npm pack` 实际输出的文件名运行审计，勿沿用旧名。
- 记录自己的系统、Node/Python 版本、运行命令、失败及跳过项。生成 tarball、编译成功与测试通过是不同结果。
- 检查完只清理本次创建的 `$work`；不要递归清空系统临时目录或用户数据目录。不要提交 `dist`、缓存、测试输出、开发目录或 tarball。

如果工作目录所在主机另有资源隔离和存储规范，应优先遵守该主机政策，不直接在运行用户数据的环境中安装或构建。

## CI 的范围

`.github/workflows/ci.yml` 是**测试工作流，不是发布工作流**：在 Linux 上使用 Node.js 22/24，构建、验证目录、打本地测试包、运行 Node/PTY 测试并审计 CLI tarball。仓库权限仅为读取，不配置发布凭据，不发布 npm 包，不创建 release。

工作流定义尚不能作为成功证据；请查看实际运行结果。Linux 作业不覆盖 macOS/Windows 的真实 ACL、链接、文件系统恢复与原生 Agent 加载；这些仍需单独实测。不要将跳过的平台标记为通过。

## 修改边界与提交要求

- 变更尽量聚焦，附目的、影响面和实际执行的验证结果；未运行的检查明确写“未运行”。
- CLI 名称、scope、来源限制、第一方执行资格、目录与项目锁需要一致，不为方便下载放宽来源校验。
- 内容或包元数据变化必须重新计算真实 tarball 的摘要；内容发版使用新确切版本。
- 不引入自动安装技能依赖、隐式执行技能代码、无确认的付费请求或未知结果重试。
- 未知用户文件、改动副本、旧 home 和未选 Agent 不得被静默接管或覆盖。
- 保留所有原始版权、LICENSE、NOTICE、第三方数据来源与许可记录。不要把来源说明当成可随意删改的模板。
- 精选快照更新需核对固定 commit 和完整文件清单；资源、隐藏文件及嵌套 fixtures 可能是技能的一部分，不能只复制 `SKILL.md`。
- 不提交 Key、`.env`、provider 配置、真实用户状态、数据库、日志、私有服务器路径或其他工程历史。公开源码采用[明确白名单](docs/release.md#独立公开源码范围)。
- 提交前检查 `git diff --check` 和文件列表，确认只包含本次有意修改。不要重置或覆盖他人的未提交改动。

## 问题反馈与发布

一般问题请提供版本、平台、最小合成复现和脱敏错误信息。安全问题按[安全报告说明](docs/security.md#报告安全问题)私密提交，不上传完整 home 或环境转储。

预览发布由维护者根据[发布门禁](docs/release.md)单独处理，共 18 个包，使用 `next`。普通 PR、CI 成功或生成 publication plan 不授予发布权限。测试工作流不能被改成自动发布来绕过人工审查。
