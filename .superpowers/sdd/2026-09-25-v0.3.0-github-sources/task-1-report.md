# Task 1 report — schema 3 source identity and manifest contract

## Status

Completed in the isolated `feature/v0.3.0` worktree. This report was finalized by the controller after the delegated implementation worker stopped during its handoff; the actual three-file diff was reviewed, built, tested, and committed as one scoped task.

## Changed files

- `packages/cli/src/types.ts`
  - Added schema-3 source file/mapping/overlay/provenance/member/layout, archive receipt, acquisition, and execution-authorization types.
  - Added optional v0.3 acquisition/source-manifest/pack-revision fields to catalog/source/release types.
  - Preserved legacy `SkillManifest` schema 1/2, state schema 1/2, project schema 1/2, and legacy source fields.
- `packages/cli/src/registry/manifest.ts`
  - Added strict recursive validators for GitHub/npm/local acquisition descriptions, source files, mappings, overlays, provenance, member layout, runtime and authorization receipts.
  - Added `digestSourceTree` and `digestSourceRelease`; archive receipt and authorization receipt bytes are excluded from release identity to avoid compression/circular identity coupling.
  - Rejects unknown keys, unsafe/non-NFC paths, floating or uppercase commits, invalid repositories, duplicate/case/Unicode-colliding paths, file-directory collisions, invalid modes/sizes/hashes, overlay conflicts, mismatched manifests, and mismatched first-party authorization identities.
- `tests/catalog-v3.test.mjs`
  - Covers stable source/release identity, fixed SHA and path rejection, exact legacy npm identity, local non-public acquisition, overlay collisions, authorization binding, and legacy schema-2/public catalog validation.

## GitNexus impact gate

Feature-branch index: repository `/data/cloud-desktop/Desktop/Skillshelf/Skillshelf-v0.3.0`, worktree same path, indexed commit `0b37469` before this task.

- `validateManifest` upstream impact: **CRITICAL**, 33 symbols, 9 direct callers, 35 affected processes, exact epistemic coverage. This task did not modify `validateManifest`; the new validator is isolated in `registry/manifest.ts`.
- `SkillSource` context showed interface-level dispatch and lower-bound incoming coverage with four dispatch boundaries. The new fields are optional and legacy source consumers remain unchanged; later catalog/state work must re-run impact after integration.
- `detect_changes(scope=all)` was run against the linked worktree before commit. It was non-partial and non-truncated; the index recognized the shared type changes. Untracked files were then included in the scoped commit.

## TDD evidence

### RED

After the new test was written and before building the new module, the focused command was run with the compiled manifest removed:

```text
iso-run bash -c 'rm -f packages/cli/dist/registry/manifest.js; node --test tests/catalog-v3.test.mjs'
```

Result: exit code 1, `ERR_MODULE_NOT_FOUND` for `packages/cli/dist/registry/manifest.js`. This was the expected missing-production-contract failure.

### GREEN

```text
iso-run bash -c 'npm run build && SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-schema node --test tests/catalog-v3.test.mjs'
```

Result: 5 tests passed, 0 failed.

Full regression after implementation:

```text
mkdir -p /tmp/skillshelf-v030-schema-full && \
iso-run bash -c 'SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-schema-full npm test'
```

Result: 141 passed, 0 failed, 31 skipped. The skips are the existing packaging/development-catalog/platform-gated tests reported by the baseline; no new failure was introduced.

A final build plus focused test was rerun after the optional catalog/release type fields were added: 5 passed, 0 failed.

## Review notes and remaining concerns

- This task intentionally does not alter acquisition, state persistence, catalog loading, GitHub parsing, runtime execution, or publication behavior. Those consumers must adopt the contract in later tasks.
- Authorization validation binds the receipt to exact GitHub repository/commit, tree/release digest, runtime and entrypoint, but validation alone is not publisher authentication; the later runtime/catalog trust layer must independently authorize first-party receipts.
- The public v0.3 catalog still cannot use the new fields until the catalog-generation and legacy validator integration task updates its schema deliberately. Legacy npm behavior remains the current path.

