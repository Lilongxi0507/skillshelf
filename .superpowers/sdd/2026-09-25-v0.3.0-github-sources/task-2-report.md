# Task 2 report — GitHub fixed-commit archive adapter

## Status

DONE. Implemented inline by the controller (user directive: no implementer subagents). The predecessor's unverified test draft was validated against the binding brief, adjusted in one place (see below), and driven RED → GREEN with the full TDD cycle.

## Changed files

- `packages/cli/src/registry/paths.ts` (new) — pure archive path/root/boundary policy: strict segment validation (NFC, control/forbidden chars, per-segment NFKC separator-alias rejection, `.git`/Windows-reserved folding, 240-byte/17-segment caps), lexical link-target containment (`..` depth tracking), `ArchiveTree` incremental registry enforcing one root, spelling consistency, duplicate/case/Unicode collisions, and file/directory collisions across all non-metadata entries. No I/O; no tar-library dependency.
- `packages/cli/src/registry/github.ts` (new) — the only GitHub adapter. Single deep entry `acquireGithubSource({ manifest, signal }, deps)`; transport classification, budgets, per-cache single-flight staging, gzip single-member verification, an incremental raw 512-byte tar block scanner, PAX record allowlist, selected/unselected materialization, and multi-tuple overlay orchestration. Never touches state/store/Agent projections; `registry/tar.ts` and npm `http.ts` untouched.
- `tests/github-registry.test.mjs` — predecessor's draft verified assertion-by-assertion against the brief and Task 1's exported contract; one fixture adjustment (below); committed as the binding test surface.

## Test-draft adjustment (one)

The draft's `a/x*241` overlong-segment variant is un-encodable by its own fixture tool: node-tar's ustar `Header.encode` silently truncates names that cannot split into prefix+name (single segments are physically capped at 99 bytes), so the malicious archive could never be constructed and the iteration reported "missing expected rejection". Replaced with a third raw-mutation case (`h.fill(120, 0, 100)` — unterminated 100-byte name field) which exercises the raw gate. The 240-byte segment cap itself remains in `paths.ts` as defense-in-depth. No assertion was weakened.

## TDD evidence

### RED

```text
iso-run bash -c 'SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-task2-red-inline node --test tests/github-registry.test.mjs'
```

Result: exit 1; every test failed at `assert.equal(typeof api.acquireGithubSource, 'function')` — the explicit missing-contract failure (optional import swallows `ERR_MODULE_NOT_FOUND`). The predecessor's earlier RED log is preserved at `/tmp/skillshelf-v030-task2-red.log`.

### GREEN (focused)

```text
iso-run bash -c 'npm run build && SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-task2-green node --test tests/github-registry.test.mjs'
```

Result: exit 0. Build clean (`Copied metadata-only bootstrap (8 entries)`). Focused suite: **15 tests / 15 pass / 0 fail / 0 skipped**.

### Full regression

```text
rm -rf /tmp/skillshelf-v030-task2-full && mkdir -p /tmp/skillshelf-v030-task2-full && \
iso-run bash -c 'SKILLSHELF_TEST_TMP=/tmp/skillshelf-v030-task2-full npm test'
```

Result: exit 0. **194 tests / 163 pass / 0 fail / 31 skipped** — exactly the documented baseline (179/148/31) plus this task's 15 new tests; no new failures, no new skips. Skips remain the pre-existing packaging/development-catalog/platform-gated fixtures; not a release gate.

### Commit gates

- `git diff --cached --check`: PASS (no whitespace errors).
- GitNexus `detect_changes(scope=all, worktree=…v0.3.0)`: non-partial, non-truncated; `changed_files: 3`, `changed_symbols: 0` (both modules are new additive files with no existing graph edges), `risk_level: low`.

## Adapter security decisions

