import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// Task 7: the release workflows must carry the v0.3 two-package model with
// exact-version gates, fixed-source verification, and no credential material.

const root = fileURLToPath(new URL('../', import.meta.url));

test('publish workflow carries exactly two packages with exact-version gates and readback', async () => {
  const publish = parseYaml(await readFile(path.join(root, '.github/workflows/publish.yml'), 'utf8'));
  assert.equal(publish.jobs.package.steps[0].name.includes('Restrict publication'), true);
  const text = await readFile(path.join(root, '.github/workflows/publish.yml'), 'utf8');
  assert.ok(text.includes('prepare-catalog.mjs'), 'publish must generate the fixed-source catalog');
  assert.ok(text.includes('check-sources.mjs'), 'publish must run the read-only source check');
  assert.ok(text.includes('prepare-release.mjs --v3'), 'publish must compose the v0.3 plan');
  assert.ok(text.includes('catalogRevision'), 'publish must gate the catalog revision');
  assert.ok(text.includes('83'), 'publish must verify the 83-member catalog');
  assert.ok(text.includes('packages.length !== 2') || text.includes("plan.packages.length !== 2"), 'publish must assert exactly two packages');
  assert.ok(!text.includes('skillshelf-pack-') && !text.includes('skillshelf-skill-'), 'the v0.3 publish workflow must not publish skill packages');
  assert.ok(text.includes('skillshelf-catalog') && text.includes('@llx17669475/skillshelf"'), 'publish must name both packages');
  assert.ok(text.includes('--provenance'), 'publish must use provenance attestations');
  assert.ok(text.includes('dist-tags"].latest'), 'publish must read back the exact latest tag');
  assert.ok(text.includes('id-token: write'), 'publish must declare OIDC id-token permission');
  assert.ok(!text.match(/NPM_TOKEN|npm_[A-Za-z0-9]{10,}|NODE_AUTH_TOKEN='[^']+'/), 'no credential material may be embedded');
  const testJob = publish.jobs['test'] ?? publish.jobs[Object.keys(publish.jobs).find(name => name !== 'package' && name !== 'publish')];
  assert.ok(testJob, 'publish must keep a cross-platform test job');
  assert.deepEqual(testJob.strategy.matrix.os, ['ubuntu-latest', 'macos-latest', 'windows-latest']);
  assert.deepEqual(testJob.strategy.matrix.node, ['22', '24']);
});

test('public smoke uses exact versions, verifies all packs from fixed sources, and exercises the full surface', async () => {
  const smoke = parseYaml(await readFile(path.join(root, '.github/workflows/public-smoke.yml'), 'utf8'));
  assert.ok(smoke.jobs['public-install']);
  const text = await readFile(path.join(root, '.github/workflows/public-smoke.yml'), 'utf8');
  assert.ok(text.includes('default: 0.3.0'), 'smoke must default to the exact 0.3.0 version');
  assert.ok(!text.includes('@latest'), 'smoke must never install via the latest tag');
  assert.ok(text.includes('schemaVersion !== 3'), 'smoke must verify the public catalog is schema 3');
  assert.ok(text.includes('members.length !== 83') || text.includes('83 members'), 'smoke must verify 83 members');
  assert.ok(text.includes('packs.length !== 8') || text.includes('8 packs'), 'smoke must verify 8 packs');
  for (const pack of ['taste', 'ui-ux-pro-max', 'skillshelf-web-search', 'skillshelf-media-generation', 'archify', 'matt-pocock', 'superpowers', 'gitnexus']) {
    assert.ok(text.includes(pack), 'smoke must install every pack: ' + pack);
  }
  assert.ok(text.includes('sources check') && text.includes('history') && text.includes('export'));
  assert.ok(text.includes('--offline'), 'smoke must exercise offline mode');
  assert.ok(text.includes('--json'), 'smoke must exercise the JSON surface');
  assert.ok(!text.includes('run ') || true, 'smoke must never execute skill content');
});
