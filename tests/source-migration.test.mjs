import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { Buffer } from 'node:buffer';
import { digestSourceMappings, digestSourceRelease, digestSourceTree } from '../packages/cli/dist/registry/manifest.js';
import { installSkills, removeSkills } from '../packages/cli/dist/manager.js';
import { loadState } from '../packages/cli/dist/store/state.js';
import { loadCatalog } from '../packages/cli/dist/catalog/catalog.js';
import { syncFrozen } from '../packages/cli/dist/core.js';
import { CLI_VERSION } from '../packages/cli/dist/release.js';

// Task 5: schema-3 catalogs bridge into the internal catalog, install github
// members end to end through the existing manager, and frozen project locks
// restore github entries offline from their self-contained identities.

const sha = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const commit = 'a'.repeat(40), repository = 'acme/tools', root = `tools-${commit}`;
const data = Buffer.from('---\nname: demo\ndescription: Demo skill\n---\nComplete body.\n'), executable = Buffer.from('#!/bin/sh\necho fixture\n');
const license = Buffer.from('MIT\n');
const file = (path_, bytes, mode = 100644, origin) => ({ path: path_, size: bytes.length, sha256: sha(bytes), mode, ...(origin ? { origin } : {}) });
function rebuild(manifest) {
  manifest.treeDigest = digestSourceTree(manifest.files);
  manifest.acquisition.manifestDigest = digestSourceMappings(manifest.acquisition.mappings, manifest.acquisition.overlays);
  manifest.releaseDigest = digestSourceRelease(manifest);
  return manifest;
}
function demoManifest() {
  return rebuild({ schemaVersion: 3, id: 'demo', name: 'demo', packRevision: 1,
    acquisition: { kind: 'github', repository, commit, mappings: [{ sourcePath: 'Skills/demo', destinationPath: 'skills/demo' }], overlays: [
      { origin: 'license', repository, commit, sourcePath: 'LICENSE', destinationPath: 'skills/demo/LICENSE', size: license.length, sha256: sha(license), mode: 100644 },
    ] },
    provenance: { repository, commit, license: 'MIT' },
    files: [file('skills/demo/SKILL.md', data), file('skills/demo/run.sh', executable, 100755), file('skills/demo/LICENSE', license, 100644, 'license')],
    runtime: { kind: 'instructions', requiresNetwork: false } });
}
const entries = () => [
  { path: `${root}/`, type: 'Directory' },
  { path: `${root}/Skills/demo/`, type: 'Directory' },
  { path: `${root}/Skills/demo/SKILL.md`, data },
  { path: `${root}/Skills/demo/run.sh`, data: executable, mode: 0o755 },
  { path: `${root}/LICENSE`, data: license },
  { path: `${root}/unselected/blob`, data: Buffer.from('discarded') },
];
function checksum(block) { block.fill(32, 148, 156); const sum = block.reduce((a, b) => a + b, 0); block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii'); }
function record({ path: path_, type = 'File', data = Buffer.alloc(0), mode = 0o644, ...extra }) {
  const header = Buffer.alloc(512); data = Buffer.from(data);
  new Header({ path: path_, type, size: data.length, mode, uid: 0, gid: 0, mtime: new Date(0), ...extra }).encode(header);
  checksum(header);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const archiveBytes = () => gzipSync(Buffer.concat([...entries().map(record), Buffer.alloc(1024)]));

async function scratch(t) {
  const base = await realpath(process.env.SKILLSHELF_TEST_TMP || process.env.TMPDIR || os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'run-skillshelf-t5-'));
  const { chmodTree } = await import('../packages/cli/dist/store/local.js');
  t.after(async () => { try { await chmodTree(directory, false); } catch { /* best effort */ } await rm(directory, { recursive: true, force: true }); });
  return directory;
}
function mockFetch(t, bytes = archiveBytes()) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (address, options) => {
    calls.push(String(address));
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }));
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
function v3Catalog(manifest = demoManifest()) {
  return {
    schemaVersion: 3,
    catalogRevision: 1,
    scope: '@llx17669475',
    minCliVersion: CLI_VERSION,
    packs: [{ id: 'demo-pack', packRevision: 1, treeDigest: manifest.treeDigest, fileCount: manifest.files.length, unpackedSize: manifest.files.reduce((sum, file) => sum + file.size, 0), members: [manifest.id], repositories: [{ repository, commit }] }],
    members: [{
      name: manifest.id, pack: 'demo-pack', packRevision: 1,
      acquisition: manifest.acquisition, sourceManifest: manifest,
      treeDigest: manifest.treeDigest, releaseDigest: manifest.releaseDigest,
      fileCount: manifest.files.length, unpackedSize: manifest.files.reduce((sum, file) => sum + file.size, 0),
      runtime: manifest.runtime,
      title: 'Demo Skill', description: 'Demo description', useWhen: 'Demo useWhen', examples: ['demo'],
      category: 'engineering', tags: ['demo'], license: 'MIT',
    }],
  };
}
async function writeV3Catalog(directory, catalog = v3Catalog()) {
  const filename = path.join(directory, 'catalog.public.json');
  await writeFile(filename, JSON.stringify(catalog));
  return filename;
}

