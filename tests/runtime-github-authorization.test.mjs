import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { Buffer } from 'node:buffer';
import { digestSourceMappings, digestSourceRelease, digestSourceTree } from '../packages/cli/dist/registry/manifest.js';
import { installSkills } from '../packages/cli/dist/manager.js';
import { loadState } from '../packages/cli/dist/store/state.js';
import { verifyExecutionRelease } from '../packages/cli/dist/runtime/runtime.js';
import { CLI_VERSION } from '../packages/cli/dist/release.js';

// Task 6: the two first-party tools may run from an exact trusted GitHub
// release carrying a matching first-party authorization receipt; origin
// github alone, third-party repositories, self-claimed receipts, changed
// trees or wrong entrypoints must all fail closed. Legacy npm trust is
// covered by the pre-existing runtime tests.

const sha = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const commit = 'f'.repeat(40).replace('f'.repeat(40), 'f5ce69c05d281eb1c330ea60a7c49d3560f7b677');
const repository = 'Lilongxi0507/skillshelf', root = `skillshelf-${commit}`;
const skill = Buffer.from('---\nname: skillshelf-web-search\ndescription: Web search\n---\nSearch tool.\n');
const run = Buffer.from('#!/usr/bin/env python3\nprint("search")\n');
const license = Buffer.from('MIT\n'), notice = Buffer.from('Notice\n');
const reference = Buffer.from('# API\n');
const localRun = Buffer.from('{}\n');
const direct = Buffer.from('# direct\n');
const file = (path_, bytes, mode = 100644, origin) => ({ path: path_, size: bytes.length, sha256: sha(bytes), mode, ...(origin ? { origin } : {}) });
function rebuild(manifest) {
  manifest.treeDigest = digestSourceTree(manifest.files);
  manifest.acquisition.manifestDigest = digestSourceMappings(manifest.acquisition.mappings, manifest.acquisition.overlays);
  manifest.releaseDigest = digestSourceRelease(manifest);
  return manifest;
}
function firstPartyManifest() {
  const files = [
    file('skills/skillshelf-web-search/SKILL.md', skill),
    file('skills/skillshelf-web-search/scripts/run.py', run),
    file('skills/skillshelf-web-search/scripts/direct.py', direct),
    file('skills/skillshelf-web-search/references/api.md', reference),
    file('skills/skillshelf-web-search/local-run.json', localRun),
    file('skills/skillshelf-web-search/LICENSE', license, 100644, 'license'),
    file('skills/skillshelf-web-search/NOTICE', notice, 100644, 'authored'),
  ];
  const manifest = rebuild({ schemaVersion: 3, id: 'skillshelf-web-search', name: 'skillshelf-web-search', packRevision: 1,
    acquisition: { kind: 'github', repository, commit, mappings: [{ sourcePath: 'skills/skillshelf-web-search/skill', destinationPath: 'skills/skillshelf-web-search' }], overlays: [
      { origin: 'license', repository, commit, sourcePath: 'skills/skillshelf-web-search/skill/LICENSE', destinationPath: 'skills/skillshelf-web-search/LICENSE', size: license.length, sha256: sha(license), mode: 100644 },
      { origin: 'authored', repository, commit, sourcePath: 'skills/skillshelf-web-search/skill/NOTICE', destinationPath: 'skills/skillshelf-web-search/NOTICE', size: notice.length, sha256: sha(notice), mode: 100644 },
    ] },
    provenance: { repository, commit, license: 'MIT' },
    files,
    runtime: { kind: 'python', entrypoint: 'skills/skillshelf-web-search/scripts/run.py', minimumVersion: '3.10', requiresNetwork: true, providers: ['search'], dependencies: [] } });
  // Overlays are also regular selected files: drop the duplicated body entries.
  const overlayPaths = new Set(manifest.acquisition.overlays.map(o => o.destinationPath));
  manifest.files = files.filter(f => !overlayPaths.has(f.path)).concat(manifest.acquisition.overlays.map(o => ({ path: o.destinationPath, size: o.size, sha256: o.sha256, mode: o.mode, origin: o.origin })));
  return rebuild(manifest);
}
function withAuthorization(manifest) {
  manifest.authorization = { kind: 'first-party', issuer: 'SkillShelf', repository, commit, treeDigest: manifest.treeDigest, releaseDigest: manifest.releaseDigest, entrypoint: manifest.runtime.entrypoint, tool: manifest.id, minimumVersion: '3.10', dependencies: [], providers: manifest.runtime.providers, requiresNetwork: true };
  return manifest;
}
const entries = () => [
  { path: `${root}/`, type: 'Directory' },
  { path: `${root}/skills/skillshelf-web-search/skill/`, type: 'Directory' },
  { path: `${root}/skills/skillshelf-web-search/skill/SKILL.md`, data: skill },
  { path: `${root}/skills/skillshelf-web-search/skill/scripts/run.py`, data: run },
  { path: `${root}/skills/skillshelf-web-search/skill/scripts/direct.py`, data: direct },
  { path: `${root}/skills/skillshelf-web-search/skill/references/api.md`, data: reference },
  { path: `${root}/skills/skillshelf-web-search/skill/local-run.json`, data: localRun },
  { path: `${root}/skills/skillshelf-web-search/skill/LICENSE`, data: license },
  { path: `${root}/skills/skillshelf-web-search/skill/NOTICE`, data: notice },
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
  const directory = await mkdtemp(path.join(base, 'run-skillshelf-t6-'));
  const { chmodTree } = await import('../packages/cli/dist/store/local.js');
  t.after(async () => { try { await chmodTree(directory, false); } catch { /* best effort */ } await rm(directory, { recursive: true, force: true }); });
  return directory;
}
function mockCodeload(t) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(archiveBytes())); c.close(); } }));
  t.after(() => { globalThis.fetch = original; });
}
function v3Catalog(manifest) {
  return {
    schemaVersion: 3, catalogRevision: 1, scope: '@llx17669475', minCliVersion: CLI_VERSION,
    packs: [{ id: 'skillshelf-web-search', packRevision: 1, treeDigest: manifest.treeDigest, fileCount: manifest.files.length, unpackedSize: manifest.files.reduce((s, f) => s + f.size, 0), members: [manifest.id], repositories: [{ repository, commit }], title: 'search', description: 'search' }],
    members: [{
      name: manifest.id, pack: 'skillshelf-web-search', packRevision: 1,
      acquisition: manifest.acquisition, sourceManifest: manifest,
      treeDigest: manifest.treeDigest, releaseDigest: manifest.releaseDigest,
      fileCount: manifest.files.length, unpackedSize: manifest.files.reduce((s, f) => s + f.size, 0),
      runtime: manifest.runtime, title: 'Search', description: 'Search', useWhen: 'Search', examples: ['search'], category: 'research', tags: ['search'], license: 'MIT',
    }],
  };
}

