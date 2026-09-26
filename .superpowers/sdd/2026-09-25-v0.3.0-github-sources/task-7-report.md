# Task 7 report — CLI, MCP read-only serve, workflows, and docs

## Status
DONE. Commit `b54913e`. Full suite 222/191/0/31.

## Delivered
- **CLI**: `history <id>`, `rollback --revision <key>`, `sources check`, `migrate sources [--skill]`, `mcp serve` — all existing commands/aliases/options preserved; help verified by tests.
- **MCP serve**: wired the existing `serveDiscovery` stdio session (initialize/tools list/search/info/read/doctor; unknown tools and non-tool methods rejected; offline; response limits; metadata redaction).
- **Workflows**: `publish.yml` rewritten to the two-package v0.3 model (repo/main/exact-version/catalog-revision gates, prepare-catalog 83/8 verification, check-sources, CLI pack, `prepare-release --v3` schema-3 plan assertion, Linux/macOS/Windows × Node 22/24 matrix, OIDC provenance publish catalog-then-CLI, registry readback incl. attestations, exact-version in-workflow smoke). `public-smoke.yml`: exact @0.3.0, schema-3 catalog verification, all 8 packs from pinned GitHub sources, verify/status/history/sources check/offline bundle.
- **Docs**: `docs/release-v0.3.md`, `docs/migration-v0.3.md`, README v0.3 head (0.2.1 partial-publish history preserved as fact).

## Tests
cli-v3 (help + stable JSON + read-only + dry-run), mcp-serve (full stdio session), release-workflow (static YAML gates: two packages, no skill-package names, no credential material, OIDC, exact versions, all 8 packs).

## Notes
Cross-platform native execution of the workflows requires the GitHub Actions runners (recorded as explicit pass/skip at release time); the workflow files themselves are statically gated by tests.