## Commit

The scoped implementation commit is recorded by the controller after the final build/test gate.

## Fix round 1

### Scope and review fixes

Fix round 1 was performed on top of base commit `39f6b4f` while preserving the pre-existing uncommitted partial diff. Product/test changes remain limited to `packages/cli/src/registry/manifest.ts` and `tests/catalog-v3.test.mjs`.

- Fixed the npm acquisition expression so both `@llx17669475/skillshelf-skill-*` and `@llx17669475/skillshelf-pack-*` identities accept valid lower-case names while still requiring the fixed namespace, exact SemVer, and canonical SHA-512 SRI.
- Exported `digestSourceMappings`; `manifestDigest` is the canonical SHA-256 digest of normalized mappings plus explicit overlays only, excluding release/authorization/archive receipt fields and therefore avoiding circular identity. Authorization `mappingDigest`, when supplied, must equal the acquisition `manifestDigest`.
- Enforced fixed repository/commit identity on mappings and overlays for the one-archive contract. Mapping source and destination roots reject nested/ambiguous/case/NFKC/Unicode aliases. Selected destination files must belong to exactly one mapping using exact case-sensitive path boundaries, with only exact explicit overlay destinations exempted. Unrelated inventory, boundary-prefix confusion, file/directory collisions, overlay collisions, and overlay byte/size/mode mismatches fail closed.
- Bound supplied authorization repository, commit, mapping digest, tree/release digest, entrypoint, runtime, minimum version, dependencies, providers, network declaration, tool, skill, and member identities to the manifest or selected member. Top-level manifests bind tool/skill to the manifest id and reject member claims; member manifests require an existing member id and coherent member/tool/skill identity. GitHub origin remains insufficient authority by itself.
- Added a real positive schema-2 public catalog pack fixture and changed negative cases to recompute release/tree identities only when the mutated identity is intended to remain valid.

### TDD evidence

Initial focused RED against the current dist before the fixes:

```text
SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-schema-fix node --test tests/catalog-v3.test.mjs
```

Result: exit code 1; 9 tests, 6 passed, 3 failed. The failures were the valid GitHub manifest/authorization cases blocked by the stale manifestDigest-to-tree/release comparison and both valid npm skill/pack acquisitions rejected by the nested `NAME.source` anchors.

Additional ownership RED before wiring production ownership:

```text
SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-schema-fix node --test tests/catalog-v3.test.mjs
```

Result: exit code 1; 9 tests, 8 passed, 1 failed. The unrelated selected inventory was accepted, proving the missing mapping-ownership gate.

### Required GREEN focused gate

```text
iso-run bash -c 'npm run build && SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-schema-fix node --test tests/catalog-v3.test.mjs'
```

Result: exit code 0. Build completed with `Copied metadata-only bootstrap (8 entries); no skill content or localArtifact fields included.` Focused suite: 10 tests, 10 passed, 0 failed, 0 skipped.

### Full regression gate

```text
mkdir -p /tmp/skillshelf-v030-schema-fix-full && iso-run bash -c 'SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-schema-fix-full npm test'
```

Result: exit code 0. Full suite: 177 tests, 146 passed, 0 failed, 31 skipped. Skips are the existing packaging/development-catalog/platform-gated tests; no new failure was introduced.

### Review/commit gates

```text
git diff --check
```

Result: exit code 0; no whitespace errors.

GitNexus change detection was run with repository `/data/cloud-desktop/Desktop/Skillshelf/Skillshelf-v0.3.0`, scope `all`, and worktree `/data/cloud-desktop/Desktop/Skillshelf/Skillshelf-v0.3.0`.

Result: non-partial, non-truncated result; `changed_files: 2`, `changed_count: 81`, `affected_count: 1`, `risk_level: medium`, affected process `ValidateSourceManifest → UniquePathKey`.

### Decisions and concerns

