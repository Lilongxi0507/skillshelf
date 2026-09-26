# SkillShelf v0.3.0 开发交接

> **交接状态：按用户要求停止开发，等待另一位 agent 接手。**
> 本文是当前现场摘要，不是发布报告。v0.3.0 尚未完成、尚未公开发布。
> 下一位 agent 应从 **Task 2：GitHub 获取适配器** 接续，不要重做已通过复审的 Task 1。

## 1. 先看这里：现场和下一步

| 项目 | 已核实状态 |
|---|---|
| 工作区父目录 | `/data/cloud-desktop/Desktop/Skillshelf` |
| 唯一开发 worktree | `/data/cloud-desktop/Desktop/Skillshelf/Skillshelf-v0.3.0` |
| 开发分支 | `feature/v0.3.0` |
| 当前 HEAD | `0ff1793f8151709707e68b052bb5cd96d998a60a` |
| 原始 checkout | `/data/cloud-desktop/Desktop/Skillshelf/Develop`，`main` 在 `f5ce69c`；保持不动 |
| 已完成 | Task 1 来源身份/manifest 合约及两轮修复；最近独立复审 Spec PASS / Quality PASS |
| 未完成 | Task 2–7、集成/跨平台门禁、精确 npm 发布、registry 回读、public smoke |
| 停止时未提交代码 | **`tests/github-registry.test.mjs`**：新建、未跟踪、280 行、15 个顶层测试；保留，不删除 |
| Task 2 产品文件 | **尚不存在** `registry/github.ts` 和 `registry/paths.ts`；无 Task 2 commit/report |
| 本次交接新增 | 本文；另更新本计划的 ignored progress ledger |
| 后台状态 | 三个活动代理已中断；最终检查所有后代均非 running；`job_list` 无后台任务 |
| 发布/部署 | 本轮没有 push、npm publish、真实用户 home 迁移或上线 |

### 接手顺序

1. 进入上述 **现有 worktree**，核对 HEAD、`git status --short` 和本文列出的草稿；不要另建重复 worktree，也不要覆盖未提交测试。
2. 读下面的设计、计划、ledger 和 **Task 2 brief**，再读测试草稿及 parser preflight。
3. 检查测试草稿与合约的一致性，先运行聚焦测试记录真实 RED。**目前没有该草稿的运行结果，不能声称 RED/通过。**
4. 实现独立 GitHub adapter，保持 npm parser 不动；隔离 build/聚焦/回归测试；完成报告、GitNexus 变更检查和 scoped commit。
5. 对 Task 2 提交做独立的 spec + quality 复审，修复阻断问题后，才进入 Task 3/4。
6. 按剩余任务顺序连续推进。发布、共享分支推送、真实 home 迁移均保留相应授权/安全门禁。

## 2. 用户目标、约束与权威文档

用户批准的目标：发布**精确 v0.3.0**，把现有 **83 成员 / 8 逻辑包**默认获取改为经过校验的 GitHub 固定 commit；保留 0.2.x npm 安装/历史/锁/bundle 兼容；npm 新版只发布 CLI 和 metadata-only catalog 两个包。

最新指令是“停下来，写交接文档，让别的 agent 继续开发”。本会话已停止，不在后台继续实现。用户另明确 **最多 10 并发**；这不是必须开满 10 个代理。共享 worktree 产品代码保持一个实现写入者，独立只读准备才并行。

按权威顺序读取（相对开发 worktree）：

1. `docs/superpowers/specs/2026-09-25-v0.3.0-github-sources-design.md` — 已批准设计，冲突时优先于实施细节。
2. `docs/superpowers/plans/2026-09-25-v0.3.0-github-sources.md` — P0–P7 计划；任务 brief 将其拆成 Task 1–7，编号与 Phase 不完全一一对应。
3. `.superpowers/sdd/2026-09-25-v0.3.0-github-sources/progress.md` — 当前恢复 ledger，包含修复、风险和裁决。
4. 同目录 `task-2-brief.md` — **Task 2 的绑定合约**，已修正跨仓库 overlays、独立路径命名空间、未选 symlink 规则。
5. 同目录 `task-1-report.md` — Task 1 实施、两轮修复和测试证据。
6. 同目录 `task-3-brief.md` 至 `task-7-brief.md` — 后续任务输入，开始对应任务时再读。

