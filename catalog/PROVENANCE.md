# Initial snapshot provenance

Snapshot source retrieval is read-only and pinned. No upstream installation or
lifecycle hook is executed when preparing skill data packages. All included
licenses and attribution records are retained with their respective snapshots.

## Taste

- Repository: https://github.com/Leonxlnx/taste-skill
- Commit: `5217fb45be2c0b302f29c9cd31cbd3237501c684`
- Fetched archive: `https://codeload.github.com/Leonxlnx/taste-skill/tar.gz/5217fb45be2c0b302f29c9cd31cbd3237501c684`
- Observed archive SHA-256: `9a3f60a49bf2d49d09c7e4ceb5697f9bc4b12052e4fbd6c1d06ff8822a665992`
- License: complete root MIT, copyright 2026 Leonxlnx, included in each skill.
- Complete selected directories and name mappings live in `sources.json`.

| Skill | Snapshot files (including upstream root LICENSE) |
| --- | ---: |
| design-taste-frontend | 2 |
| design-taste-frontend-v1 | 2 |
| gpt-taste | 2 |
| image-to-code | 2 |
| imagegen-frontend-web | 2 |
| imagegen-frontend-mobile | 2 |
| brandkit | 2 |
| redesign-existing-projects | 2 |
| high-end-visual-design | 2 |
| full-output-enforcement | 2 |
| minimalist-ui | 2 |
| industrial-brutalist-ui | 2 |
| stitch-design-taste | 3 |

These small counts are the complete upstream selected directories, not truncated
SKILL.md-only exports: stitch additionally retains its reference file. No
selected resources were dropped. Original bodies remain unmodified.

## UI/UX Pro Max

- Repository: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill
- Commit: `dcc40ff5133ef78276117db0cc34e7b83cc8aeba`
- Selected tree: `.claude/skills/ui-ux-pro-max`
- Fetched archive: `https://codeload.github.com/nextlevelbuilder/ui-ux-pro-max-skill/tar.gz/dcc40ff5133ef78276117db0cc34e7b83cc8aeba`
- Observed archive SHA-256: `879f7f739b022e0aa9f3014094c7f513492220055180c9b60bc1dce9eb547833`
- **73 original skill files + complete root LICENSE = 74 files**, 3,580,413 bytes.
- License: complete root MIT, copyright 2024 Next Level Builder.

All CSV/JSON data, third-party data/font provenance and license records, scripts,
references, test resources and fixtures are retained. The unselected repository
`gallery/data/styles.csv` link is not part of this approved skill tree and was
not extracted. The selected tree contained no links. Pack verifies the exact
74-file count; npm artifact carries LICENSE both at root and inside skill.

## First-party SkillShelf standalone adaptations

Inputs authorized by the project owner:

- `clients/skills/panel-web-search/**` → `skillshelf-web-search`.
- `clients/skills/panel-media-generation/**` → `skillshelf-media-generation`.
- `clients/skills/_shared/direct.py` included in both snapshots.
- Pure protocol modules `backend/panel_toolbox/media_profiles.py` and
  `backend/panel_toolbox/video_protocol.py` included in media with an empty
  `scripts/protocols/__init__.py`.

The original inputs were copied in full. New copies only were adapted for
product names, provider configuration, environment-variable references, safer
error output and store-independent outputs. No original panel source changed.
First-party `LICENSE` is owner-authorized MIT. Each packaged `NOTICE` records
original project attribution, changes and original source file SHA-256 hashes.
There were no original NOTICE files in these approved input directories. Future
snapshot reviews must retain any upstream LICENSE and NOTICE files.

First-party snapshots retain `local-run.json`, all references, `run.py`, shared
standard-library direct IO and full protocol helpers. Search contains 7 files;
media contains 11. No package dependency install is required for these Python
scripts; runtime declaration is Python >=3.10, `dependencies: []`.

## Release integrity and limitations

The current local candidate is `0.2.0-preview.1`. Final content hashes, SRI, byte
sizes and complete manifests come from the maintained-tar-generated **actual
artifact**, verified by `pack-skills.mjs`, not this narrative table.

