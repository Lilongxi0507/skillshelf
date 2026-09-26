# Task 4 report — Wire GitHub acquisition into the verified store

## Status

DONE. Commit `5f29559` (`feat: wire github acquisition into the verified content store`, +398 lines). Inline controller execution per user directive.

## Changed files

- `packages/cli/src/registry/acquisition.ts` (new) — the GitHub branch of the unified acquisition seam: `acquireGithubEntry(ctx, entry)` treats `entry.sourceManifest` as the self-contained trusted identity (the Task 2 adapter deep-validates it on every acquisition), materializes the verified tree into `store/<releaseDigest>/skill` with a legacy-compatible schema-1 manifest plus `source-receipt.json`, and returns `{ manifest, directory, artifact, origin: 'github', receipt }`.
- `packages/cli/src/registry/registry.ts` — `acquireVerifiedEntry` delegates github-source entries to the dispatcher before the npm/local flow; `acquireGithubEntry` re-exported. The npm exact-SRI path, local-fixture rules, staging, and convergence are untouched.
- `scripts/prepare-catalog.mjs` — Task 3 amendment: generated catalog members now carry the full validated `sourceManifest` (file lists are metadata; the whole 83-member catalog stays well under the 4 MiB budget).
- `tests/registry-github-integration.test.mjs` (new, 5 tests).

## Key design decisions

- **Store identity**: the store object key is the source manifest's `releaseDigest` (content identity, never the transport receipt). Offline store-first: an existing object is `checkGithubStore`-verified with zero fetches.
- **Legacy-compatible layout**: the materialized tree is the member's verified files relative to its member root, so `SKILL.md` sits at the tree root exactly as legacy single-skill objects; the existing `validateManifest`/`verifyTree`/projection machinery works unchanged. The receipt records `destinationPath` (the pack-relative member root) so Task 5 can recover pack-level layouts. Files are sorted the way the legacy validator normalizes them, and `contentDigest = digestManifest(files)` — byte-identical rebuilds converge.
- **Second verification**: after staging, `verifyTree` revalidates every file/hash/size/mode against the manifest before the atomic rename; EEXIST races converge onto the stored object with full receipt verification.
- **Disk cache**: `home/cache/github/<sha256(key)>/{archive.tgz, receipt.json}` implements the Task 2 `GithubCache` (open/discard/stage→publish/abort) with private-directory + link checks, incremental file-handle writes (no whole-archive memory), and atomic staging publication with EEXIST tolerance. The cache instance is memoized per home so concurrent acquisitions share the adapter's single-flight (one fetch per repo+commit); the cache key is recorded inside the receipt so a moved directory cannot masquerade as another source.
- **No fallback**: offline misses reject deterministically (`OFFLINE_MISS`); transport is the real `fetch` with the adapter constructing the only URL shape; no manager/state/store writes happen outside the verified store object.

## Impact gate

- `acquireSkill`: **CRITICAL** (10 upstream, 9 processes; pre-edit gate) — not modified; the delegation is additive inside `acquireVerifiedEntry`.
- `detect_changes(scope=all)`: non-partial, non-truncated; 2 changed symbols (`exists`, `acquireVerifiedEntry`), **6 affected processes** (all `AcquireVerifiedEntry → X` flows), **risk HIGH** — recorded per the brief: every affected process is exercised by the existing suite (registry/lifecycle/pack-lifecycle/packaging/manager flows) plus the five new integration tests; full suite green.

## TDD evidence

- RED: `ERR_MODULE_NOT_FOUND` for `dist/registry/acquisition.js` + top-level import execution of the CLI scripts (missing entry guards, fixed in Task 3d style).
- GREEN: `SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-t4-green node --test tests/registry-github-integration.test.mjs` → **5/5**: (1) trusted entry installs with second tree verify + executable modes + receipt fields incl. `destinationPath`; (2) store hit / cache hit / concurrent convergence with exactly one shared fetch; (3) bad bytes and tampered digests fail before any store commit; (4) offline store/cache reuse + deterministic misses with no fallback; (5) the dispatcher rejects entries without github source manifests (npm/local semantics unchanged — covered by the pre-existing suites).
- Full regression: **210 tests / 179 pass / 0 fail / 31 skipped** (baseline 205/174/31 + 5 new).
- Red→green fixes: TS narrowing across function boundaries (guard inside `checkGithubStore`); `contentDigest` placeholder pattern; `await` in async default parameters (ledger lesson, hit again); schema-2 pack manifests require `members` → single-member acquisitions are schema-1; legacy `validateManifest` sorts files → `storeManifestFor` sorts identically; read-only store objects require `chmodTree(…, false)` before test cleanup.

## Concerns

- Registry-level github flow through `acquireSkill`/`acquireLockedSkill` cannot go live until Task 5 wires the schema-3 catalog loader (legacy `validateCatalog` hard-requires npm identity fields — entries with `sourceManifest` are rejected there by design). Until then the delegation is exercised via the dispatcher directly; the delegation itself is three lines.
- Pack-level composition (install a whole logical pack, member exposure, projections) is Task 5; each member stores as its own verified object with the receipt carrying the pack-relative root.
- `origin: github` grants nothing: the receipt/manifest carry identity only; execution authorization is Task 6.
