# SkillShelf v0.3.0 迁移指南

## npm → GitHub 固定来源

已安装的 0.2.x npm 技能可以显式迁移到 GitHub 固定来源：

```bash
skillshelf migrate sources --dry-run   # 预览：来源、成员、许可证、风险变化
skillshelf migrate sources --yes       # 原子应用；旧 npm 版本保留在 history
```

- 固定（pinned）的安装默认跳过；先显式 `unpin` 再迁移；
- 迁移不改变投影、不自动启用新 Agent、不自动暴露新成员；
- `rollback --revision <release键>` 可离线精确回退（`--version` 仍支持旧 npm SemVer）。

## 版本语义

v0.3 起 CLI/目录版本（SemVer 0.3.0）、catalogRevision（目录修订）与 packRevision（内容修订）是三个独立数值；
`skillshelf check` 只在内容身份（releaseDigest）变化时报告更新，目录-only 修订不会触发技能更新。

## 离线与 bundle

`skillshelf export --bundle` 携带已验证内容与来源 manifest；导入时只有与本机当前可信目录完全匹配才保留 github 来源身份，
否则按本地内容恢复（可读、不可执行）。bundle 自述字段不产生任何信任。

## 已知边界

- 第一方两个工具的执行授权要求精确来源、commit、清单、入口与运行时回执；`origin: github` 本身不授予执行权；
- 旧 0.2.x npm 安装、锁与 bundle 继续可用；schema 1/2 状态按旧路径读取，不自动迁移；
- GitNexus 技能为 PolyForm Noncommercial 许可，保留 required NOTICE；Archify 附带 authored THIRD_PARTY_NOTICES。
