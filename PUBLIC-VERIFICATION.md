# SkillShelf 0.2.1 verification

This stable release candidate contains 8 complete packs with 83 skill members, one catalog and the CLI. Publication is pending; a source commit or local build is not an npm release.

`0.2.1` re-freezes the `0.2.0` stable candidate after a full bug-fix pass; per repository rules the changed CLI bytes require a new exact version. Fixes carried by this candidate:

- `uninstall` now refuses to remove the OS home directory **or any directory containing it**; the previous guard only blocked exact equality and was reproduced deleting a whole tree that contained `$HOME`. Covered by a regression test plus an end-to-end CLI check.
- JSON error output no longer echoes a global option value as the command name (`--home <path>` used to appear as `command`).
- `author remove` and `profiles save` now require the standard preview/confirmation gate (non-interactive `--yes`/`--dry-run`), with dry-run previews added to the core functions.
- The registry client `User-Agent` now follows `CLI_VERSION` instead of a hardcoded `0.1`.
- Draft publication enforces the same strict exact-semver grammar as the catalog (`1.2.3-01` is now rejected up front).
- The legacy-member install conflict message now gives actionable CLI guidance instead of only internal API names.

## Local validation, 2026-09-24 (this candidate)

Node 26 isolated run: 167 tests, 165 passed, 0 failed, 2 skipped (Windows ACL and installed-bin setup, both platform-conditional). TDD red-green cycle was observed for every fix (6 failing tests against the unmodified build, then 24/24 after the fixes). POSIX PTY smoke: 4/4 scenarios passed. All 10 candidate archives are re-audited from the fresh 0.2.1 publication plan before any submission.

## Public registry state at re-freeze

The earlier `0.2.0-preview.1` preview attempt published 7 of the 8 pack identities on 2026-09-24 before npm returned E429. Those 7 packages exist at `0.2.0-preview.1`, were first-published manually with official browser 2FA, and were then bound and read back as Trusted Publishers for `Lilongxi0507/skillshelf` `publish.yml`; the CLI and catalog bindings are also confirmed. `skillshelf-pack-gitnexus` was never created (registry 404) and still requires a manual first publication plus its own binding.

Candidate CI and registry read-back for the exact 0.2.1 versions will be recorded after completion. Native Agent discovery and paid provider calls remain separate from CLI tests. Windows interactive testing by the maintainer remains separate from automated CI.