**持久性提醒：** `.superpowers/sdd/` 大多被 git 忽略；当前仅 `task-1-report.md` 被显式跟踪。brief/ledger/review diff 保存在本机 worktree，不会自动随 clone 出现。跨机器交接时先带走这些上下文文件，不要 `git clean -fdx`。`/tmp` 证据也可能被清理，消失后必须重新验证，不能以本文代替原始证据。

## 3. 已完成的提交和测试边界

| 提交 | 内容 |
|---|---|
| `0b37469` | v0.3 GitHub 来源设计和计划 |
| `39f6b4f` | additive schema-3 source identity 类型、新 manifest validator/digest helpers、聚焦测试 |
| `a5045a4` | 修复 npm namespace 正则、清单归属/冲突、authorization 身份绑定等第一轮问题 |
| `0ff1793` | Task 1 第二轮修复：跨源 overlay、成员入口存在性、源/目标命名空间分离 |

Task 1 主要文件：

- `packages/cli/src/types.ts`
- `packages/cli/src/registry/manifest.ts`
- `tests/catalog-v3.test.mjs`

公开 helper：`validateSourceManifest`、`digestSourceTree`、`digestSourceRelease`、`digestSourceMappings`。

第二轮修复确认了：

- overlay 可以来自另一组固定 repository/commit，身份纳入 `manifestDigest`；普通 mapping 的可选 repository/commit 仍须等于主来源。
- 成员 runtime entrypoint 必须在 `member.path + entrypoint` 对应的 selected inventory 中实际存在。
- 源路径与目标路径是独立命名空间：`Skills/demo -> skills/demo` 合法；同树大小写/Unicode 歧义仍拒绝。

最近测试证据**来自提交前实现者报告及后续静态独立复审，不是本次交接新跑结果**：

```text
iso-run bash -c 'npm run build && SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-schema-fix-round2 node --test tests/catalog-v3.test.mjs'
=> build 成功；12 tests / 12 passed / 0 failed

iso-run bash -c 'SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-schema-fix-round2-full npm test'
=> 179 total / 148 passed / 0 failed / 31 skipped
```

- `git diff --check` 通过；Task 1 round-2 `detect_changes` 报告非 partial、非 truncated，2 个变更文件、7 个 changed symbols、risk low。
- 31 skips 是已有打包/开发 catalog/平台 fixture 门控，**不是完整发布门禁通过**；后面必须补齐配置，不能隐藏 skip。
- **Task 1 不等于完整 schema-3 产品接入。** 当前 CatalogEntry/Release 仍有旧 npm 必填字段，State/ProjectLock 仍 schema 1/2；public catalog validator、安装、生命周期、bundle/runtime 尚未迁移。
- `registry/tar.ts`、legacy `validation.ts` 在 Task 1 中保持不动。
- 新增未跟踪的 GitHub 测试后，当前全套测试未重新运行，不能沿用上述数字宣称当前工作树全绿。

## 4. Task 2 现场与绑定技术决定

### 未提交测试草稿

`tests/github-registry.test.mjs` 使用生成的 Header/tar/gzip、注入 fetch/Web Stream 和内存 cache/staging。它可选 import 尚不存在的 `dist/registry/github.js`，以显式 missing-contract 断言表达最初 RED。

草稿覆盖：固定 URL、目录/overlay/执行位、重压缩身份稳定、跨源 overlay、不可信 manifest、HTTP/TLS/中断、原始路径/别名、tar/gzip framing、PAX、links/special/gitlink/LFS、UIUX/Matt 未选 symlink、清单不匹配、流量限制、取消/超时、并发/离线/损坏缓存、多来源失败不发布 cache。

