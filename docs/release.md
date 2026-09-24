# Stable release procedure

Target: `0.2.0`, channel `latest`, public namespace `@llx17669475`. Derive the 10 package identities from the generated publication plan: 8 complete skill packs (83 members), catalog, CLI.

1. Install locked dependencies with lifecycle scripts disabled; build and validate.
2. Pack skills into a new external directory with `--write-bootstrap`; copy the catalog and validate it.
3. Run the complete tests with `SKILLSHELF_TEST_TMP` and `SKILLSHELF_TEST_CATALOG`, PTY tests, and real installed-bin tests.
4. Pack the actual CLI, audit it, and generate `publication-plan.json` using `prepare-release.mjs --output <directory> --cli-tarball <archive>`.
5. Review source, licenses, package contents, exact bytes and version. Never publish credentials, local state or internal maintenance documents.
6. Push the reviewed standalone commit. Run native Linux/macOS/Windows CI. Use the manually dispatched `publish.yml` with the exact version after checking npm Trusted Publisher bindings. A new package identity needs first publication and its binding before OIDC publication can complete.
7. Publish the exact packs before catalog and CLI. On unexplained failure stop; do not repackage an existing immutable version. Read all exact versions and dist-tags back from npm, download and compare their SHA-512 to the plan.
8. Run `public-smoke.yml` and install the exact public version on the Linux test host. Development builds are never the installed operational CLI. Record limits honestly; native Windows interactive acceptance is separate.

The standalone repository excludes local handoffs, source-import scripts depending on a parent project, generated packages, dependencies, private homes and credentials. Original complete skill snapshots and their licenses remain included.
