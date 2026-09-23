# SkillShelf

**个人精选，完整落地，同机多 Agent 共享。**

SkillShelf 是一个独立的 Node.js CLI：按需下载精选技能的完整文件，在本机持久保存，并接入你确认过的 Agent 技能目录。日常读取已安装技能不需要账号、连接器或远端控制面。

> **公开预览版已上架。** `0.1.0-preview.2` 的 16 个技能包、目录包和 CLI 共 18 个包已通过 GitHub Actions Trusted Publishing 发布到 npm；确切版本、`next` 标签、公共下载包的 SHA-512 和 provenance 均已核对。[发布运行 `35893524822`](https://github.com/Lilongxi0507/skillshelf/actions/runs/35893524822)在 Linux、macOS、Windows 的 Node.js 22/24 作业通过；[公共 npm smoke `35918416358`](https://github.com/Lilongxi0507/skillshelf/actions/runs/35918416358)的六组作业也全部通过。详情见[公开验证记录](PUBLIC-VERIFICATION.md)。
>
> 独立公开源码仓库：[Lilongxi0507/skillshelf](https://github.com/Lilongxi0507/skillshelf)。

## 为什么使用 SkillShelf

- **完整技能，而非单页摘录**：保留 `SKILL.md`、脚本、references、assets、数据文件和许可证。
- **只下载所选内容**：CLI 和目录只携带元数据，不捆绑全部技能正文。
- **同机共享**：一个持久技能库，通过受管链接或完整副本接入多个 Agent；清理 npm/npx 缓存不会移走已安装技能。
- **可控更新**：支持版本检查、固定版本、回滚、项目锁与离线备份。下载技能不会执行其中的脚本或 npm hooks。

## 安装与起步

需要 **Node.js >=22.20.0**；建议使用 Node.js 22 或 24 的最新补丁版。日常管理和指令型技能不需要 Python；第一方搜索/媒体工具的 `run` 需要 **Python >=3.10**。执行其他技能附带的脚本时，仍需遵守该技能自己的依赖说明。SkillShelf 不自动安装解释器或技能依赖。

安装公开预览版：

```bash
npm install -g @llx17669475/skillshelf@next
skillshelf
```

短期试用也可使用 `npx @llx17669475/skillshelf@next`。首次获取 CLI 及其依赖可能联网，不受 CLI 启动后的 `--offline` 控制。长期离线使用建议持久安装 CLI。

无参数进入中文菜单；自动化可使用下列子命令。`--home <目录>`、`--catalog <文件>`、`--offline`、`--json` 等全局选项放在命令前。写操作默认预览确认；非交互环境必须指定 `--yes` 或 `--dry-run`。

```bash
skillshelf list
skillshelf search 前端
skillshelf info ui-ux-pro-max
skillshelf install ui-ux-pro-max --agent claude-code codex --dry-run
skillshelf install ui-ux-pro-max --agent claude-code codex --yes
skillshelf install --collection taste --yes
skillshelf status
skillshelf files ui-ux-pro-max
skillshelf read ui-ux-pro-max --path SKILL.md --raw
```

如需从源码构建或核对发布包，可按[贡献指南](CONTRIBUTING.md)操作；不要把安装失败解释成应放宽来源校验。

## 首批 16 项技能

| 系列 | 内容 |
|---|---|
| Taste 精选（13 项） | design-taste-frontend、design-taste-frontend-v1、gpt-taste、image-to-code、imagegen-frontend-web、imagegen-frontend-mobile、brandkit、redesign-existing-projects、high-end-visual-design、full-output-enforcement、minimalist-ui、industrial-brutalist-ui、stitch-design-taste |
| UI/UX Pro Max | ui-ux-pro-max，**74 个完整文件**，含脚本、数据与引用资源 |
| 第一方本地工具（2 项） | skillshelf-web-search（Tavily / Brave）、skillshelf-media-generation（图片 / 视频） |

首发计划共 **18 个 npm 包**：1 个 CLI、1 个元数据目录、16 个独立技能数据包。固定来源与许可证见[来源记录](catalog/PROVENANCE.md)；第一方代码使用 MIT，第三方版权、许可证、NOTICE 和嵌入资源的许可记录原样保留。

## Agent 目录与本机存储

可管理 Claude Code、Codex、OpenCode、DSH、Cursor、Hermes、通用 `.agents/skills` 和自定义技能目录。检测只读取候选路径，不安装 Agent，也不修改其配置或授予项目信任。

```bash
skillshelf agents detect
skillshelf agents list
skillshelf agents add dsh --path "<原生技能目录的绝对路径>" --label 工作实例 --yes
skillshelf enable ui-ux-pro-max --agent codex --yes
skillshelf disable ui-ux-pro-max --agent codex --yes
```

未指定 Agent 时，使用当前范围已注册的目标；没有目标则只下载。重复 `install` 会按所选目标启用；`update` 不重新启用已停用的目标。

默认数据目录：

| 系统 | 默认 home |
|---|---|
| Linux | `$XDG_DATA_HOME/skillshelf`，未设置时为 `~/.local/share/skillshelf` |
| macOS | `~/Library/Application Support/SkillShelf` |
| Windows | `%LOCALAPPDATA%\SkillShelf` |

可通过 `SKILLSHELF_HOME` 或 `--home` 指定独立目录。数据 home 与 Agent 扫描根不能互相包含。受管内容不应直接编辑；使用 `fork` 创建独立可编辑副本。

**平台验证范围：** 同一组发布候选包已在 Linux、macOS、Windows 的 Node.js 22/24 原生 CI 上完成安装与核心流程验证；Windows 还验证了实际打包 CLI 的 `.cmd` 入口、私有 ACL 与中断恢复。公共 npm smoke 也在六组平台作业中完成了安装与核心流程检查。各系统的跳过项见[公开验证记录](PUBLIC-VERIFICATION.md)。各 Agent 原生加载仍需单独实测；目录存在不等于 Agent 已发现技能，未经原生验证的目标标记为 `unverified`。多个 Agent 若共享兼容扫描根，可能同时看到技能；`--agent` 不是访问控制。

## 更新、固定版本与回滚

```bash
skillshelf check                       # 只读检查，在线时读取远端目录
skillshelf --offline check             # 只比较已有目录，不声称它是最新的
skillshelf catalog refresh --yes       # 只更新目录，不更新技能
skillshelf update --dry-run
skillshelf update --yes                # 只更新已选、未固定的技能
skillshelf pin ui-ux-pro-max --yes
skillshelf unpin ui-ux-pro-max --yes
skillshelf rollback ui-ux-pro-max --yes
skillshelf fork ui-ux-pro-max --output "<新的可编辑目录>" --yes
skillshelf remove ui-ux-pro-max --yes   # 移除当前范围选择，保留下载与历史
skillshelf self-update --check         # 检查 CLI，不自行覆盖 npm 管理的程序
```

此预览版的安装说明与程序更新检查使用 `next` 通道；npm 首次发布时还自动创建了指向该预览版的 `latest` 标签，它不表示已有稳定版。请显式使用 `@next` 或确切版本。目录检查/刷新跟随预览通道；技能本身仍按目录或项目锁的确切版本与摘要获取。CLI 升级由 npm 完成：`npm install -g @llx17669475/skillshelf@next`。

### 从旧占位预览迁移

如果用过 `@skillshelf-local` 开发占位版，**建议为 `@llx17669475` 版使用新的独立 home**，重新安装所选技能并重新配置服务。两种命名空间的包身份、目录摘要和锁文件不能直接视为相同；本版不静默重写旧状态、旧锁或旧包来源，也不承诺直接导入旧占位包。

保留旧 home 和自定义内容作备份。重新启用同名 Agent 技能前，先检查旧投影，并用原版本显式停用其受管投影；不要让新 home 强行接管未知目录，不要手工批量替换锁文件里的 scope。

## 项目固定版本

```bash
skillshelf install brandkit --project "<项目的真实绝对路径>" --agent codex --yes
skillshelf sync --frozen --project "<恢复目标项目的真实绝对路径>" --yes
```

项目保存 `skillshelf.json` 和 `skillshelf-lock.json`，记录确切版本、摘要、来源快照和相对 Agent 目录；可以加入项目自己的版本库，不含 Key 或电脑绝对路径。

全局更新不改变项目版本。`sync --frozen` 不升级、不重写声明/锁；恢复要求两者一致。联网时按锁取回确切版本；离线恢复需内容已经缓存，或可由显式可信的本地开发目录取得。未知项目文件、本地修改不会被悄悄覆盖；项目路径请使用真实绝对路径。

## 本机服务配置与运行

配置向导不发测试或计费请求。推荐环境变量引用；请通过自己的安全方式设置环境变量，勿将 Key 写进命令参数。

```bash
skillshelf install skillshelf-web-search --yes
skillshelf providers add
skillshelf providers list
skillshelf providers add --id search-main --kind search --adapter tavily --base-url https://api.tavily.com --key-env TAVILY_API_KEY --default --yes
skillshelf run skillshelf-web-search "查询内容" --intent research
```

- 请求直连用户配置的服务商，不同步远端账户或服务配置；搜索/生成需要用户自己的服务授权，媒体任务可能计费。
- `run` 的 CLI 选项放在技能 ID **之前**，例如 `skillshelf run --project "<项目绝对路径>" skillshelf-media-generation --help`。ID 后的参数属于技能脚本。
- `--offline` 拒绝联网/计费任务，仅允许本地帮助或元数据等操作。
- Key 不进入技能包、Agent 目录、项目锁或导出文件；明文保存必须显式授权，且受本机私有权限检查。
- 最终产物保存在 `<home>/outputs/<run-id>/`，与受管技能内容隔离。不会自动 pip 安装，也不会自动重放结果未知的生成请求。
- `run` 仅允许经目录验证的第一方工具；第三方、fork 或本地导入内容不会仅凭同名取得执行授权。

## 离线备份与旧客户端迁移

```bash
skillshelf export --output "<新的选择清单.json>" --yes
skillshelf export --bundle --output "<新的离线备份目录>" --yes
skillshelf import "<离线备份目录>" --dry-run
skillshelf import "<离线备份目录>" --yes
skillshelf migrate panel --from "<旧 Python 客户端 home>" --dry-run
skillshelf migrate panel --from "<旧 Python 客户端 home>" --yes
```

完整 bundle 携带已选内容及可用的原始数据包，不含 Key、服务配置、生成产物、其他电脑的 Agent 绝对路径，也不包含 Node.js 或 CLI 本身。导入不会自动接入 Agent；请先确认本机目标再 `enable`。bundle 内自述来源和摘要不能证明作者身份；仅匹配可信目录的内容才可获得 npm/第一方执行身份。

`migrate panel` 只读旧客户端状态和受管技能，不读取旧 Key、不访问旧服务、不修改旧目录。缺少 LICENSE 的旧包按项跳过，不按同名补许可证。它不是旧 `@skillshelf-local` home 的命名空间转换工具。

## 诊断与安全

```bash
skillshelf doctor                      # 不发服务商计费请求
skillshelf verify
skillshelf repair --recover --dry-run
skillshelf repair --recover --yes
skillshelf gc --dry-run
skillshelf gc --yes                    # 保留已记录历史与备份
```

安装前验证压缩包 SHA-512 和逐文件 SHA-256；下载不执行技能代码。**摘要校验不等于作者认证，更不是执行沙箱。** Agent 运行技能脚本仍使用实际获授的权限。

未知文件、改动过的副本和被改向的链接会保留并拒绝覆盖。多目录恢复机制不是跨盘原子事务；中断恢复失败时应保留现场并按诊断处理。详见[安全边界](docs/security.md)。

## 参与开发

- [贡献指南](CONTRIBUTING.md)：依赖、构建和本地验证步骤。
- [发布说明](docs/release.md)：公开源码范围、18 包发布顺序、Trusted Publishing 和发布门禁。
- [公开验证记录](PUBLIC-VERIFICATION.md)：实际执行的检查、平台与仍未验证的限制。
- [目录说明](catalog/README.md)：来源、内容包、校验和离线目录。

本工程无需其他仓库的源码、服务配置或业务数据即可使用已收录的技能快照。测试 CI 不持有发布凭据；手动触发的 Trusted Publishing 工作流只在审计、六组原生作业和公共 registry 检查通过后发布。
