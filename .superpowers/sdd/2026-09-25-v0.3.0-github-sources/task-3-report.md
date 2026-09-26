# Task 3 report — GitHub catalog manifests and two-package publication model

## Status

DONE. Implemented inline by the controller (user directive: no implementer subagents). Four scoped commits, each TDD red→green with the full regression suite green at every landing. All inventory reconciliation items from the Task 3 preflight warning are closed as explicit config data.

## Changed files (by slice)

- `scripts/lib.mjs` — added `publicationPlanV3` (slice 3a); legacy `publicationPlan(skillCount, complete)` untouched.
- `catalog/sources.json` — added the `v3` block (slice 3b): `sourceSchema: 3`, `catalogRevision: 1`, first-party commit S `Lilongxi0507/skillshelf@f5ce69c05d281eb1c330ea60a7c49d3560f7b677`, 8 packRevisions, `firstPartySources` with real S roots (`skills/skillshelf-{web-search,media-generation}/skill`), per-family `legalOverlays` (taste/uiux/matt/superpowers root LICENSE; gitnexus root LICENSE + authored NOTICE from S; archify authored THIRD_PARTY_NOTICES from S), `memberMappings` for `gitnexus-pr-swarm-review` (three disjoint mapping destinations: `…/skill`, `…/agents` from `.claude/agents`, `…/pr-swarm-review` from `pr-swarm-review`), and 5 explicit `exclusions` (taste `skills/llms.txt` + 4 Matt category READMEs) with reviewed reasons. Legacy schema-1 fields untouched.
- `scripts/prepare-catalog.mjs` (new) — `expandSourceConfig` (83 explicit acquisition descriptors; panel paths rejected), `buildSourceManifests` (classifies all 623 fixture files as mapped body or declared overlay, enriches overlays with sha256/size/mode from their fixture file, rejects unclassified files and unmatched overlays, builds and validates per-member schema-3 manifests with `digestSourceTree`/`digestSourceMappings`/`digestSourceRelease`), `preparePublicCatalog` (metadata-only schema-3 catalog: 8 packs, 83 members, repository tuples, exclusions), CLI entry requiring an explicit absolute `--output`.
- `scripts/check-sources.mjs` (new) — read-only pinned-tuple report; status `unknown` without candidate evidence; `wrote: false` always.
- `scripts/validate-catalog.mjs` (slice 3d) — exported `validateCatalogData`: schema-3 catalogs are rebuilt from the reviewed config (revision checked against the **config-declared** `catalogRevision`, not the catalog's self-report) and compared canonically — **no local tarballs required**; the legacy schema-1/2 walk including `--development` local artifact verification is preserved unchanged.
- `scripts/prepare-release.mjs` (slice 3d) — exported `buildV3ReleaseArtifacts`: validates the schema-3 catalog, builds + round-trip-verifies the metadata-only catalog archive, and composes the exact two-package schema-3 publication plan (`publicationPlanV3`). New `--v3` CLI mode; the legacy 0.2.x pack flow is preserved byte-for-byte inside the entry guard.
- `packages/cli/src/release.ts`, root `package.json`, `packages/cli/package.json`, `catalog/sources.json` version, `catalog/bootstrap.json` catalogVersion/minCliVersion (slice 3c) — version matrix advanced to 0.3.0. Bundled bootstrap keeps per-entry legacy npm versions 0.2.1 (the 0.2.x compatibility identity).
- `tests/publication-plan-v3.test.mjs` (new, 4 tests), `tests/catalog-generation.test.mjs` (new, 7 tests).

## Source count and mapping evidence

- 83 members / 8 packs expand to explicit pinned GitHub acquisitions; per-pack file classification closes exactly: taste 27 (14 body + 13 LICENSE overlays), uiux 74 (73 + 1), first-party 18 (legal files in-tree at S), archify 191 (190 + authored notice), matt 141 (103 body + 38 overlays), superpowers 90 (75 + 15), gitnexus 82 (56 body incl. 17 swarm files + 13 LICENSE + 13 NOTICE) — **623 total**, enforced by the generator (`totalFiles !== 623` fails).
- All authored overlays (gitnexus NOTICE ×13, archify THIRD_PARTY_NOTICES) pin commit S as their overlay tuple; first-party acquisitions use the real `skills/skillshelf-*/skill` roots, never `clients/skills/panel-*`.
- `gitnexus-pr-swarm-review` uses three disjoint mappings because the schema-3 validator forbids nested mapping destinations; every declared overlay must match exactly one fixture file.

## TDD evidence

- Slice 3a RED: 3 fail (`publicationPlanV3 is not a function`) / 1 pass (legacy semantics intact) → GREEN 4/4; full 198/167/0/31.
- Slice 3b RED: `ERR_MODULE_NOT_FOUND` for the new scripts → GREEN 5/5; full 203/172/0/31.
- Slice 3c: version-matrix bump; one pre-existing test coupled through the offline bundled-bootstrap fallback was fixed by advancing `catalog/bootstrap.json`; full 203/172/0/31.
- Slice 3d RED: importing the CLI scripts executed top-level code (missing entry guards) → GREEN 7/7; **full suite 205 tests / 174 pass / 0 fail / 31 skipped** (31 skips remain the pre-existing packaging/development-catalog/platform fixtures — not a release gate).
- Bugs found by these red→green loops: await in async default parameters (twice — now a ledger lesson); empty-prefix boundary suffix; config overlays lacking sha256/size/mode (generator now enriches from fixtures); catalog-revision self-report echo (validation now compares against the config-declared revision).

## Exact publication-plan output (v0.3 model)

`publicationPlanV3([catalogEntry, cliEntry], api, { catalogRevision })` → `{ schemaVersion: 3, published: false, complete: true, scope: '@llx17669475', version: '0.3.0', catalogRevision: 1, tag: 'latest', access: 'public', repository: 'https://github.com/Lilongxi0507/skillshelf.git', packages: [ @llx17669475/skillshelf-catalog@0.3.0, @llx17669475/skillshelf@0.3.0 ] }` — verified in tests including archive-integrity binding, round-trip catalog bytes, tamper rejection, and the 10-package/skill-pack drift rejections.

## Impact gates

- GitNexus `detect_changes` at every slice: non-partial, non-truncated, risk **low**, 0 affected processes. `validatePublicCatalog` (CRITICAL) was NOT modified — schema-3 validation is the additive `validateCatalogData` path; `readTarball`/`verifySkillArchive` (CRITICAL) untouched.
- `git diff --check` clean at every commit.

## Concerns

- The bundled bootstrap remains a schema-2 catalog (entries still describe legacy npm packs). Wiring the schema-3 catalog into the CLI's bootstrap/loading path belongs to Tasks 4–5; the release workflow rewrite to two packages belongs to Task 7. `buildV3ReleaseArtifacts`'s CLI mode audits the CLI archive against the current bundled bootstrap for now.
- `pack-skills.mjs`/`packs.mjs` were not given a `--github-sources` path: the v0.3 model never publishes skill-pack archives, and the 0.2.x path must stay usable for legacy fixtures/evidence (ledger ruling).
- Catalog metadata total is well under the 4 MiB budget (asserted in tests).

## Commits

- `addefdf` feat: add two-package v0.3 publication plan model (3a)
- `ee852a4` feat: generate v0.3 fixed-source catalog from reviewed fixtures (3b)
- `f0f8285` release: advance version matrix to 0.3.0 with legacy entries intact (3c)
- (this commit) feat: v0.3 catalog validation and two-package release preparation (3d)