- **Two-phase streaming with an exact-framing tail check.** Fetch streams into counting/SHA-512/staging (compressed budget 128 MiB enforced per chunk regardless of Content-Length); decode runs through `createGunzip` with an expanded-byte counter and CRC32 accumulation, then the last 8 compressed bytes must equal the decoded stream's CRC32/ISIZE. This is load-bearing: empirical probing showed Node's zlib silently accepts trailing zero bytes and concatenated members, so the tail check is what rejects `[archive + 8 zero bytes]`, `[archive + empty gzip member]`, and `[archive + archive]` at the gzip layer (nonempty second archives are additionally rejected at the tar layer).
- **Raw header gate before any normalization.** Checksum (unsigned and signed variants), strict fatal UTF-8 decode, NUL-terminator purity (nonzero bytes after the first NUL rejected), clean-octal field parsing (base-256 rejected), POSIX `ustar\0`+`00` and GNU `ustar `+` \0` magic accepted, everything else rejected. Type byte allowlist is `0`/`\0`/`5`/`2`/`x`/`g`; all hardlinks, devices, FIFO, contiguous, GNU dump/longname/sparse, and unknown types are rejected anywhere in the archive. Mode policy: setuid/setgid/sticky and non-regular type bits rejected (gitlink `0160000` covered).
- **PAX allowlist.** Only `mtime/atime/ctime/comment/uname/gname/uid/gid/charset` accepted, with structural validation (exact record lengths, strict UTF-8, no NUL, no duplicate keys, newline termination, ≤64 KiB). Effective fields (`path`, `linkpath`, `type`, `size`, `mode`) and any unknown key fail closed, so effective entries can never diverge from raw bytes. Local PAX must be followed by a non-metadata entry; a local record as the last entry rejects.
- **Unselected symlink policy per spec §7.4.** Unselected symlinks are validated (raw linkpath encoding, lexical `..` depth containment inside the archive root, per-segment alias checks) and discarded without following or materializing; the real UIUX `gallery/data/styles.csv -> ../../src/ui-ux-pro-max/data/styles.csv` and Matt `AGENTS.md -> CLAUDE.md` shapes pass. Selected paths, mapping roots, ancestors of mapping roots, and expected overlay sources reject any link; hardlinks reject everywhere.
- **Archive-wide folded uniqueness.** Every non-metadata entry (selected or not) enters the `ArchiveTree` with NFC→NFKC→lower folding: duplicate, case-colliding, Unicode-alias, and file/directory collisions fail closed; exactly one root segment is established and a root-as-regular-file rejects.
- **Framing.** Two zero 512-byte blocks terminate the archive; only zero bytes may follow (extra zero padding accepted per tar blocking rules); truncated terminators, missing terminators, and nonzero tails reject.
- **Selection.** Inventory is driven entirely by the validated manifest: mapping sources resolve by exact case-sensitive boundary containment (`pathWithin`), overlays carry their own pinned `repository@commit`; every expected source must match size/SHA-256/mode exactly, no extra files under mapping roots, LFS pointers rejected; per-file and total selected budgets enforced up front and during scan.
- **Cache and concurrency.** Cache keys are exactly `repository@commit`; single-flight is scoped per `deps.cache` via WeakMap (no leakage across acquisitions); cache open revalidates the stored bytes against the receipt and discards corruption (offline → `OFFLINE_MISS`, online → single refetch); staged archives are atomically published only after every pinned tuple in the acquisition fully verifies, so one tuple's failure publishes nothing and aborts all staging.
- **Transport.** Only constructed `https://codeload.github.com/<owner>/<repo>/tar.gz/<40-lowercase-sha>` URLs; `redirect: 'error'`, `credentials: 'omit'`, no authorization header; HTTP classification `NOT_FOUND`/`FORBIDDEN`/`RATE_LIMIT` (carries `Retry-After`)/`HTTP`/`REDIRECT`; TLS failures classified from the fetch cause code; body errors → `INTERRUPTED`; no retries, no mirrors, no fallback.
- **Abort/deadline semantics.** Pre-aborted signals reject in `obtainTuple` before any fetch (zero requests). An abort landing between staging and transport still performs the fetch solely so the response body can be cancelled (hook verified firing), then rejects `ABORTED`; the gate rejection is deferred one microtask so a resolved fetch's cancellation runs first. Idle and total deadlines cancel the body stream and reject `TIMEOUT`; a cancelled stream's resolved `done` can never be mistaken for success — partial bytes are rejected before the scanner.
- **Bugs found and fixed during this task's own red→green loop** (each reproduced by a focused failing case before the fix): TLS classification read `cause.code` one level too shallow; cancel raced ahead of reader assignment; partial-body misread after cancel; whole-path NFKC separator check bypassed by legitimate separators (now per-segment); PAX body collection/label wiring; fixture's un-encodable overlong variant.

## Impact gate

`readTarball` (CRITICAL, 9 upstream symbols) and `verifySkillArchive` (CRITICAL, 14 upstream symbols) were NOT modified — the adapter is a standalone sibling; npm parser semantics and `registry/http.ts` are untouched. `detect_changes` reports no affected processes.

## Concerns

- A forged multi-member gzip whose trailing members decode to zero bytes can pass the framing tail check if its trailer is crafted to match the folded totals. Content identity is unaffected — the selected tree is verified byte-exact against the reviewed manifest and the receipt always describes the actual stored bytes — so this is an accepted, documented residual.
- GNU `L` (long-name) entries are rejected, and effective `path` PAX is rejected per the binding brief; repositories that need either cannot be acquired until their layout is reviewed. The seven pinned v0.3 sources were verified under these rules in P0.
- The adapter is standalone by design: Task 4 must wire `acquireGithubSource` into the unified acquisition dispatcher; nothing here grants execution authority and no state/store writes exist.

## Commit

`git commit` (scoped): `packages/cli/src/registry/github.ts`, `packages/cli/src/registry/paths.ts`, `tests/github-registry.test.mjs`, and this report. Message: `feat: add github fixed-commit acquisition adapter`.
