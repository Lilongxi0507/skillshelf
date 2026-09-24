# SkillShelf 目录与完整技能快照

## 发布状态

本目录对应尚未发布的 10 包 `0.2.0-preview.1` 本地候选，npm 命名空间为 `@llx17669475`，公开源码见 [Lilongxi0507/skillshelf](https://github.com/Lilongxi0507/skillshelf)。历史发布与标签记录不代表本候选；公共注册表和跨平台验证仍须针对新候选重新核对。现有[公开验证记录](../PUBLIC-VERIFICATION.md)只覆盖历史 `preview.1` CI。

当前候选由 10 个包组成：

- CLI：`@llx17669475/skillshelf`。
- 元数据目录：`@llx17669475/skillshelf-catalog`。
- 8 个完整技能包：`@llx17669475/skillshelf-pack-<包ID>`，合计 83 个成员。

本地生成的摘要不代表 npm 包可下载；使用前应核对公共注册表中的确切版本、标签与 artifact。

## 仓库内容

| 路径 | 用途 |
|---|---|
| `sources.json` | 已审来源 commit、技能映射、分类与展示信息 |
| `curation.mjs` | 12 个一级分类、二级分类和逐成员中文用途、示例、依赖与技术栈 |
| `bootstrap.json` | 自动生成的公共元数据，随 CLI 提供初始目录 |
| `PROVENANCE.md` | 上游来源、原始版权、许可证和快照完整性记录 |
| `../skills/<快照目录>/skill/` | 完整技能快照，包含正文、脚本、数据、引用资源和 LICENSE/NOTICE；部分上游目录名与公开技能 ID 不同，映射见 `sources.json` |

公共目录不包含技能正文、包字节、凭据、provider 配置、`localArtifact` 或本机路径。第一方源代码使用 MIT；第三方技能、字体、数据等继续保留其原始版权、许可与来源记录。不能为了缩小包而删去快照内已声明的资源或许可证。

当前候选包含原有 16 项，以及 Archify 1 项、Matt Pocock 38 项、Superpowers 15 项、GitNexus 13 项。UI/UX Pro Max 保留 **74 个文件**；Archify 保留 190 个上游文件，并随包加入 `THIRD_PARTY_NOTICES`，记录 107 个品牌标志的来源和逐项许可（其中 Vue 为 CC-BY-NC-SA-4.0）。GitNexus 为 PolyForm Noncommercial，仅适用于许可允许的非商业用途。完整文件数不表示所有资源使用同一许可证。

schema 2 将 Taste 13、Matt Pocock 38、Superpowers 15、GitNexus 13 以及四个单成员包作为安装单位。聚合目录保留每个成员的上游路径，原生 Agent 链接指向共享 store 中的成员目录；自动模式不退化为副本。显式 copy 是非共享兼容模式。

旧 schema 1 账本仍可读取，加载不迁移、不下载、不删除。显式父包迁移先预览已有成员、缺失成员、版本差异与受管投影转换，再以单个事务更新选择。完整文件、子技能、依赖及运行时差异通过 core 的 `previewPackChange` / `comparePackManifests` 获取。

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

- 8 个完整包 tarball 与聚合 manifest；
- 公共目录和本地开发目录；
- 元数据目录 tarball 与 9 包数据计划 `publication-plan.data.json`；
- CLI 经 npm pack 打包后，由 `prepare-release --cli-tarball` 校验生成全部 10 包的 `publication-plan.json` 与人工检查清单。

这些步骤只准备、验证本地文件，不登录或发布。最终检查必须使用实际 CLI tarball，不能在 CLI 打包前执行或省略 `--cli-tarball`。完整开发步骤见[贡献指南](../CONTRIBUTING.md)，10 包发布顺序及公开源码白名单见[发布门禁](../docs/release.md)。