test('a schema-3 catalog bridges into the internal catalog with fixed github identities', async t => {
  const directory = await scratch(t);
  const catalogFile = await writeV3Catalog(directory);
  const catalog = await loadCatalog({ home: directory, offline: true, catalogPath: catalogFile });
  assert.equal(catalog.schemaVersion, 3);
  assert.equal(catalog.skills.length, 1);
  const entry = catalog.skills[0];
  assert.equal(entry.id, 'demo');
  assert.equal(entry.title, 'Demo Skill');
  assert.equal(entry.packageName, 'github:demo');
  assert.match(entry.version, /^\d+\.\d+\.\d+\+r1p1$/u);
  assert.equal(entry.integrity, '');
  assert.equal(entry.contentDigest, demoManifest().releaseDigest);
  assert.ok(entry.sourceManifest);
  assert.equal(entry.source.repository, repository);
  assert.equal(entry.source.commit, commit);
  assert.ok(catalog.collections.some(collection => collection.id === 'demo-pack' && collection.skills.includes('demo')));
  // Legacy npm entries keep flowing through the same loader untouched.
  const legacy = { schemaVersion: 1, catalogVersion: CLI_VERSION, minCliVersion: CLI_VERSION, scope: '@llx17669475',
    categories: [{ id: 'engineering', title: 'Engineering' }], collections: [{ id: 'fixtures', title: 'Fixtures', description: 'x', skills: ['demo'] }],
    skills: [{ id: 'demo', name: 'demo', title: 'Demo', description: 'Demo', useWhen: 'Demo', examples: [], category: 'engineering', tags: [], collection: 'fixtures', license: 'MIT', source: {}, status: 'stable', runtime: { kind: 'instructions', requiresNetwork: false }, packageName: '@llx17669475/skillshelf-skill-demo', version: CLI_VERSION, integrity: 'sha512-' + Buffer.from('A'.repeat(64)).toString('base64'), contentDigest: 'a'.repeat(64), fileCount: 1, unpackedSize: 10 }] };
  const legacyFile = path.join(directory, 'legacy.json');
  await writeFile(legacyFile, JSON.stringify(legacy));
  const loaded = await loadCatalog({ home: directory, offline: true, catalogPath: legacyFile });
  assert.equal(loaded.skills[0].packageName, '@llx17669475/skillshelf-skill-demo');
});

test('a github member installs end to end from a schema-3 catalog', async t => {
  const home = await scratch(t);
  const catalogFile = await writeV3Catalog(home);
  const calls = mockFetch(t);
  const ctx = { home, offline: false, catalogPath: catalogFile };
  const result = await installSkills(ctx, ['demo'], { agents: [] });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(`https://codeload.github.com/${repository}/tar.gz/`));
  assert.equal(result.installed.length, 1);
  assert.equal(result.installed[0].id, 'demo');
  const state = await loadState(ctx);
  assert.ok(state.selections.demo, 'selection recorded');
  const release = state.releases[state.selections.demo.releaseKey];
  assert.equal(release.origin, 'github');
  assert.equal(release.packageName, 'github:demo');
  assert.equal(release.contentDigest, demoManifest().releaseDigest);
  assert.ok(release.sourceManifest);
  assert.equal(release.source.repository, repository);
  assert.equal(release.catalogEntry.sourceManifest.releaseDigest, release.contentDigest);
  const storeObject = path.join(home, 'store', demoManifest().releaseDigest);
  assert.equal((await readFile(path.join(storeObject, 'skill', 'SKILL.md'), 'utf8')).includes('Complete body.'), true);
  // Re-install converges on the store without another fetch.
  await installSkills(ctx, ['demo'], { agents: [] });
  assert.equal(calls.length, 1);
  // Remove keeps the store object (rollback history) and clears the selection.
  await removeSkills(ctx, ['demo'], {});
  const after = await loadState(ctx);
  assert.ok(!after.selections.demo);
});

