# Task 5 report — Source-aware lifecycle, history, migration, and frozen locks

## Status
DONE. Commits `32bd7c3` + `8b7857a`. Full suite 216/185/0/31 at completion.

## Delivered
- **Schema-3 catalog bridge** (`catalog/catalog.ts`): `convertSourceCatalog` deep-validates every member manifest, projects curation, and bridges into the internal Catalog with deterministic `github:<id>` identities and non-SemVer display versions `<minCliVersion>+r<rev>p<packRevision>`; `normalizeLoadedCatalog` routes explicit catalogs and npm-receipt unpack through the bridge.
- **End-to-end install** (`manager.ts`): github entries install through the existing manager into schema-2 state records with `origin: 'github'`, sourceManifest, and receipt-bearing catalogEntry snapshots; state validation (`store/state.ts`) gained strict github rules (packageName `github:<id>`, empty integrity, sourceManifest validated, releaseDigest===contentDigest, store manifest equals the derived view).
- **Frozen locks** (`registry.ts` + `manager.ts`): locked github entries route straight to the verified seam (self-contained manifest = the lock trust boundary); syncFrozen restores github entries offline from store-first verification.
- **Source-aware checks**: `sourceChanged` compares releaseDigest for github entries (catalog-revision-only bumps stay quiet); checkUpdates rows carry repository/fromOrigin/fromCommit/packRevisions/filesDiff{added,removed,changed}/runtimeChanged.
- **History + rollback**: `skillHistory`; `rollbackSkill --revision` by exact release key, offline, pin-preserving.
- **Migration**: `migrateSources` dry-run previews npm→github with pinned-skip reasons; atomic apply through installSkills (legacy npm releases retained in history).

## Tests
source-migration 3/3 (bridge+legacy passthrough, install convergence+remove, frozen offline restore) + upgrade-flow 3/3 (revision-only quiet/content rows, history/rollback offline pin-preserved, migrate preview→apply). Red→green lessons in the ledger.