**状态：草稿，未运行、未独立复审。** cache Interface 和错误码目前是草稿预期，不是已经交付的 adapter 合约。接手者应验证测试本身，再实现，不要为了满足草稿弱化设计。

### Adapter 安全要求（完整细节见 brief）

- 新增 `packages/cli/src/registry/github.ts`、`paths.ts`；尽量用一个深入口 `acquireGithubSource({manifest, signal?}, deps)`，隐藏下载、扫描、映射、cache/staging 细节。
- 先用 `validateSourceManifest` 校验输入，不修改调用方对象。返回已验证 destination-relative selected files/Buffer、精确文件 metadata、root、archive receipt、tree/release digest。
- 只构造 `https://codeload.github.com/<owner>/<repo>/tar.gz/<40位小写SHA>`；redirect:error、credentials:omit、不附凭据、无镜像/分支/tag/任意 URL 回退，不紧密重试。
- 默认预算：压缩 128 MiB、展开 512 MiB、100,000 archive entries、请求 180 秒、idle 30 秒；selected 2,000 files、16 MiB/file、64 MiB total。
- 逐段读取、有背压、压缩和展开分别计数；不缓存整个展开仓库到内存；只收集 selected bodies；不能 `tar.extract`/`Unpack`。
- 原始 512-byte header、UTF-8/NUL、PAX、padding/framing 必须在库归一化前检查；单一非空顶层根，剥去一层；拒绝截断/双 archive/多 gzip member/非零 padding/歧义路径。
- **跨源 overlays 必须逐固定 tuple 获取和校验**，不能假定所有补充文件都在主仓库；每个 tuple 的源路径命名空间与目标命名空间分开。
- **未选 symlink 不能一刀切拒绝：** UIUX 有 `gallery/data/styles.csv -> ../../src/ui-ux-pro-max/data/styles.csv`，Matt 有 `AGENTS.md -> CLAUDE.md`。校验原始编码、词法目标不逃出归档根，安全丢弃，不跟随/落盘；selected link 和 link ancestor 必须拒绝。这个裁决覆盖早期“全部拒绝也可以”的错误派工。
- 完整 selected 集合、大小、SHA-256、100644/100755、mapping、overlay 均须匹配；缺、多、错、冲突均 fail closed。
- repo+commit cache/single-flight，缓存字节/receipt 重新校验，offline miss 不联网；完整校验前不发布 cache/store/state/projection。
- `origin: github` 不授予 run；Task 2 不碰 manager/state/store/runtime 集成。

### Parser 踩坑

读 `/tmp/skillshelf-v030-task2-parser-preflight.md` 后再写 scanner：

- 已安装 `tar@7.5.22` 的 `Parser` 不是普通 Node Writable；直接塞入 `pipeline` 的错误清理可能调用不存在的 `destroy`。用显式 pump 或真正 Writable wrapper。
- `createGunzip({ maxOutputLength })` 不是流式展开上限；必须在 gunzip 后显式计数。
- 支持 codeload harmless global PAX（观察到 `comment=<commit>`），并保留 raw allowlist/有效字段校验。
- **Task 2 不改 `registry/tar.ts` 或 npm `http.ts` 语义。** npm archive 信任仍 exact SRI。

## 5. 来源证据与尚未闭合的 inventory

已有只读 P0 核验文件：

- `/tmp/skillshelf-v030-source-inventory.md`
- `/tmp/skillshelf-v030-source-verification/report.md`
- `/tmp/skillshelf-v030-source-verification/reports/verification.json`
- `/tmp/skillshelf-v030-source-verification/archives/` — 7 个保留的 `.tar.gz`，交接前确认存在

P0 当时记录：7/7 fixed codeload HTTP 200、无 redirect/credentials/mirror、均在预算内；513 个已比较 selected 文件字节/mode 一致。**这是观测证据，不是生产 adapter/public smoke 通过。**