Archive hashes above record the observed pinned codeload representation; the
pinned commit and per-file content inventory remain the authoritative reviewed
source identity if GitHub changes gzip framing later. The reviewed publication
target is `@llx17669475`, version `0.2.0-preview.1`, channel `next`, with standalone
source at https://github.com/Lilongxi0507/skillshelf. This provenance record does
not itself assert publication success; verify the exact package on npm. Source
licenses and complete content are independent of the registry account name.

## Archify

- Repository: https://github.com/tt-a1i/archify
- Tag: `v2.16.0` (`fe2c0da92389bb35e9d71a9c7ae000c1083f2c37`)
- Commit: `c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de`
- Fetched archive SHA-256: `aa4b6c05aafaa0152f680b891c2dacf2b5d0e79d1cb61f20d48bdfa646510657`
- Selected tree: `archify/`; 190 upstream regular files, 7,234,161 bytes.
- Packaged snapshot: 191 files, including the authored `THIRD_PARTY_NOTICES`.
- License: upstream code MIT, with Cocoon AI attribution retained. The bundled
  107 brand marks retain per-mark source and license metadata; Vue is
  CC-BY-NC-SA-4.0. The complete snapshot was checked for links and special
  files; none were present.

Archify is catalog-only in the current CLI. Running its Node.js >=18 renderer,
browser visual checks, update checker, or optional brand capture remains a
caller-controlled action and is not performed by installation.

## Matt Pocock skills

- Repository: https://github.com/mattpocock/skills
- Commit: `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`
- Fetched archive SHA-256: `7938c67820cd259ebca03efa78679455c1db5156f7404a50b6c53a45fe69345a`
- Selected trees: `skills/engineering`, `skills/in-progress`,
  `skills/misc`, and `skills/productivity`; 38 complete SkillShelf snapshots.
- License: original upstream license and supporting files remain in every
  snapshot. In-progress and misc entries are marked experimental in the catalog.

The snapshots are available for selection without enabling the whole collection.
Some workflows describe issue, configuration, Git hook, or pull request actions;
those actions still require the caller's tools and explicit user authorization.

## Superpowers

- Repository: https://github.com/obra/superpowers
- Tag: `v6.4.1` (`b92c4fa87ea1252077a7f7d3bf420e52325dd25e`)
- Commit: `5bf4e78011075bcfc0dc295f0724994cd123ee71`
- Fetched archive SHA-256: `9a6bcd2862a65aff392afb61e4e0532f024b99835848fefa9f6d511a608e9ce8`
- Selected tree: `skills/`; 15 complete skills, 75 original skill files plus
  the retained root-license copies in the packaged snapshots.
- License: MIT, retained with the complete snapshots.

Superpowers remains opt-in. Its workflow instructions do not silently install
hooks, create worktrees, dispatch agents, commit changes, or override repository
or user authorization. Relative references between its skills are resolved only
when the related skills are installed or otherwise made available together.

## GitNexus

- Repository: https://github.com/abhigyanpatwari/GitNexus
- Commit: `c2ca132620ae935749fd243ee8a93dcccd870f02`
- Selected trees: `gitnexus-claude-plugin/skills/**` and
  `.claude/skills/gitnexus-pr-swarm-review`; 13 complete snapshots.
- The selected source inventory contains 56 regular upstream files; commit
  blob checks, root-license equality, required notices and zero selected/target
  symlinks were verified. The largest packaged skill tree is 181,346 bytes.
- License: **PolyForm Noncommercial 1.0.0**. Every snapshot retains the
  required notice: `Copyright Abhigyan Patwari
  (https://github.com/abhigyanpatwari/GitNexus)`.

The GitNexus CLI and MCP runtime are separate optional dependencies and are not
installed by SkillShelf (`npx -y gitnexus@1.6.12 mcp` is the upstream MCP
example). The collection is usable only for purposes permitted by PolyForm
Noncommercial; review the license before commercial deployment.
`gitnexus-pr-swarm-review` is limited to the upstream GitNexus repository and
its Claude Swarm environment, as stated by that skill.
