# SkillShelf 目录与完整技能快照

## 发布状态

本目录属于 `0.1.0-preview.1` 发布候选，**本文编写时仍在准备，尚未公开发布**。授权 npm 命名空间为 `@llx17669475`，公开源码目标为 [Lilongxi0507/skillshelf](https://github.com/Lilongxi0507/skillshelf)。预览通道是 `next`，不是稳定版 `latest`；后续发布状态以项目 README 与实际发布记录为准。

首发计划共 18 个包：

- CLI：`@llx17669475/skillshelf`。
- 元数据目录：`@llx17669475/skillshelf-catalog`。
- 16 个完整技能包：`@llx17669475/skillshelf-skill-<技能ID>`。

准备完成或生成摘要不等于 npm 包可下载；发布后还需要回读实际版本、标签与 artifact。

## 仓库内容

| 路径 | 用途 |
|---|---|
| `sources.json` | 已审来源 commit、技能映射、分类与展示信息 |
| `bootstrap.json` | 自动生成的公共元数据，随 CLI 提供初始目录 |
| `PROVENANCE.md` | 上游来源、原始版权、许可证和快照完整性记录 |
| `../skills/<id>/skill/` | 完整技能快照，包含正文、脚本、数据、引用资源和 LICENSE/NOTICE |

公共目录不包含技能正文、包字节、凭据、provider 配置、`localArtifact` 或本机路径。第一方源代码使用 MIT；第三方技能、字体、数据等继续保留其原始版权、许可与来源记录。不能为了缩小包而删去快照内已声明的资源或许可证。

首批内容为 13 项 Taste、UI/UX Pro Max 以及 2 个第一方工具。UI/UX Pro Max 保留 **74 个文件**，包括源快照的脚本、CSV/JSON、references、测试资源和根许可证。完整文件数不是所有文件都属于同一许可证的声明，嵌入资源仍按其许可记录处理。

## 内容身份与获取

`bootstrap.json` 中的确切版本、SHA-512 SRI、逐文件数目、大小与内容摘要由**真实生成的 tarball**计算和验证，不只依赖 npm packlist。重打 tarball、修改包元数据或 NOTICE 都可能改变 SRI；发布时应使用审查过的确切 artifact，发布后再下载核对。

目录刷新和在线检查使用 `next` 获取预览目录；技能下载使用目录或可信项目锁中的确切版本，不跟随技能标签漂移。`check` 只读比较，不写目录缓存或更新技能；`catalog refresh` 更新元数据，不会安装技能。

技能与目录只从固定 HTTPS npm registry 获取，不使用重定向、认证信息或任意自定义镜像。内容包是 data-only：不会运行 npm、生命周期 hooks 或技能脚本，不安装技能依赖，也不会从源代码仓库动态补文件。

安装前会检查：

- 整个压缩包的 SHA-512，包名、版本、命名空间及有限大小。
- tar 文件类型、路径、重复项、大小写冲突、保留名称与权限，拒绝包内链接、穿越、特殊文件及未声明内容。
- manifest 与完整文件集合、每文件 SHA-256、大小和执行位，确认包根 LICENSE 与技能 LICENSE 一致。
- 提取后再次校验完整树，才纳入持久 store。

隐藏文件和二进制资源也属于完整清单。摘要完整性不等于作者认证或执行沙箱；Agent 后续如何运行技能仍由用户授权控制。详见[安全边界](../docs/security.md)。

## 本地目录与离线使用

持久 store 和已验证的原始数据包位于 SkillShelf home，独立于 npm/npx 缓存。离线复用仍需验证内容；缺失或损坏对象会报告，不通过静默删除或更换来源来掩盖。

维护打包会生成两种目录：

- `catalog.public.json`：仅公共元数据，可生成公共 bootstrap 和目录包。
- `catalog.development.json`：额外含相对本地 artifact 引用，供显式 `--catalog` 的开发/离线验证使用，**不得放入公共目录包、CLI 包或公开源码**。

本地开发目录是用户显式选择的可信输入，不代表已经发布到 npm，也不能凭自述内容取得任意第一方执行身份。来自不明来源的目录或 bundle 应先审查。

使用过 `@skillshelf-local` 的用户应为新 scope 选择新 home 并重新安装；旧目录、锁和账本不会静默转换。同名技能在不同包命名空间下不是同一 npm 身份。

## 维护与重新打包

独立工程使用已经收录的完整快照，构建与 CI 不需要外围工程或其来源导入器。修改来源必须人工复核 commit、完整文件清单、许可证与差异；不自动执行上游脚本或覆盖用户改动。`scripts/update-sources.py` 是旧环境专用导入器，不属于独立公开工程，不能作为维护命令。

在完成依赖安装和 TypeScript 构建后：

```bash
node scripts/pack-skills.mjs --output "<新的绝对输出目录>" --write-bootstrap
node scripts/copy-catalog.mjs
node scripts/validate-catalog.mjs
node scripts/validate-catalog.mjs --catalog "<输出目录>/catalog.development.json" --development
npm pack --workspace packages/cli --ignore-scripts --pack-destination "<同一输出目录>"
node scripts/audit-cli-package.mjs "<实际 CLI tgz 的绝对路径>"
node scripts/prepare-release.mjs --output "<同一输出目录>" --cli-tarball "<实际 CLI tgz 的绝对路径>"
```

输出目录应由当前用户控制，位于源码和实际用户数据之外，且不使用已有 artifact 覆盖。脚本会准备：

- 16 个技能 tarball 与 manifest；
- 公共目录和本地开发目录；
- 元数据目录 tarball 与 17 包数据计划 `publication-plan.data.json`；
- CLI 经 npm pack 打包后，由 `prepare-release --cli-tarball` 校验生成全部 18 包的 `publication-plan.json` 与人工检查清单。

这些步骤只准备、验证本地文件，不登录或发布。最终检查必须使用实际 CLI tarball，不能在 CLI 打包前执行或省略 `--cli-tarball`。完整开发步骤见[贡献指南](../CONTRIBUTING.md)，18 包发布顺序及公开源码白名单见[发布门禁](../docs/release.md)。
