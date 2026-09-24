# SkillShelf

**个人精选，完整落地，同机多 Agent 共享。**

按需下载精选技能的完整文件，持久保存在本机，通过受管链接或完整副本接入 Agent 技能目录。CLI 只携带元数据，不捆绑全部技能；清理 npm/npx 缓存不会移走已安装内容。

> 本地候选为 `0.2.0-preview.1`，由 8 个完整技能包、1 个目录包和 1 个 CLI 包组成，尚未发布。历史版本、CI 和公共 `@next` 不代表本候选已验收；当前 Linux Node 24 隔离回归与 PTY 结果见仓库内产品验收记录。

源码与完整指南：[Lilongxi0507/skillshelf](https://github.com/Lilongxi0507/skillshelf)。

## 安装

需要 **Node.js >=22.20.0**，建议 Node.js 22/24 的最新补丁版。

```bash
npm install -g @llx17669475/skillshelf@next
skillshelf
```

短期试用：`npx @llx17669475/skillshelf@next`。首次取得 CLI 或依赖仍可能联网。无参数进入中文菜单；非交互使用显式子命令。

```bash
skillshelf list
skillshelf search 前端
skillshelf info ui-ux-pro-max
skillshelf install ui-ux-pro-max --agent codex claude-code --dry-run
skillshelf install ui-ux-pro-max --agent codex claude-code --yes
skillshelf status
skillshelf check                       # 只读，不更新本地目录或技能
skillshelf catalog refresh --yes       # 只刷新目录
skillshelf update --yes
skillshelf pin ui-ux-pro-max --yes
skillshelf rollback ui-ux-pro-max --yes
skillshelf verify
skillshelf doctor
skillshelf self-update --check         # 检查 CLI，实际升级由 npm 完成

# 同机 Agent 接入、创作、组合与 MCP
skillshelf connect codex               # 生成可复制的自助接入消息
skillshelf agents enroll codex --yes
skillshelf agents status
skillshelf agents dedupe <target> --dry-run
skillshelf author create my-pack --member review implement
skillshelf author validate my-pack
skillshelf author publish my-pack --yes
skillshelf profiles save frontend --name 前端开发 --packs taste ui-ux-pro-max
skillshelf profiles apply frontend --yes
skillshelf mcp add docs --transport stdio --command docs-mcp --yes
skillshelf mcp diagnose
skillshelf migrate home --to "~/SkillShelf Data" --yes
skillshelf uninstall --keep-home --yes
```

全局选项放命令前：`--home <目录>`、`--catalog <可信本地目录快照>`、`--offline`、`--json`。非交互写操作需要 `--yes`；`--dry-run` 只预览。预览版目录与 CLI 更新检查使用 `next`，安装技能仍取目录/锁中的确切版本；CLI 升级用上述 npm 安装命令。

当前目录收录 83 项：13 项 Taste、完整 UI/UX Pro Max（74 文件）、第一方搜索和媒体生成工具、Archify（完整图表渲染器与许可记录）、Matt Pocock（38 项）、Superpowers（15 项）和 GitNexus（13 项）。内容包保留脚本、数据、引用资源和许可证；安装不会执行技能脚本或 npm hooks，也不自动安装技能依赖。GitNexus 使用 PolyForm Noncommercial 1.0.0，只适用于该许可允许的非商业用途；Archify 的品牌素材按各自许可处理。

目录按需安装，不会因为收录而自动加载整套流程。Archify 的 Node 渲染器、GitNexus 的 CLI/MCP、以及 Matt 和 Superpowers 的脚本由调用方在具备依赖和明确授权时运行；CLI 的 `run` 只执行已审核的两个第一方 Python 工具。

## 数据与 Agent

默认 home：Linux `$XDG_DATA_HOME/skillshelf` 或 `~/.local/share/skillshelf`；macOS `~/Library/Application Support/SkillShelf`；Windows `%LOCALAPPDATA%\SkillShelf`。用 `SKILLSHELF_HOME` 或 `--home` 覆盖。数据 home 与 Agent 扫描根不能互相包含。

`agents detect` 只读检测候选目录，`agents add` 可显式注册自定义路径。未指定 Agent 时使用当前范围的已注册目标；没有目标则只下载。共享兼容扫描根可能被未选 Agent 看到，选择目标不是访问控制。目录存在不等于原生加载成功，未实测的目标标记为 `unverified`。

**旧占位版用户：** 如果曾使用 `@skillshelf-local`，请为新 scope 选择新的独立 home，保留旧数据并重新安装所选技能。不会静默转换旧账本、目录或锁；不承诺旧占位包可以直接导入。接入同名 Agent 目录前，先检查并通过原版本显式停用旧投影，不要覆盖未知文件。

## 项目、离线与服务配置

- `install ... --project "<项目路径>"` 生成 `skillshelf.json` 和 `skillshelf-lock.json`；`sync --frozen --project "<路径>" --yes` 按锁恢复。项目路径中的符号链接会规范到真实目录，同一项目的选择、锁和 Agent 目标共用该身份。全局更新不改变项目版本。
- `export --bundle --output "<新目录>" --yes` 导出完整内容备份，不含 Key、服务配置、产物或 CLI/Node.js。`import "<目录>" --yes` 后自行确认 Agent 目标。
- `migrate panel --from "<旧 Python 客户端 home>" --dry-run` 只读旧技能，不读 Key、不联网、不动旧目录；缺少 LICENSE 按项跳过。此命令不是旧 npm scope 的迁移工具。
- `providers add` 打开本机配置向导，推荐 Key 环境变量引用，不发测试/计费请求。搜索与媒体工具需要 **Python >=3.10** 及用户自己的服务授权，不自动 pip 安装。
- 先安装 `skillshelf-web-search`，再运行 `run skillshelf-web-search "查询" --intent research`。`run --project "<路径>" <技能ID> ...` 的 CLI 选项放技能 ID 前。媒体可能计费，结果未知不自动重试；不依赖其他服务的配置同步。

## 安全与平台限制

安装验证 tarball SHA-512 及逐文件清单，拒绝包内链接，不运行内容包生命周期。**校验不等于作者认证或沙箱**；Agent 执行技能仍使用用户授予的权限。未知文件、本地修改与改向链接不会自动覆盖；多目录恢复不是跨盘原子事务。

Linux、macOS、Windows 的测试范围、实际运行结果和跳过项见[公开验证记录](https://github.com/Lilongxi0507/skillshelf/blob/main/PUBLIC-VERIFICATION.md)。各 Agent 的原生加载与目录操作验收分开记录；目录接入不等于 Agent 已发现技能。

第一方代码使用 MIT，第三方原始 LICENSE、NOTICE 与版权声明保留。详情见[完整文档](https://github.com/Lilongxi0507/skillshelf#readme)、[安全边界](https://github.com/Lilongxi0507/skillshelf/blob/main/docs/security.md)和[来源记录](https://github.com/Lilongxi0507/skillshelf/blob/main/catalog/PROVENANCE.md)。
