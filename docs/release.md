# 发布记录与后续发布门禁

## 当前状态

首个公开预览版为 **`0.1.0-preview.1`，指定发布通道 `next`**。npm 命名空间为 `@llx17669475`，独立公开源码仓库为 [Lilongxi0507/skillshelf](https://github.com/Lilongxi0507/skillshelf)。

**截至 2026-09-23，首个公开预览版的 18 个 npm 包均已发布。** 冻结源码 [`f5fe8f4` 的原生 CI](https://github.com/Lilongxi0507/skillshelf/actions/runs/35820368322)已通过 Linux、macOS、Windows 的 Node.js 22/24 六组作业及生产作业。公开 registry 中 18 个确切版本、`next` 标签和下载 tarball 的 SHA-512 均与冻结计划相符；Linux 已完成公共 npm 安装及核心流程验证。macOS/Windows 的公共 npm 安装验证仍待执行，详见[公开验证记录](../PUBLIC-VERIFICATION.md)。

用户安装命令：

```bash
npm install -g @llx17669475/skillshelf@next
```

## 18 个包与发布顺序

| 顺序 | 包 | 数量 | 内容 |
|---|---|---:|---|
| 1 | `@llx17669475/skillshelf-skill-<id>` | 16 | 完整技能快照、manifest、LICENSE/NOTICE；data-only |
| 2 | `@llx17669475/skillshelf-catalog` | 1 | 精确版本、来源、摘要等元数据，不含技能正文 |
| 3 | `@llx17669475/skillshelf` | 1 | 编译后的 CLI、bootstrap 元数据、README、LICENSE |

首发各包均使用 `0.1.0-preview.1`，公开访问权限为 `public`，指定 npm dist-tag 为 `next`。npm 首次发布时还自动创建了指向该预览版的 `latest` 标签；该标签不表示已有稳定版，安装说明仍显式使用 `next`。之后 CLI、目录与技能可以独立发版；内容变动必须发布新确切版本，不得覆盖旧版本或复用过期 SRI。

预览 CLI 的目录检查/刷新、程序更新检查应统一跟随 `next`。技能获取始终使用已审目录或项目锁中的确切版本与 SHA-512，不把技能 dist-tag 当成内容身份。

## 独立公开源码范围

独立源码仓库必须使用新的 Git 历史，只收录审查过的项目文件。不要复制外围工程、已有 `.git`、本机配置或工作数据；不要用整个工作区的递归复制代替白名单。

以下路径均相对独立工程根；**白名单不是免审规则**，仅包含内容已复核的普通文件：

| 白名单 | 条件 |
|---|---|
| `README.md`、`CONTRIBUTING.md`、`LICENSE`、`.gitignore`、`.gitattributes` | 公开说明、原有版权、独立工程忽略规则；禁用 Git 换行转换以保留快照原始字节 |
| `package.json`、`package-lock.json`、`tsconfig.json` | 包身份、锁文件与 TypeScript 配置；无私有 registry 或凭据 |
| `.github/workflows/ci.yml` | 只读仓库权限，仅验证；无发布步骤、发布凭据或部署权限 |
| `.github/workflows/public-smoke.yml` | 手动触发，从公共 npm 安装 `next` 并验证原生 CLI 与核心流程；不发布 |
| `.github/workflows/publish.yml` | 手动触发，重建并核验实际包，六组原生作业通过后用 npm Trusted Publishing 发布；须逐包配置 npm 绑定并单独实测 |
| `packages/cli/package.json`、`packages/cli/README.md`、`packages/cli/LICENSE` | 核对包名、版本、源码地址与公开 files 清单 |
| `packages/cli/src/**/*.ts` | CLI 源码；不附带同目录内的内部说明、状态文件或编译输出 |
| `catalog/README.md`、`catalog/sources.json`、`catalog/bootstrap.json`、`catalog/PROVENANCE.md` | 固定来源与许可记录保留；bootstrap 必须由最终包字节生成，不含本机 artifact 路径 |
| `skills/<目录收录的16个ID>/skill/**` | 完整已审快照，含隐藏资源、CSV、嵌套 fixtures、LICENSE/NOTICE；不是任意新增技能目录 |
| `scripts/lib.mjs`、`scripts/pack-skills.mjs`、`scripts/copy-catalog.mjs`、`scripts/validate-catalog.mjs`、`scripts/prepare-release.mjs`、`scripts/audit-cli-package.mjs` | 独立可运行的维护工具，不读取外围工程；保留针对受保护目录的输出安全检查 |
| `tests/*.test.mjs`、`tests/terminal-smoke.py` | 纯测试源码，模拟凭据不是运行凭据；临时根可配置，无私有环境依赖 |
| `docs/release.md`、`docs/security.md` | 公开发布与安全说明 |
| `PUBLIC-VERIFICATION.md` | 单独审核的公开验证报告，只记录实际检查与未验证限制，不带内部路径或私有环境信息 |

后续其他公开报告须逐文件复核后显式加入白名单，只报告真实执行的平台、命令和结果；不能从内部记录整目录复制。

### 明确排除

- `docs/handoff.md`、`docs/implementation-contract.md`、现有内部 `docs/verification.md`、`packages/cli/src/runtime/implementation-notes.md`：不是公开源码或用户指南。若提供公开验证说明，使用单独审核的替代文件。
- **`scripts/update-sources.py`**：旧来源导入工具依赖外围工程和专用主机策略，不是独立项目的维护入口，必须排除。发布和 CI 使用仓库已收录快照，不需要此脚本。
- 任何旧 `.git/`、外围工程的配置/历史、Agent 会话、机器清单、私有部署规则。
- `.env`/`.env.*`、带认证信息的 `.npmrc`/Git 配置、私钥、证书、令牌、真实 provider 配置或运行状态。
- `node_modules/`、`dist/`、`coverage/`、日志、缓存、临时目录、数据库、运行 home、生成任务与用户媒体；它们不是源码。
- `catalog.development.json`、`publication-plan.data.json`、`publication-plan.json`、`RELEASE-REVIEW.md`、`*.tgz` 等本地准备产物不提交到公开源码。经审查的 `.tgz` 仅作为对应 npm 包的发布输入。

不要笼统排除所有 `data/`、`fixtures/`、隐藏文件或二进制资源：已审技能快照中的这些文件可能是必要资源，应按完整清单及许可保留。源码仓库白名单与 npm 包的 `files` 清单是两道独立门禁，二者都要审查。

## 本地验证与打包

[贡献指南](../CONTRIBUTING.md)提供普通开发环境的依赖安装、构建、完整测试和 PTY 验证步骤。输出使用仓库外、新建且由当前用户控制的绝对路径；不要混入用户的实际技能库或 Agent 目录。

正确顺序为：

1. `npm ci --ignore-scripts`，再 `npm run build`、`npm run validate`。
2. `node scripts/pack-skills.mjs --output "<新的绝对输出目录>" --write-bootstrap`，产生 16 个技能包、目录包及本地开发目录。
3. 重新执行 `node scripts/copy-catalog.mjs`、`npm run validate`，确保 CLI 使用新 bootstrap。
4. 用 `--development` 校验生成的 `catalog.development.json`；设置 `SKILLSHELF_TEST_TMP` 与 `SKILLSHELF_TEST_CATALOG` 后执行完整 Node 测试及 POSIX PTY 测试。不设置这些变量会跳过部分关键覆盖。
5. `npm pack --workspace packages/cli --ignore-scripts --pack-destination "<同一输出目录>"`，先生成实际 CLI tarball。
6. `node scripts/audit-cli-package.mjs "<实际 CLI tgz 的绝对路径>"`，检查真实 tarball，而不是只看 `npm pack --dry-run`。
7. `node scripts/prepare-release.mjs --output "<同一输出目录>" --cli-tarball "<实际 CLI tgz 的绝对路径>"`，校验全部 18 包并生成最终计划与检查清单，不登录或发布。`--cli-tarball` 必填，不能在 CLI 打包前执行。

`pack-skills` 从完整快照生成 tarball，读取实际压缩包校验 manifest、SRI、文件大小、权限与元数据，并生成只含 17 个数据/目录包的 `publication-plan.data.json`。`prepare-release` 加入经审计的实际 CLI tarball，生成全部 18 包的最终 `publication-plan.json`。改动包名、版本、NOTICE、文件或 tar 包装都可能改变 SRI，必须重新生成。**不要仅改 bootstrap 的 scope 字符串，也不要手填摘要。**

最终 CLI 包还应安装到临时、独立的 npm prefix，验证真正的 `skillshelf` bin、非空且正确的 `--version`、JSON list、离线按需安装和 `verify`。这一步需要依赖网络或可用的 npm 缓存，不能称为完全离线安装器。

## 首发核验与后续版本门禁

前五项是每次新版本均须重新执行的门禁，故保留未勾选；已勾选的项目只记录 `0.1.0-preview.1` 的实际结果，不自动适用于后续版本。末尾未勾选项是首发后仍待完成的验收与配置。

- [ ] 所有包身份、源码链接、固定命名空间白名单、第一方执行校验、锁文件、测试与 `next` 更新通道一致。
- [ ] 所有来源 commit、原始版权、LICENSE/NOTICE、第三方数据和嵌入资源许可均已复核；不把第三方内容重新改许可证。
- [ ] 独立公开源码只含白名单文件，静态敏感扫描和人工审查完成；没有真密钥、内部部署配置或工作数据；维护工具的拒写路径与合法来源归属不属于凭据。
- [ ] 最终 16 个技能包、目录包与 CLI 包均由最终源码生成，bootstrap 指向确切 artifact 字节；公共内容中没有 `localArtifact`。
- [ ] 安装、构建、Node 测试、关键生命周期/崩溃恢复测试、PTY、实际包审计和真正 npm bin 验证已按实际环境记录结果。
- [x] [`f5fe8f4` 的 Linux、macOS、Windows 原生 CI](https://github.com/Lilongxi0507/skillshelf/actions/runs/35820368322)通过 Node.js 22/24 构建、适用测试与同一实际 CLI tarball 的安装验证；逐平台结果和跳过项见[公开验证记录](../PUBLIC-VERIFICATION.md)。后续源码或打包内容变化须重新验证。
- [x] 该次原生 CI 覆盖 macOS 的 POSIX 权限与链接、Windows 的私有 ACL、`.cmd` 入口与受管复制/链接，以及跨平台中断恢复。POSIX 专用终端及夹具测试在 Windows 跳过；各 Agent 原生加载及真实付费 provider 调用未实测，在预览说明中明确标注。
- [x] 发布者按 16 个技能数据包 → 目录 → CLI 的顺序手动发布全部 18 个包，显式指定 `--access public --tag next`。
- [x] 从公共 registry 回读全部 18 个包的确切版本与 `next` 标签，下载 tarball 核对与冻结计划一致的 SHA-512；Linux 从公共 npm 新装 CLI 并完成目录刷新、16 项列表、按需安装、受管 Agent 副本与 `verify`。
- [ ] 在 macOS、Windows 从公共 npm 新装已发布版本并执行核心流程；当前通过的是同一候选包的原生 CI，并非这两端的公共安装验收。
- [ ] 为后续发布在 npm 为每个目标包配置 GitHub Actions Trusted Publishing，并成功执行手动 OIDC 发布工作流；目前尚未配置或验证。provenance 签名也尚未验证。

现有 `.github/workflows/ci.yml` 保持只读，无 `id-token: write` 或 npm 发布步骤。新增的 `.github/workflows/public-smoke.yml` 是手动公共安装验证；`.github/workflows/publish.yml` 是单独的手动发布流程，只有其发布作业申请 `id-token: write`，不使用长期 npm token。工作流文件本身不能证明 npm 端已完成绑定；若使用 provenance，必须真实生成并验证后再描述，不能用摘要校验冒充签名验证。

### 为后续版本配置 npm Trusted Publishing

1. 维护者在 npm 官方包设置中，逐一为需要由工作流发布的包添加 GitHub Actions 受信任发布者。首发已有 16 个技能包、1 个目录包和 1 个 CLI 包，共 18 个独立包身份；绑定目标为 GitHub 用户 `Lilongxi0507`、仓库 `skillshelf`、工作流文件 `publish.yml`。若未来只发布其中一部分包，仍须确认每个目标包的绑定。
2. 提交并审查手动触发的 `.github/workflows/publish.yml`。它必须从受审的 `main` 分支构建新版本，通过包审计和 Linux/macOS/Windows 原生作业，再用 GitHub OIDC 发布冻结包；不得加入 npm 长期 token 或跳过审计。
3. 新版本发布前重新生成并核对 `publication-plan.json`，确认所有目标确切版本未与公共 registry 冲突、预期标签为 `next`。维护者手动触发工作流并核对日志、全部公共确切版本、`next` 标签及下载摘要。首次成功前，不能宣称 Trusted Publishing 已可用或以后无需官方验证。

配置 npm 包的受信任发布者是维护者的一次性账号操作；完成且实际跑通后，后续同一包使用该工作流发布通常无需逐包完成浏览器 2FA。npm 账号策略、仓库/工作流名称变化或新增包仍可能需要维护者重新确认配置。

## 旧占位版与回滚

从 `@skillshelf-local` 开发占位版切换到 `@llx17669475`，建议使用新的独立 home，保留原 home 与自定义内容，重新安装技能并配置服务。旧账本、项目锁、目录和 bundle 不会静默改写为新命名空间；同名并不意味着相同包身份。接入旧 Agent 目标前检查受管投影，不强行接管未知目录。

新版本异常时，用户可以回到仍保留的技能版本；CLI 则由 npm 显式安装已知确切版本。发布者用新目录版本标注问题，不在后台删除用户的本地文件。项目锁固定确切字节与来源，不能承诺被上游删除的 npm 包仍可联网取回；需要长期可恢复时，应保留独立离线 bundle。
