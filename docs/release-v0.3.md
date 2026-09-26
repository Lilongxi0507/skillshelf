# SkillShelf v0.3.0 发布流程（双包 + GitHub 固定来源）

v0.3.0 起，npm 只发布两个包；83 项技能全部从审核过的 GitHub 固定 commit 获取：

- `@llx17669475/skillshelf-catalog@0.3.0` — metadata-only 目录（schema 3，无技能正文）
- `@llx17669475/skillshelf@0.3.0` — CLI 本体

不再发布任何新的技能 npm 包；已发布的 0.2.x 技能包保留为历史。

## 发布前门禁

1. `npm ci --ignore-scripts && npm run build && npm test` 全绿；
2. `node scripts/prepare-catalog.mjs --output <dir>` 生成目录并核对 83 成员 / 8 包 / catalogRevision；
3. `node scripts/validate-catalog.mjs --catalog <dir>/catalog.public.json` 重建比对；
4. `node scripts/check-sources.mjs` 输出固定来源只读报告；
5. `node scripts/prepare-release.mjs --v3 --output <dir> --cli-tarball <cli.tgz> --catalog <dir>/catalog.public.json` 产出 schema-3 双包计划。

## 发布步骤（需人工授权）

1. 来源提交 S（第一方内容）必须早已公开存在；发布提交 R 引用 S，绝不自引用；
2. 触发 GitHub Actions `Publish to npm`（workflow_dispatch，输入精确 version 与 catalog_revision）；
3. 工作流在 main 分支构建、矩阵测试（Linux/macOS/Windows × Node 22/24），先发布 catalog 再发布 CLI（npm Trusted Publishing + provenance）；
4. 发布后回读 registry：exact version、latest、SHA-512 SRI、provenance attestations；
5. 触发 `Public npm smoke`：公共网络安装精确版本，验证目录 83/8，逐包从 GitHub 固定来源安装并 verify，演练 history/sources check/offline bundle；
6. 服务器独立前缀安装精确公共版后，再按预览确认迁移现有共享库。

任何一步失败即停止；不覆盖同版本不可变 artifact，不谎报完成。
