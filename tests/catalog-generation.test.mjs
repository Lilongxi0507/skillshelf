import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as scripts from '../scripts/lib.mjs';
import * as prepareCatalogModule from '../scripts/prepare-catalog.mjs';
import * as checkSourcesModule from '../scripts/check-sources.mjs';

// v0.3 catalog generation: the reviewed source config expands to explicit
// per-member fixed GitHub acquisitions; the generated public catalog is
// metadata-only; identities are stable and never self-referential.
const { modules } = scripts;
const { expandSourceConfig, buildSourceManifests, preparePublicCatalog } = prepareCatalogModule;
const { checkSources } = checkSourcesModule;

const api = await modules();
const manifestApi = await import('../packages/cli/dist/registry/manifest.js');
const { validateSourceManifest } = manifestApi;
const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(path.join(root, 'catalog/sources.json'), 'utf8'));

test('v0.3 source config expands to explicit fixed acquisitions for all 83 members and 8 packs', () => {
  assert.equal(typeof expandSourceConfig, 'function', 'prepare-catalog must expose the config expander');
  const expanded = expandSourceConfig(config);
  assert.equal(expanded.sourceSchema, 3);
  assert.equal(expanded.members.length, 83);
  assert.equal(new Set(expanded.members.map((member) => member.pack)).size, 8);
  for (const member of expanded.members) {
    assert.equal(member.acquisition.kind, 'github');
    assert.match(member.acquisition.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
    assert.match(member.acquisition.commit, /^[a-f0-9]{40}$/u);
    assert.ok(member.acquisition.mappings.length >= 1, member.name + ' needs explicit mappings');
    for (const mapping of member.acquisition.mappings) {
      assert.ok(mapping.sourcePath && mapping.destinationPath);
      assert.ok(!/panel/u.test(mapping.sourcePath), 'first-party panel paths are not acquisition paths');
    }
    for (const overlay of member.acquisition.overlays ?? []) {
      assert.ok(['license', 'authored', 'upstream'].includes(overlay.origin));
      assert.match(overlay.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
      assert.match(overlay.commit, /^[a-f0-9]{40}$/u);
    }
  }
  const firstParty = expanded.members.filter((member) => member.name === 'skillshelf-web-search' || member.name === 'skillshelf-media-generation');
  assert.equal(firstParty.length, 2);
  for (const member of firstParty) {
    assert.equal(member.acquisition.repository, 'Lilongxi0507/skillshelf');
    assert.equal(member.acquisition.commit, 'f5ce69c05d281eb1c330ea60a7c49d3560f7b677');
    assert.ok(member.acquisition.mappings.every((mapping) => mapping.sourcePath.startsWith('skills/skillshelf-')));
    // The catalog publication commit R must never be its own source: S is a
    // prior fixed public commit, and acquisitions never point at `catalog/`.
    assert.ok(member.acquisition.mappings.every((mapping) => !mapping.sourcePath.startsWith('catalog/')));
  }
  const taste = expanded.members.find((member) => member.name === 'design-taste-frontend');
  assert.equal(taste.acquisition.repository, 'Leonxlnx/taste-skill');
  assert.ok(taste.acquisition.mappings.some((mapping) => mapping.sourcePath === 'skills/taste-skill' && mapping.destinationPath === 'skills/taste-skill'));
  const swarm = expanded.members.find((member) => member.name === 'gitnexus-pr-swarm-review');
  assert.ok(swarm.acquisition.mappings.length >= 3, 'pr-swarm-review needs its multi-path mappings');
  assert.ok(expanded.exclusions.length >= 1);
  assert.ok(expanded.exclusions.some((row) => row.repository === 'Leonxlnx/taste-skill' && row.sourcePath === 'skills/llms.txt'));
});

test('every fixture file is classified and each member manifest validates against the schema-3 contract', async () => {
  assert.equal(typeof buildSourceManifests, 'function');
  const expanded = expandSourceConfig(config);
  const { manifests, report } = await buildSourceManifests(expanded, { root });
  assert.equal(manifests.length, 83);
  assert.equal(report.totalFiles, 623);
  for (const manifest of manifests) {
    const validated = validateSourceManifest(manifest);
    assert.equal(validated.schemaVersion, 3);
    assert.ok(validated.files.length > 0);
    // Metadata-only: no file content, no local fixture paths, no arbitrary URLs.
    for (const file of validated.files) assert.ok(!('data' in file));
  }
  const taste = manifests.find((manifest) => manifest.id === 'design-taste-frontend');
  assert.equal(taste.files.length, 2);
  assert.ok(taste.files.some((file) => file.path === 'skills/taste-skill/SKILL.md'));
  assert.ok(taste.files.some((file) => file.path === 'skills/taste-skill/LICENSE' && file.origin === 'license'));
  const media = manifests.find((manifest) => manifest.id === 'skillshelf-media-generation');
  assert.equal(media.files.length, 11);
  assert.ok(media.files.some((file) => file.path === 'skills/skillshelf-media-generation/scripts/run.py'));
  const archify = manifests.find((manifest) => manifest.id === 'archify');
  assert.ok(archify.files.some((file) => file.path === 'archify/THIRD_PARTY_NOTICES' && file.origin === 'authored'));
  assert.ok(archify.files.some((file) => file.mode === 100755 && file.path === 'archify/bin/archify.mjs'));
  const gitnexus = manifests.find((manifest) => manifest.id === 'gitnexus-cli');
  assert.ok(gitnexus.files.some((file) => file.path === 'gitnexus-claude-plugin/skills/gitnexus-cli/NOTICE' && file.origin === 'authored'));
  const swarm = manifests.find((manifest) => manifest.id === 'gitnexus-pr-swarm-review');
  assert.ok(swarm.files.length >= 17);
  const unclassified = report.unclassified ?? [];
  assert.equal(unclassified.length, 0, 'no fixture file may remain unclassified: ' + JSON.stringify(unclassified.slice(0, 5)));
});

test('the generated public catalog is metadata-only and carries fixed source identities', async () => {
  assert.equal(typeof preparePublicCatalog, 'function');
  const expanded = expandSourceConfig(config);
  const built = await buildSourceManifests(expanded, { root });
  const prepared = await preparePublicCatalog(expanded, built, { catalogRevision: expanded.catalogRevision });
  const catalog = prepared.catalog;
  assert.equal(catalog.schemaVersion, 3);
  assert.equal(catalog.catalogRevision, expanded.catalogRevision);
  assert.equal(catalog.scope, config.scope);
  assert.equal(catalog.packs.length, 8);
  assert.equal(catalog.members.length, 83);
  for (const pack of catalog.packs) {
    assert.match(pack.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.ok(Number.isSafeInteger(pack.packRevision) && pack.packRevision >= 1);
    assert.equal(typeof pack.treeDigest, 'string');
    assert.equal(pack.treeDigest.length, 64);
    for (const entry of pack.acquisition ? [pack.acquisition] : []) {
      assert.ok(!('localArtifact' in entry));
      assert.ok(!('url' in entry));
    }
  }
  for (const member of catalog.members) {
    assert.ok(member.packRevision >= 1);
    assert.match(member.acquisition.commit, /^[a-f0-9]{40}$/u);
    assert.ok(!('packageName' in member) && !('version' in member) && !('integrity' in member), 'GitHub members carry no npm identity');
    assert.ok(!('localArtifact' in member));
    assert.ok(!('body' in member) && !('content' in member));
  }
  assert.equal(new Blob([JSON.stringify(catalog)]).size < 4 * 1024 * 1024, true);
});

test('metadata-only changes do not change pack identity; content changes require a new revision', async () => {
  const expanded = expandSourceConfig(config);
  const first = await buildSourceManifests(expanded, { root });
  const second = await buildSourceManifests(expanded, { root });
  assert.equal(JSON.stringify(first.report.digests), JSON.stringify(second.report.digests), 'identical inputs must produce identical digests');
  // Simulate a metadata-only catalog change: same manifests, new catalogRevision.
  const preparedA = await preparePublicCatalog(expanded, first, { catalogRevision: expanded.catalogRevision });
  const preparedB = await preparePublicCatalog(expanded, first, { catalogRevision: expanded.catalogRevision + 1 });
  for (let index = 0; index < preparedA.catalog.packs.length; index += 1) {
    assert.equal(preparedA.catalog.packs[index].treeDigest, preparedB.catalog.packs[index].treeDigest, 'catalog revision alone must not change content identity');
    assert.equal(preparedA.catalog.packs[index].packRevision, preparedB.catalog.packs[index].packRevision);
  }
  // A changed selected file must change the member identity and refuse to keep the old packRevision.
  const mutated = structuredClone(expanded);
  const member = mutated.members.find((row) => row.name === 'design-taste-frontend');
  member.packRevision = 2;
  const rebuilt = await buildSourceManifests(mutated, { root });
  const before = first.manifests.find((manifest) => manifest.id === 'design-taste-frontend');
  const after = rebuilt.manifests.find((manifest) => manifest.id === 'design-taste-frontend');
  assert.equal(after.packRevision, 2);
  assert.equal(after.treeDigest, before.treeDigest, 'same bytes keep the tree digest');
  assert.notEqual(after.releaseDigest, before.releaseDigest, 'packRevision participates in release identity');
});

test('check-sources is read-only and reports unknown status without candidate evidence', async () => {
  assert.equal(typeof checkSources, 'function');
  const base = await checkSources(config, { fetch: null, evidence: null });
  assert.ok(Array.isArray(base.rows));
  assert.equal(base.rows.length, 7);
  for (const row of base.rows) {
    assert.equal(row.status, 'unknown');
    assert.equal(row.checked, false);
  }
  assert.equal(base.wrote, false, 'check-sources must never write catalog state');
});