- Kept legacy schema-1/schema-2 manifest/catalog validators and all acquisition/manager/state/tar/catalog-loader/runtime/scripts/workflows/docs files unchanged.
- `manifestDigest` remains the plan-prescribed public field; no second public mapping digest was introduced.
- The validator checks receipt/identity consistency but does not itself confer first-party authority; a later trusted catalog/runtime layer must authorize the issuer and approved first-party source. `origin: github` alone remains non-authorizing.
- Full suite retains the baseline 31 skips because development catalogs/package archives/platform fixtures are not configured in this isolated fix run.

### Commit

Fix round 1 commit: `a5045a4b6a05f0adf3c00505c2e6e1cf3ed07624` (`fix: harden schema3 manifest identity validation`).

## Fix round 2

### Scope and review fixes

Fix round 2 was performed on top of `a5045a4` and is limited to `packages/cli/src/registry/manifest.ts` and `tests/catalog-v3.test.mjs`.

- Overlay records now retain and validate their own fixed repository/40-character commit tuple. Cross-source legal/authored/license overlays are accepted when their bytes/size/mode match the selected inventory; the tuple remains in the canonical `manifestDigest`, so changing overlay identity changes the digest and release identity.
- Every declared member runtime entrypoint is now resolved relative to its member path and must exist exactly in the selected manifest file inventory. Missing member entrypoints fail before authorization acceptance.
- Source archive path spelling checks and installed destination/inventory path spelling checks now use separate namespaces. Legitimate case-renaming mappings such as `Skills/demo` -> `skills/demo` are accepted, while aliases within either tree still fail. Exact case-sensitive destination ownership and boundary checks remain unchanged.

### TDD evidence

Focused RED against the current dist before production fixes:

```text
SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-schema-fix-round2 node --test tests/catalog-v3.test.mjs
```

Result: exit code 1; 12 tests, 10 passed, 2 failed. Cross-source overlay validation failed with `Overlay source identity does not match acquisition`; a missing member runtime entrypoint was accepted. The source/destination namespace case-rename regression was added before implementation and was verified in the GREEN run.

### Required GREEN focused gate

```text
iso-run bash -c 'npm run build && SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-schema-fix-round2 node --test tests/catalog-v3.test.mjs'
```

Result: exit code 0. Build completed with `Copied metadata-only bootstrap (8 entries); no skill content or localArtifact fields included.` Focused suite: 12 tests, 12 passed, 0 failed, 0 skipped.

### Full regression gate

```text
rm -rf /tmp/skillshelf-v030-schema-fix-round2-full && mkdir -p /tmp/skillshelf-v030-schema-fix-round2-full && iso-run bash -c 'SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-schema-fix-round2-full npm test'
```

Result: exit code 0. Full suite: 179 tests, 148 passed, 0 failed, 31 skipped. Skips remain the existing packaging/development-catalog/platform-gated tests; no new failure was introduced.

### Review/commit gates

`git diff --check` passed with exit code 0 before staging. GitNexus `detect_changes` was run with repository `/data/cloud-desktop/Desktop/Skillshelf/Skillshelf-v0.3.0`, `scope=all`, and worktree `/data/cloud-desktop/Desktop/Skillshelf/Skillshelf-v0.3.0` after the round-2 implementation.

Result: non-partial, non-truncated result; `changed_files: 2`, `changed_count: 7`, `affected_count: 0`, `risk_level: low`. Changed symbols were `validateOverlay`, `validateMember`, and `validateAuthorization` plus their touched properties; no affected execution processes were reported.

### Decisions and concerns

- Kept legacy schema-1/schema-2 validators and all acquisition/manager/state/tar/catalog-loader/runtime/scripts/workflows/docs files untouched.
- Corrected the earlier fix-round ruling: overlay source tuples may differ from the primary acquisition because the approved design permits fixed legal/authored supplements from another repository/commit. No floating refs are accepted.
- The validator verifies identity consistency but does not itself grant first-party authority; `origin: github` remains non-authorizing without the later trusted catalog/runtime layer.

### Commit

Fix round 2 commit: recorded after final `detect_changes` and staged diff gates.
