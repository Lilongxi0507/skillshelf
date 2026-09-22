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

All initial packages start at `0.1.0-preview.1`. Final content hashes, SRI, byte
sizes and complete manifests come from the maintained-tar-generated **actual
artifact**, verified by `pack-skills.mjs`, not this narrative table.

Archive hashes above record the observed pinned codeload representation; the
pinned commit and per-file content inventory remain the authoritative reviewed
source identity if GitHub changes gzip framing later. The reviewed publication
target is `@llx17669475`, version `0.1.0-preview.1`, channel `next`, with standalone
source at https://github.com/Lilongxi0507/skillshelf. This provenance record does
not itself assert publication success; verify the exact package on npm. Source
licenses and complete content are independent of the registry account name.