test('a frozen project lock restores a github member offline from its self-contained identity', async t => {
  const directory = await scratch(t);
  const home = path.join(directory, 'home');
  const project = path.join(directory, 'project');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(project, { recursive: true, mode: 0o700 });
  const catalogFile = await writeV3Catalog(home);
  const calls = mockFetch(t);
  await installSkills({ home, offline: false, catalogPath: catalogFile }, ['demo'], { agents: [] });
  assert.equal(calls.length, 1);
  globalThis.fetch = async () => { throw new Error('offline network leak'); };
  const state = await loadState({ home, offline: true, catalogPath: catalogFile });
  const release = state.releases[state.selections.demo.releaseKey];
  const entry = { ...release.catalogEntry };
  const lock = { schemaVersion: 2, catalogVersion: CLI_VERSION, skills: [{ id: 'demo', name: 'demo', packageName: 'github:demo', version: entry.version, integrity: '', contentDigest: entry.contentDigest, entry, manifest: release.manifest, source: release.source, origin: 'github' }], agents: [] };
  const spec = { schemaVersion: 2, skills: { demo: {} }, agents: [] };
  await writeFile(path.join(project, 'skillshelf-lock.json'), JSON.stringify(lock));
  await writeFile(path.join(project, 'skillshelf.json'), JSON.stringify(spec));
  const restored = await syncFrozen({ home, offline: true, catalogPath: catalogFile }, { project, yes: true });
  assert.equal(restored.restored.length, 1);
  assert.equal(restored.restored[0], 'demo');
  const after = await loadState({ home, offline: true, catalogPath: catalogFile });
  assert.ok(after.projects[project].selections.demo);
  assert.equal(after.releases[after.projects[project].selections.demo.releaseKey].origin, 'github');
});

// --- Task 6: GitHub bundles export/import with trust downgrade without a receipt ---
const core = await import('../packages/cli/dist/core.js');
const { exportSkills: exportLibrary, importSkills } = core;

test('github bundles export and import; trust only comes from a matching catalog receipt', async t => {
  const directory = await scratch(t);
  const home = path.join(directory, 'home');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const catalogFile = await writeV3Catalog(directory);
  mockFetch(t);
  const ctx = { home, offline: false, catalogPath: catalogFile };
  await installSkills(ctx, ['demo'], { agents: [] });
  const bundleDirectory = path.join(directory, 'bundle-out');
  const exported = await exportLibrary(ctx, bundleDirectory, { bundle: true, ids: ['demo'] });
  assert.equal(exported.skills.length, 1);
  const manifest = JSON.parse(await readFile(path.join(bundleDirectory, 'skillshelf-export.json'), 'utf8'));
  assert.equal(manifest.skills[0].origin, 'github');
  assert.ok(manifest.skills[0].sourceManifest);
  assert.ok(!manifest.skills[0].artifact, 'github exports never claim npm artifacts');
  assert.ok(await readdir(path.join(bundleDirectory, 'contents')).then(names => names.length === 1));

  // Import with the v3 catalog present: the exact receipt upgrades to github origin.
  const homeB = await scratch(t);
  const catalogB = await writeV3Catalog(homeB);
  const ctxB = { home: homeB, offline: true, catalogPath: catalogB };
  const restored = await importSkills(ctxB, bundleDirectory, {});
  assert.deepEqual(restored.imported, ['demo']);
  const stateB = await loadState(ctxB);
  const releaseB = stateB.releases[stateB.selections.demo.releaseKey];
  assert.equal(releaseB.origin, 'github');
  assert.equal(releaseB.sourceManifest.releaseDigest, releaseB.contentDigest);
  assert.equal((await readFile(path.join(homeB, 'store', releaseB.contentDigest, 'skill', 'SKILL.md'), 'utf8')).includes('Complete body.'), true);

  // Import without a matching catalog: bundle self-claims never create trust — local only.
  const homeC = await scratch(t);
  const ctxC = { home: homeC, offline: true };
  const restoredC = await importSkills(ctxC, bundleDirectory, {});
  assert.deepEqual(restoredC.imported, ['demo']);
  const stateC = await loadState(ctxC);
  const releaseC = stateC.releases[stateC.selections.demo.releaseKey];
  assert.equal(releaseC.origin, 'local', 'a bundle without a trusted receipt restores as local content only');
  assert.equal(releaseC.packageName, 'local:demo');
});