test('an authorized first-party GitHub release verifies for execution; every self-claim fails closed', async t => {
  const home = await scratch(t);
  mockCodeload(t);
  const catalogFile = path.join(home, 'catalog.json');
  const manifest = withAuthorization(firstPartyManifest());
  await writeFile(catalogFile, JSON.stringify(v3Catalog(manifest)));
  const ctx = { home, offline: false, catalogFile: undefined, catalogPath: catalogFile };
  await installSkills(ctx, ['skillshelf-web-search'], { agents: [] });
  const state = await loadState(ctx);
  const release = state.releases[state.selections['skillshelf-web-search'].releaseKey];
  assert.equal(release.origin, 'github');
  const directory = await verifyExecutionRelease(ctx, release);
  assert.ok(directory.endsWith(path.join('store', manifest.releaseDigest, 'skill')));
  assert.equal(await readFile(path.join(directory, 'scripts', 'run.py'), 'utf8'), run.toString('utf8'));

  // A changed tree loses execution trust even with a valid receipt on disk.
  const { chmodTree } = await import('../packages/cli/dist/store/local.js');
  const object = path.join(home, 'store', manifest.releaseDigest);
  await chmodTree(object, false);
  await writeFile(path.join(directory, 'scripts', 'tampered.py'), 'x');
  await assert.rejects(verifyExecutionRelease(ctx, release), /Tree|tree|manifest/i);
  await rm(path.join(directory, 'scripts', 'tampered.py'), { force: true });
  await chmodTree(object, true);

  // No authorization receipt: origin github alone grants nothing.
  const unauthorized = structuredClone(release);
  unauthorized.sourceManifest = { ...release.sourceManifest };
  delete unauthorized.sourceManifest.authorization;
  await assert.rejects(verifyExecutionRelease(ctx, unauthorized), /authorization|first-party/i);

  // A self-claimed authorization for a third-party repository never executes.
  const thirdParty = structuredClone(release);
  thirdParty.sourceManifest = structuredClone(release.sourceManifest);
  thirdParty.sourceManifest.acquisition = { ...thirdParty.sourceManifest.acquisition, repository: 'evil/fork', commit: 'a'.repeat(40) };
  await assert.rejects(verifyExecutionRelease(ctx, thirdParty), /first-party repository|third-party/i);

  // A release whose source digest does not match the installed identity fails.
  const drifted = structuredClone(release);
  drifted.contentDigest = 'e'.repeat(64);
  await assert.rejects(verifyExecutionRelease(ctx, drifted), /digest/i);
});
