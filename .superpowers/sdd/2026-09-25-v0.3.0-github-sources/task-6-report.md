# Task 6 report — First-party execution authorization and offline bundles

## Status
DONE. Commit `f3d0611`. Full suite 218/187/0/31.

## Delivered
- **First-party authorization receipts**: `catalog/sources.json v3.authorizations` for both first-party tools; prepare-catalog injects computed receipts (digests computed, never hand-typed) bound by validateSourceManifest.
- **Runtime trust chain** (`runtime/runtime.ts`): github branches in `approvedEntrypoint` (declared entrypoint must be `<memberRoot>/scripts/run.py`), `requireCurated` (RUNNABLE + FIRST_PARTY_REPOSITORY Lilongxi0507/skillshelf + matching receipt binding repository/commit/tree/release + python + providers; third-party/fork/no-receipt fail), `verifiedDirectory` (on-disk source-receipt identity + verifyTree; no npm artifact). Legacy npm path unchanged.
- **Offline bundles** (`commands/portable.ts`): github exports carry origin+sourceManifest, never npm artifact claims; imports validate sourceManifest + store-view, and trust ONLY a matching current-catalog receipt (github origin with restored store object at store/<releaseDigest> incl. source-receipt.json); otherwise downgrade to local-readable content. Selection-format github imports acquire through the trusted catalog.
- `storeManifestFor` rewrites runtime.entrypoint to member-root-relative (store trees are member-relative).

## Tests
runtime-github-authorization 1/1 (authorized verify + tree tamper + no-receipt + third-party + digest drift) + bundle export/import test (trusted github restore + untrusted local downgrade). MCP serve wiring deliberately in Task 7 (its brief owns CLI/MCP).
