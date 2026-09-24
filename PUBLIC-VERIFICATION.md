# SkillShelf 0.2.0 verification

This stable release candidate contains 8 complete packs with 83 skill members, one catalog and the CLI. Publication is pending; a source commit or local build is not an npm release.

The stable CLI follows `latest`. Install an exact registry version when reproducing a release. Full source licenses and pinned provenance are retained in `catalog/PROVENANCE.md`.

Current candidate validation and registry read-back will be recorded after completion. Earlier preview CI does not certify these exact stable artifacts. Native Agent discovery and paid provider calls are separate from CLI tests. Windows interactive testing by the maintainer remains separate from automated CI.

## Linux validation, 2026-09-24

Node 24 isolated run: 162 tests, 160 passed, 2 skipped (native Windows ACL and installed-bin setup). The installed-bin test was then run separately with the real archive and passed, including update to a strictly newer synthetic version, rollback, integrity and interrupted-operation recovery. Four POSIX PTY scenarios passed. All 10 actual archives were audited.

The initial CI exposed a stale expected update-fixture version; this test was corrected. The candidate runtime and package bytes did not change. Current CI: https://github.com/Lilongxi0507/skillshelf/actions/runs/35974131784 .

## npm publication blocked

On 2026-09-24, the attempt to publish `@llx17669475/skillshelf-pack-gitnexus@0.2.0` returned E429. Subsequent publication stopped. No stable 0.2.0 release completion is claimed. The account identity check succeeded, but the registry has not supplied a confirmed quota reset time. No account, package-name or credential workaround was attempted.

Linux and macOS native CI passed on Node 22 and 24 for commit deb6924; Windows jobs are still running as of this record. Registry read-back confirms GitNexus and CLI exact 0.2.0 versions are absent (404).
