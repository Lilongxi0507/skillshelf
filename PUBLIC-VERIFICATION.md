# SkillShelf 0.2.1 verification

This stable release candidate contains 8 complete packs with 83 skill members, one catalog and the CLI. Publication is partially complete: 7 of 10 packages are published and verified; see the npm progress table below.

`0.2.1` re-freezes the `0.2.0` stable candidate after a full bug-fix pass; per repository rules the changed CLI bytes require a new exact version. Fixes carried by this candidate:

- `uninstall` now refuses to remove the OS home directory **or any directory containing it**; the previous guard only blocked exact equality and was reproduced deleting a whole tree that contained `$HOME`. Covered by a regression test plus an end-to-end CLI check.
- JSON error output no longer echoes a global option value as the command name (`--home <path>` used to appear as `command`).
- `author remove` and `profiles save` now require the standard preview/confirmation gate (non-interactive `--yes`/`--dry-run`), with dry-run previews added to the core functions.
- The registry client `User-Agent` now follows `CLI_VERSION` instead of a hardcoded `0.1`.
- Draft publication enforces the same strict exact-semver grammar as the catalog (`1.2.3-01` is now rejected up front).
- The legacy-member install conflict message now gives actionable CLI guidance instead of only internal API names.

## Local validation, 2026-09-24 (this candidate)

Node 26 isolated run: 167 tests, 166 passed, 0 failed, 1 skipped (Windows ACL, platform-conditional); the installed-bin test ran with the real 0.2.1 archive and passed. TDD red-green cycle was observed for every fix (6 failing tests against the unmodified build, then 24/24 after the fixes). POSIX PTY smoke: 4/4 scenarios passed. All 10 candidate archives were re-audited from the fresh 0.2.1 publication plan before any submission.

## CI

- Full three-platform CI for release commit `46a7960`: run [35996041465](https://github.com/Lilongxi0507/skillshelf/actions/runs/35996041465), 7/7 jobs succeeded (2026-09-24), including windows-latest Node.js 24.
- Publish workflow run [36023041251](https://github.com/Lilongxi0507/skillshelf/actions/runs/36023041251) (attempt 2, 2026-09-24): all six native test jobs passed; the windows-latest Node.js 24 job needed one rerun after a transient Windows ACL-probe timeout (the deliberate 10-second fail-closed bound; the identical suite passed the same commit in 35996041465). The publish job then stopped by design at the new-package row.

## Public npm progress

| Package | 0.2.1 status |
| --- | --- |
| 7 packs: taste, ui-ux-pro-max, skillshelf-web-search, skillshelf-media-generation, archify, matt-pocock, superpowers | **Published** via OIDC trusted publishing from run 36023041251. Independent read-back confirmed the exact versions, `latest` dist-tags and tarball SHA-512 against the frozen publication plan; all seven carry npm provenance. |
| `skillshelf-pack-gitnexus` | Not published. The registry rejected the new package name with E429 (new-name creation quota; four attempts on 2026-09-24 documented in the release evidence). Single retries scheduled 2026-09-25 14:50 and 22:55 +0800, spaced eight hours apart; no tight retry loops. No account, package-name or credential workaround attempted. |
| catalog, CLI | Held by design: the frozen catalog references `skillshelf-pack-gitnexus@0.2.1`, so per `docs/release.md` order the catalog and CLI publish only after that pack exists. They will be published by the same OIDC workflow in the completing run. |

Native Agent discovery and paid provider calls remain separate from CLI tests. Windows interactive testing by the maintainer remains separate from automated CI.
