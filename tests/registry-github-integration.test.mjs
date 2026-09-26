import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { Buffer } from 'node:buffer';
import { digestManifest } from '../packages/cli/dist/validation.js';
import { digestSourceMappings, digestSourceRelease, digestSourceTree } from '../packages/cli/dist/registry/manifest.js';
import { acquireGithubEntry } from '../packages/cli/dist/registry/acquisition.js';
import { chmodTree } from '../packages/cli/dist/store/local.js';

// Task 4: GitHub entries acquire through the unified verified store seam.
// The dispatcher treats entry.sourceManifest as the self-contained trusted
// identity (deep-validated by the adapter on every acquisition), materializes
// the verified tree into store/<releaseDigest>/skill with a legacy-compatible
// manifest plus a source receipt, and never falls back across sources.
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
  const directory = await mkdtemp(path.join(base, 'run-skillshelf-github-store-'));
  t.after(async () => { try { await chmodTree(directory, false); } catch { /* best effort */ } await rm(directory, { recursive: true, force: true }); });
  // The home itself must NOT pre-exist: on Windows the product creates it
  // with private ACLs; a pre-made directory inherits broad runner ACLs.
  return path.join(directory, 'home');
}
function mockFetch(t, bytes = archiveBytes()) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (address, options) => {
    calls.push(String(address));
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }));
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const entry = (manifest = demoManifest()) => ({ id: manifest.id, name: manifest.name, runtime: manifest.runtime, sourceManifest: manifest });
const memberRootOf = (source) => {
  const mappings = source.acquisition.mappings;
  if (mappings.length === 1) return mappings[0].destinationPath;
  const shallowest = Math.min(...mappings.map(m => m.destinationPath.split('/').length));
  const first = [...mappings].sort((a, b) => a.destinationPath.length - b.destinationPath.length)[0].destinationPath;
  return first.split('/').slice(0, shallowest - 1).join('/');
};
const legacyManifestFor = (source) => {
  const root = memberRootOf(source);
  const manifest = { schemaVersion: 1, id: source.id, name: source.name, files: source.files.map(f => ({ path: f.path.slice(root.length + 1), size: f.size, sha256: f.sha256, executable: f.mode === 100755 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), runtime: source.runtime };
  manifest.contentDigest = digestManifest(manifest.files);
  return manifest;
};

test('a trusted GitHub entry installs the verified selected tree into the normal store', async t => {
  const home = await scratch(t);
  const calls = mockFetch(t);
  const source = demoManifest();
  const result = await acquireGithubEntry({ home, offline: false }, entry(source));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith('https://codeload.github.com/'));
  const object = path.join(home, 'store', source.releaseDigest);
  assert.deepEqual((await readdir(object)).sort(), ['manifest.json', 'skill', 'source-receipt.json']);
  const stored = JSON.parse(await readFile(path.join(object, 'manifest.json'), 'utf8'));
  assert.equal(stored.schemaVersion, 1);
  assert.deepEqual(stored, legacyManifestFor(source));
  assert.equal(await readFile(path.join(object, 'skill', 'SKILL.md'), 'utf8'), 'complete skill\n');
  const runStat = await lstat(path.join(object, 'skill', 'run.sh'));
  // NTFS does not carry the POSIX executable bit; on Windows the materialized
  // mode is the manifest declaration (the product's own verifyTree convention).
  assert.ok(process.platform === 'win32' || (runStat.mode & 0o111) !== 0, 'executable mode must be materialized');
  assert.ok(stored.files.some(file => file.path === 'run.sh' && file.executable), 'the store manifest declares the executable bit');
  const receipt = JSON.parse(await readFile(path.join(object, 'source-receipt.json'), 'utf8'));
  assert.equal(receipt.repository, repository);
  assert.equal(receipt.commit, commit);
  assert.equal(receipt.releaseDigest, source.releaseDigest);
  assert.equal(receipt.treeDigest, source.treeDigest);
  assert.equal(receipt.destinationPath, 'skills/demo');
  assert.equal(receipt.archiveReceipt.compressedSha512, sha(archiveBytes(), 'sha512'));
  assert.equal(result.manifest.contentDigest, stored.contentDigest);
  assert.equal(result.directory, path.join(object, 'skill'));
  assert.equal(result.origin, 'github');
});

test('store hits, cache hits and concurrent calls converge without extra fetches', async t => {
  const home = await scratch(t);
  const calls = mockFetch(t);
  const source = demoManifest();
  const first = await acquireGithubEntry({ home, offline: false }, entry(source));
  assert.equal(calls.length, 1);
  const second = await acquireGithubEntry({ home, offline: false }, entry(source));
  assert.equal(calls.length, 1, 'store hit must not fetch');
  assert.equal(second.manifest.contentDigest, first.manifest.contentDigest);
  await chmodTree(path.join(home, 'store', source.releaseDigest), false); await rm(path.join(home, 'store', source.releaseDigest), { recursive: true, force: true });
  const third = await acquireGithubEntry({ home, offline: false }, entry(source));
  assert.equal(calls.length, 1, 'cache hit must not fetch');
  const fresh = await scratch(t);
  const concurrentCalls = mockFetch(t);
  const [a, b] = await Promise.all([
    acquireGithubEntry({ home: fresh, offline: false }, entry(source)),
    acquireGithubEntry({ home: fresh, offline: false }, entry(source)),
  ]);
  assert.equal(concurrentCalls.length, 1, 'concurrent same-digest acquisitions share one fetch');
  assert.equal(a.manifest.contentDigest, b.manifest.contentDigest);
});

test('bad bytes or identity fail before any store commit', async t => {
  const home = await scratch(t);
  const mutated = entries().map(e => e.data === data ? { ...e, data: Buffer.alloc(data.length, 65) } : e);
  const calls = mockFetch(t, gzipSync(Buffer.concat([...mutated.map(record), Buffer.alloc(1024)])));
  await assert.rejects(acquireGithubEntry({ home, offline: false }, entry()), /SHA-256|archive|selected/i);
  assert.equal(calls.length, 1);
  assert.deepEqual(await readdir(path.join(home, 'store')).catch(() => []), []);
  const tampered = demoManifest();
  tampered.files[0].size = 999;
  await assert.rejects(acquireGithubEntry({ home, offline: false }, entry(tampered)), /digest|manifest/i);
});

test('offline behavior reuses verified store and cache and fails deterministically on a miss', async t => {
  const home = await scratch(t);
  const calls = mockFetch(t);
  const source = demoManifest();
  await acquireGithubEntry({ home, offline: false }, entry(source));
  globalThis.fetch = async () => { throw new Error('offline network leak'); };
  const storeHit = await acquireGithubEntry({ home, offline: true }, entry(source));
  assert.ok(storeHit.directory.includes(path.join('store', source.releaseDigest)));
  await chmodTree(path.join(home, 'store', source.releaseDigest), false); await rm(path.join(home, 'store', source.releaseDigest), { recursive: true, force: true });
  const cacheHit = await acquireGithubEntry({ home, offline: true }, entry(source));
  assert.ok(cacheHit.directory.includes(path.join('store', source.releaseDigest)));
  await chmodTree(path.join(home, 'store', source.releaseDigest), false); await rm(path.join(home, 'store', source.releaseDigest), { recursive: true, force: true });
  await chmodTree(path.join(home, 'cache'), false); await rm(path.join(home, 'cache'), { recursive: true, force: true });
  await assert.rejects(acquireGithubEntry({ home, offline: true }, entry(source)), /Offline|OFFLINE/u);
  const fresh = await scratch(t);
  globalThis.fetch = async () => { throw new Error('offline network leak'); };
  await assert.rejects(acquireGithubEntry({ home: fresh, offline: true }, entry()), /Offline|OFFLINE/u);
});

test('npm and local-fixture acquisitions keep their exact existing semantics', async () => {
  // The npm exact-SRI path and the explicit local-fixture path are exercised by
  // the pre-existing suites (registry.test.mjs, packaging tests). Task 4 only
  // ADDS the github branch; acquireGithubEntry must never accept an entry
  // without a github source manifest.
  await assert.rejects(acquireGithubEntry({ home: '/tmp/x', offline: false }, { id: 'demo', name: 'demo' }), /source manifest|github/i);
  const npmish = { id: 'demo', name: 'demo', packageName: '@llx17669475/skillshelf-skill-demo', integrity: 'sha512-' + Buffer.from('A'.repeat(64)).toString('base64') };
  await assert.rejects(acquireGithubEntry({ home: '/tmp/x', offline: false }, npmish), /source manifest|github/i);
});
