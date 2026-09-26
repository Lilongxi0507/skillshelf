import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { Buffer } from 'node:buffer';
import { digestSourceMappings, digestSourceRelease, digestSourceTree } from '../packages/cli/dist/registry/manifest.js';
import { checkUpdates, installSkills, migrateSources, pinSkills, rollbackSkill, skillHistory, updateSkills } from '../packages/cli/dist/manager.js';
import { loadState } from '../packages/cli/dist/store/state.js';
import { loadCatalog } from '../packages/cli/dist/catalog/catalog.js';
import { CLI_VERSION } from '../packages/cli/dist/release.js';
import { canonicalJson, digestManifest } from '../packages/cli/dist/validation.js';

// Task 5b: source-aware update checks (metadata-only catalog changes stay
// quiet, content changes report), history + rollback --revision, and
// npm→GitHub source migration with preview and atomic apply.

const sha = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const commit = 'a'.repeat(40), repository = 'acme/tools', root = `tools-${commit}`;
const data = Buffer.from('complete skill\n'), executable = Buffer.from('#!/bin/sh\necho fixture\n');
const license = Buffer.from('MIT\n');
const file = (path_, bytes, mode = 100644, origin) => ({ path: path_, size: bytes.length, sha256: sha(bytes), mode, ...(origin ? { origin } : {}) });
function rebuild(manifest) {
  manifest.treeDigest = digestSourceTree(manifest.files);
  manifest.acquisition.manifestDigest = digestSourceMappings(manifest.acquisition.mappings, manifest.acquisition.overlays);
  manifest.releaseDigest = digestSourceRelease(manifest);
  return manifest;
}
function demoManifest(packRevision = 1, body = data) {
  return rebuild({ schemaVersion: 3, id: 'demo', name: 'demo', packRevision,
    acquisition: { kind: 'github', repository, commit, mappings: [{ sourcePath: 'Skills/demo', destinationPath: 'skills/demo' }], overlays: [
      { origin: 'license', repository, commit, sourcePath: 'LICENSE', destinationPath: 'skills/demo/LICENSE', size: license.length, sha256: sha(license), mode: 100644 },
    ] },
    provenance: { repository, commit, license: 'MIT' },
    files: [file('skills/demo/SKILL.md', body), file('skills/demo/run.sh', executable, 100755), file('skills/demo/LICENSE', license, 100644, 'license')],
    runtime: { kind: 'instructions', requiresNetwork: false } });
}
const entries = (body = data) => [
  { path: `${root}/`, type: 'Directory' },
  { path: `${root}/Skills/demo/`, type: 'Directory' },
  { path: `${root}/Skills/demo/SKILL.md`, data: body },
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
const archiveBytes = (body = data) => gzipSync(Buffer.concat([...entries(body).map(record), Buffer.alloc(1024)]));

async function scratch(t) {
  const base = await realpath(process.env.SKILLSHELF_TEST_TMP || process.env.TMPDIR || os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'run-skillshelf-t5b-'));
  const { chmodTree } = await import('../packages/cli/dist/store/local.js');
  t.after(async () => { try { await chmodTree(directory, false); } catch { /* best effort */ } await rm(directory, { recursive: true, force: true }); });
  return directory;
}
function mockCodeload(t, body = data) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (address) => {
    calls.push(String(address));
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(archiveBytes(body))); c.close(); } }));
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
function v3Catalog(manifest, catalogRevision = 1) {
  return {
    schemaVersion: 3, catalogRevision, scope: '@llx17669475', minCliVersion: CLI_VERSION,
    packs: [{ id: 'demo-pack', packRevision: manifest.packRevision, treeDigest: manifest.treeDigest, fileCount: manifest.files.length, unpackedSize: manifest.files.reduce((s, f) => s + f.size, 0), members: [manifest.id], repositories: [{ repository, commit }], title: 'demo-pack', description: 'demo pack' }],
    members: [{
      name: manifest.id, pack: 'demo-pack', packRevision: manifest.packRevision,
      acquisition: manifest.acquisition, sourceManifest: manifest,
      treeDigest: manifest.treeDigest, releaseDigest: manifest.releaseDigest,
      fileCount: manifest.files.length, unpackedSize: manifest.files.reduce((s, f) => s + f.size, 0),
      runtime: manifest.runtime, title: 'Demo Skill', description: 'Demo description', useWhen: 'Demo useWhen', examples: ['demo'], category: 'engineering', tags: ['demo'], license: 'MIT',
    }],
  };
}
async function writeCatalog(directory, catalog) {
  const filename = path.join(directory, `catalog-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(filename, JSON.stringify(catalog));
  return filename;
}

test('source-aware checks stay quiet on catalog-only revisions and report content changes', async t => {
  const home = await scratch(t);
  const calls = mockCodeload(t);
  const first = await writeCatalog(home, v3Catalog(demoManifest(1)));
  const ctxA = { home, offline: false, catalogPath: first };
  await installSkills(ctxA, ['demo'], { agents: [] });
  assert.equal(calls.length, 1);
  // (a) catalog revision only: no content update.
  const revisionOnly = await writeCatalog(home, v3Catalog(demoManifest(1), 2));
  const quiet = await checkUpdates({ home, offline: true, catalogPath: revisionOnly });
  assert.equal(quiet.updates.length, 0, 'catalog-revision-only changes must not report a content update');
  // (b) changed selected bytes: update reported with github identity and file diffs.
  const changed = demoManifest(2, Buffer.from('changed skill body\n'));
  const contentChanged = await writeCatalog(home, v3Catalog(changed));
  const report = await checkUpdates({ home, offline: true, catalogPath: contentChanged });
  assert.equal(report.updates.length, 1);
  const row = report.updates[0];
  assert.equal(row.id, 'demo');
  assert.equal(row.source, 'github');
  assert.equal(row.repository, repository);
  assert.equal(row.fromOrigin, 'github');
  assert.deepEqual(row.filesDiff.added, []);
  assert.deepEqual(row.filesDiff.removed, []);
  assert.ok(row.filesDiff.changed.some(name => name.endsWith('SKILL.md')));
  assert.equal(row.toPackRevision, 2);
  // (c) pack revision bump with identical bytes still changes release identity.
  const sameBytes = demoManifest(2);
  const revBumped = await writeCatalog(home, v3Catalog(sameBytes));
  const bump = await checkUpdates({ home, offline: true, catalogPath: revBumped });
  assert.equal(bump.updates.length, 1);
  assert.deepEqual(bump.updates[0].filesDiff.changed, []);
  assert.equal(bump.updates[0].toPackRevision, 2);
});

test('history lists releases and rollback --revision restores offline with pin preserved', async t => {
  const home = await scratch(t);
  mockCodeload(t);
  const first = await writeCatalog(home, v3Catalog(demoManifest(1)));
  await installSkills({ home, offline: false, catalogPath: first }, ['demo'], { agents: [] });
  const stateA = await loadState({ home, offline: true, catalogPath: first });
  const originalKey = stateA.selections.demo.releaseKey;
  const second = await writeCatalog(home, v3Catalog(demoManifest(2)));
  await updateSkills({ home, offline: true, catalogPath: second }, ['demo'], {});
  const history = await skillHistory({ home, offline: true, catalogPath: second }, 'demo');
  assert.equal(history.current.packRevision, 2);
  assert.ok(history.history.some(row => row.key === originalKey));
  assert.ok(history.history.every(row => row.origin === 'github'));
  // Pin the new revision; rollback to the original key offline.
  await pinSkills({ home, offline: true, catalogPath: second }, ['demo'], true, {});
  globalThis.fetch = async () => { throw new Error('offline network leak'); };
  const rolled = await rollbackSkill({ home, offline: true, catalogPath: second }, 'demo', undefined, { revision: originalKey, agents: [] });
  assert.equal(rolled.version.includes('p1'), true, 'rollback lands on packRevision 1');
  const stateB = await loadState({ home, offline: true, catalogPath: second });
  assert.equal(stateB.selections.demo.releaseKey, originalKey);
  assert.equal(stateB.selections.demo.pinned, true, 'rollback preserves pin');
  assert.ok(stateB.releases[originalKey]);
  // Missing revision rejects without changing anything.
  await assert.rejects(rollbackSkill({ home, offline: true, catalogPath: second }, 'demo', undefined, { revision: 'missing@0.0.0#' + '0'.repeat(16), agents: [] }));
  const stateC = await loadState({ home, offline: true, catalogPath: second });
  assert.equal(stateC.selections.demo.releaseKey, originalKey);
});

// npm fixture for source migration: an exact 0.2.x-era single-skill release.
const npmRuntime = { kind: 'instructions', requiresNetwork: false };
const npmFiles = [{ path: 'SKILL.md', data: Buffer.from('---\nname: demo\ndescription: Demo\n---\nComplete body.\n') }, { path: 'LICENSE', data: Buffer.from('MIT\n') }];
function npmFixture() {
  const files = npmFiles.map(f => ({ path: f.path, size: f.data.length, sha256: sha(f.data), executable: false }));
  const manifest = { schemaVersion: 1, id: 'demo', name: 'demo', files, contentDigest: digestManifest(files), runtime: npmRuntime };
  const metadata = { name: '@llx17669475/skillshelf-skill-demo', version: '0.2.1', license: 'MIT', files: ['skill/', 'skillshelf.manifest.json', 'LICENSE'] };
  const contents = [
    { path: 'package/package.json', data: Buffer.from(canonicalJson(metadata)) },
    { path: 'package/skillshelf.manifest.json', data: Buffer.from(canonicalJson(manifest)) },
    { path: 'package/LICENSE', data: npmFiles[1].data },
    ...npmFiles.map(f => ({ path: 'package/skill/' + f.path, data: f.data })),
  ];
  return { files, manifest, metadata, contents };
}
async function tarballFor(contents) {
  const lib = await import('../scripts/lib.mjs');
  return lib.makeTarball(contents);
}

test('migrate sources previews and applies npm→github, keeping legacy history', async t => {
  const home = await scratch(t);
  const fixture = npmFixture();
  const bytes = await tarballFor(fixture.contents);
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const npmEntry = { id: 'demo', name: 'demo', title: 'Demo', description: 'Demo', useWhen: 'Demo', examples: [], category: 'engineering', tags: [], collection: 'fixtures', license: 'MIT', source: {}, status: 'stable', runtime: npmRuntime, packageName: '@llx17669475/skillshelf-skill-demo', version: '0.2.1', integrity, contentDigest: fixture.manifest.contentDigest, fileCount: fixture.files.length, unpackedSize: fixture.files.reduce((s, f) => s + f.size, 0) };
  const legacyCatalog = { schemaVersion: 1, catalogVersion: CLI_VERSION, minCliVersion: CLI_VERSION, scope: '@llx17669475', categories: [{ id: 'engineering', title: 'Engineering' }], collections: [{ id: 'fixtures', title: 'Fixtures', description: 'x', skills: ['demo'] }], skills: [npmEntry] };
  const legacyFile = await writeCatalog(home, legacyCatalog);
  const original = globalThis.fetch;
  const npmCalls = [];
  globalThis.fetch = async (address) => {
    npmCalls.push(String(address));
    if (String(address).endsWith('/latest') || String(address).endsWith('/0.2.1')) {
      return new Response(JSON.stringify({ name: npmEntry.packageName, version: '0.2.1', dist: { integrity, tarball: 'https://registry.npmjs.org/@llx17669475/skillshelf-skill-demo/-/skillshelf-skill-demo-0.2.1.tgz' } }));
    }
    return new Response(new Uint8Array(bytes));
  };
  t.after(() => { globalThis.fetch = original; });
  const ctxNpm = { home, offline: false, catalogPath: legacyFile };
  await installSkills(ctxNpm, ['demo'], { agents: [] });
  const npmState = await loadState(ctxNpm);
  const npmKey = npmState.selections.demo.releaseKey;
  assert.equal(npmState.releases[npmKey].origin, 'npm');
  // Now the catalog is the v3 fixed-source catalog; migration previews.
  const codeload = mockCodeloadFor(t);
  const v3File = await writeCatalog(home, v3Catalog(demoManifest(1)));
  const ctxV3 = { home, offline: false, catalogPath: v3File };
  const preview = await migrateSources(ctxV3, { dryRun: true });
  assert.equal(preview.migrations.length, 1);
  assert.equal(preview.migrations[0].id, 'demo');
  assert.equal(preview.migrations[0].from.origin, 'npm');
  assert.equal(preview.migrations[0].to.origin, 'github');
  assert.equal(preview.migrations[0].to.repository, repository);
  assert.equal(preview.migrations[0].migratable, true);
  const stateMid = await loadState(ctxV3);
  assert.equal(stateMid.selections.demo.releaseKey, npmKey, 'dry-run must not write');
  await assert.rejects(migrateSources(ctxV3, {}), /yes/u);
  const applied = await migrateSources(ctxV3, { yes: true });
  assert.deepEqual(applied.migrated.map(row => row.id), ['demo']);
  assert.equal(applied.migrated[0].origin, 'github');
  assert.ok(applied.migrated[0].releaseKey.startsWith('demo@'));
  assert.equal(codeload.length, 1);
  const after = await loadState(ctxV3);
  const newKey = after.selections.demo.releaseKey;
  assert.notEqual(newKey, npmKey);
  assert.equal(after.releases[newKey].origin, 'github');
  assert.ok(after.releases[npmKey], 'legacy npm release stays in history');
  assert.ok(after.selections.demo.history.includes(npmKey));
  // Pinned entries are skipped by default with a reason.
  assert.equal(preview.skipped.length, 0);
});

function mockCodeloadFor(t) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (address) => {
    calls.push(String(address));
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(archiveBytes())); c.close(); } }));
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