| 逻辑包 | 成员 | 当前 fixture 文件数 | 固定主源 |
|---|---:|---:|---|
| taste | 13 | 27 | `Leonxlnx/taste-skill@5217fb45be2c0b302f29c9cd31cbd3237501c684` |
| ui-ux-pro-max | 1 | 74 | `nextlevelbuilder/ui-ux-pro-max-skill@dcc40ff5133ef78276117db0cc34e7b83cc8aeba` |
| archify | 1 | 191 | `tt-a1i/archify@c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de` |
| matt-pocock | 38 | 141 | `mattpocock/skills@c55ee46073ed923f86ce59a5eb3b6d895095d1b7` |
| superpowers | 15 | 90 | `obra/superpowers@5bf4e78011075bcfc0dc295f0724994cd123ee71` |
| gitnexus | 13 | 82 | `abhigyanpatwari/GitNexus@c2ca132620ae935749fd243ee8a93dcccd870f02` |
| skillshelf-web-search | 1 | 7 | SkillShelf S（下文） |
| skillshelf-media-generation | 1 | 11 | SkillShelf S（下文） |
| **合计** | **83** | **623** | **7 主仓库 / 8 逻辑包** |

第一方候选来源 S：`Lilongxi0507/skillshelf@f5ce69c05d281eb1c330ea60a7c49d3560f7b677`，公开 codeload 和本地历史均曾核验，真实根为：

- `skills/skillshelf-web-search/skill`
- `skills/skillshelf-media-generation/skill`

旧 `clients/skills/panel-*` 是归属/改造输入记录，**不能当公开下载路径**。最终 catalog/release commit R 必须引用早已存在的 S，不能自引用 R。

### Task 3 前必须解决

1. Taste P0 广选 `skills/` 中的 `skills/llms.txt`，不在成员 fixture 中：选择完整成员目录或明确共享文件/排除裁决，不能默默消失。
2. Matt 四个 category README 是广选目录中的额外文件；需要明确其布局/排除理由，保持 38 个成员完整。
3. GitNexus 报告有 **40/56/57** 数量叙述差异，主要是 swarm 所需 `.claude/agents/*` 和 `pr-swarm-review/**`。ledger 算出 **16 个未闭合 body 文件**；不要盲信报告“7+10”的文字，逐文件核对。
4. 明确 legal overlays：Taste 13、UIUX 1、Archify authored THIRD_PARTY_NOTICES 1、Matt 38、Superpowers 15、GitNexus 26 LICENSE/NOTICE（共 94）；另有上述 16 body extras。所有 local 文件必须有固定源/显式布局证明。
5. GitNexus 为 PolyForm Noncommercial，保留 required NOTICE；Archify 素材不是一概 MIT；第一方 NOTICE 记录改造来源，不等于执行授权。

停止时重开的 source reconciliation 只读代理和 lifecycle audit 代理都被中断，**没有可采纳的新完成报告**。上述问题仍未关闭。

## 6. 后续任务和集成缝隙

| Task | 工作 | 当前状态 |
|---|---|---|
| 2 | GitHub transport/parser/mapping/cache | 只有未提交测试草稿 |
| 3 | 固定 source manifests、schema-3 catalog/bootstrap、双包发布计划、check-sources、版本 0.3.0 | 未实现 |
| 4 | GitHub 接入 `acquireSkill` / `acquireLockedSkill`，持久 cache/store，二次树验证 | 未实现 |
| 5 | catalog/state/lock/release 接入，check/update/history/revision rollback/migrate sources/frozen | 未实现 |
| 6 | selected bundle/offline 恢复、第一方独立 execution authorization、gc/trust | 未实现 |
| 7 | CLI/TUI/JSON、只读 `mcp serve`、profiles 边界、docs、CI/public smoke/release workflows | 未实现 |

**先处理 plan interface 缝隙：** Task 1 只交付 SourceManifest，不是完整 catalog/state 模型。Task 3 brief 要求可验证的 schema-3 catalog，但当前 legacy `validatePublicCatalog` 尚不支持；Task 4 要 trusted catalog/lock，但 loader 仍旧格式。接手者需在对应任务中明确 additive validator/type/loader 的归属并记录裁决，不能用假的 npm package/version/SRI 填字段绕过编译和信任要求。保留旧 schema 专用路径。

完整发布还需要：所有 83/8 的真实 adapter 验证、legacy migration/rollback 演练、Linux/macOS/Windows × Node 22.20/24 门禁、Python 场景、两个精确 npm artifacts、registry SRI/provenance 回读、精确公共 CLI smoke。当前 MCP diagnose `protocolProbe: not-run`/preview 不写原生配置；目录存在不是原生 Agent 加载证明。

## 7. 执行约束、风险与复现方式

- 使用现有 Node test runner、严格 TypeScript/NodeNext；TDD 先真实失败再产品实现。
- 构建/大规模测试必须通过 `iso-run`，先加载 `frontend-build-isolation` 技能查看本机资源隔离方式；使用私有 `/tmp` fixture，不动真实 home/Agent roots/provider。
- 修改共享符号前 GitNexus impact；提交前 `detect_changes(scope=all, worktree=/data/cloud-desktop/Desktop/Skillshelf/Skillshelf-v0.3.0)` 非 partial/non-truncated；`git diff --check`。
- 当前图谱曾提示落后 HEAD 2 个提交：影响数值是参考，编辑前重核。预检结果：`readTarball`/`verifySkillArchive` CRITICAL；`packDefinitions` LOW 3 direct、`packContents` LOW 3 direct、`publicationPlan` LOW 2 direct；`validatePublicCatalog` CRITICAL（52 upstream / 27 processes / 8 modules）。
- 一名实现者负责一项任务，提交后独立 spec+quality review。等待时做独立工作/等待完成通知，**不要反复 `git status`、`list_agents` 或催促 reviewer 立即 PASS**。此前控制器发生过无效空轮询，不能延续。
- generic `task-brief ... 2` 无法从 Phase 标题提取 Task 2；直接使用已填充的专用 brief。不要把提取失败当合约缺失或重新规划理由。
- 同会话 goal 为 paused/disarmed（`goal-3304b636-0221-43c7-a33e-3380b2284c86`）；runtime 曾拒绝 model resume。本次用户停止后保持暂停，不自动续跑。
- 当前环境文件策略是 danger-full-access，approval prompts disabled；不设置 `sandbox_permissions`，不把无提示误当发布/破坏性操作授权。

仅供接手 agent 的起步命令（交接时未执行这些测试）：

```bash
# workdir: /data/cloud-desktop/Desktop/Skillshelf/Skillshelf-v0.3.0
git status --short --branch
git log -4 --oneline
# 阅读并确认草稿后，再在隔离环境记录 Task 2 RED
iso-run bash -c 'npm run build && node --test tests/github-registry.test.mjs'
```

build 后仍缺 github.js 的失败是预期起点，不代表测试草稿中的其他断言已被验证。实现后使用独立 `SKILLSHELF_TEST_TMP` 运行聚焦和全套，记录具体命令/计数/skip 原因。

## 8. 发布历史与结束边界

历史 0.2.1 是 **7/10 部分发布**：GitNexus skill pack 发布遇到 npm E429，GitNexus pack/catalog/CLI 的该版本当时未完成。这个事实促成 v0.3 GitHub-source 改造；不重写历史、不声称旧版本完整发布。

新公开目标仅：

- `@llx17669475/skillshelf-catalog@0.3.0`
- `@llx17669475/skillshelf@0.3.0`

不要生成或再发布 8 个新版 npm skill pack。仓库当前 package/catalog 仍 0.2.1；到受测的 Task 3 再改版本。真正发布前加载 `github-npm-release`、核对现有授权与 OIDC 门禁，不读出或记录凭据。

**交接完成标准：** 开发已停、无后台运行任务、草稿保留、本文可打开。本文不授权立即 publish/push，不把任务未完成伪装成外部阻塞或测试通过。
