import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  digestSourceRelease,
  digestSourceTree,
  validateSourceManifest,
} from '../packages/cli/dist/registry/manifest.js';
import {
  digestPackManifest,
  validateManifest,
  validatePublicCatalog,
} from '../packages/cli/dist/validation.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const commit = (letter = 'a') => letter.repeat(40);

function sourceFiles() {
  const files = [
    { path: 'demo/LICENSE', bytes: 'MIT\n', mode: 100644 },
    { path: 'demo/NOTICE', bytes: 'Notice\n', mode: 100644, origin: 'license' },
    { path: 'demo/run.mjs', bytes: '#!/usr/bin/env node\n', mode: 100755 },
  ];
  return files.map(({ path, bytes, mode }) => ({ path, size: Buffer.byteLength(bytes), sha256: sha256(bytes), mode }));
}

function validManifest() {
  const files = sourceFiles();
  const acquisition = {
    kind: 'github',
    repository: 'acme/tools',
    commit: commit(),
    mappings: [{ sourcePath: 'skills/demo', destinationPath: 'demo' }],
    overlays: [{
      origin: 'license',
      repository: 'acme/tools',
      commit: commit(),
      sourcePath: 'NOTICE',
      destinationPath: 'demo/NOTICE',
      sha256: files[1].sha256,
      size: files[1].size,
      mode: 100644,
    }],
  };
  const manifest = {
    schemaVersion: 3,
    id: 'demo',
    name: 'demo',
    packRevision: 1,
    acquisition,
    provenance: { upstream: 'acme/tools', authors: ['Acme'], license: 'MIT' },
    files,
    treeDigest: digestSourceTree(files),
    runtime: { kind: 'node', entrypoint: 'demo/run.mjs', requiresNetwork: false },
  };
  return { ...manifest, releaseDigest: digestSourceRelease(manifest) };
}

function assertRejected(value, message = '') {
  assert.throws(() => validateSourceManifest(value), /invalid|unsafe|duplicate|collision|pinned|digest|mode|size|overlay|authorization|unknown|public|mapping|commit|package|local/i, message);
}

test('valid GitHub source manifest has stable release identity independent of archive receipt bytes', () => {
  const manifest = validManifest();
  const validated = validateSourceManifest(manifest);
  assert.equal(validated.schemaVersion, 3);
  assert.equal(validated.releaseDigest, manifest.releaseDigest);

  const withReceipt = { ...manifest, archiveReceipt: { compressedSha512: 'a'.repeat(128), compressedBytes: 123 } };
  assert.equal(digestSourceRelease(withReceipt), manifest.releaseDigest);
  assert.equal(digestSourceRelease({ ...manifest, archiveReceipt: undefined }), manifest.releaseDigest);
});

test('rejects floating refs, arbitrary URLs, unsafe mappings, duplicate files, invalid modes, and overlay collisions', () => {
  const base = validManifest();
  assertRejected({ ...base, acquisition: { ...base.acquisition, commit: 'main' }, releaseDigest: undefined });
  assertRejected({ ...base, acquisition: { ...base.acquisition, commit: 'A'.repeat(40) }, releaseDigest: undefined });
  assertRejected({ ...base, acquisition: { ...base.acquisition, repository: 'https://github.com/acme/tools' }, releaseDigest: undefined });
  assertRejected({ ...base, acquisition: { ...base.acquisition, mappings: [{ sourcePath: '../secret', destinationPath: 'demo' }] }, releaseDigest: undefined });
  assertRejected({ ...base, files: [...base.files, { ...base.files[0] }], releaseDigest: undefined });
  assertRejected({ ...base, files: base.files.map((file) => file.path.endsWith('LICENSE') ? { ...file, mode: 100664 } : file), releaseDigest: undefined });
  assertRejected({
    ...base,
    acquisition: {
      ...base.acquisition,
      overlays: [...base.acquisition.overlays, { ...base.acquisition.overlays[0], sourcePath: 'OTHER', destinationPath: 'demo/NOTICE' }],
    },
    releaseDigest: undefined,
  });
});

test('requires exact npm identity and keeps local acquisition explicitly non-public', () => {
  const base = validManifest();
  assertRejected({ ...base, acquisition: { kind: 'npm', packageName: '@acme/demo', version: 'latest', integrity: 'sha512-' + Buffer.from('A'.repeat(64)).toString('base64') }, releaseDigest: undefined });
  assertRejected({ ...base, acquisition: { kind: 'npm', packageName: '@acme/demo', version: '1.0.0', integrity: 'sha256-' + 'A'.repeat(86) }, releaseDigest: undefined });
  assertRejected({ ...base, acquisition: { kind: 'local', purpose: 'public' }, releaseDigest: undefined });
  assertRejected({ ...base, acquisition: { kind: 'local', purpose: 'fixture', trusted: true }, releaseDigest: undefined });
  const local = { ...base, acquisition: { kind: 'local', purpose: 'import' } };
  assertRejected({ ...local, authorization: { kind: 'first-party', issuer: 'skillshelf', tool: 'demo', repository: commit(), commit: commit(), treeDigest: local.treeDigest, releaseDigest: local.releaseDigest, entrypoint: local.runtime.entrypoint } });
});

test('rejects a first-party authorization receipt whose identity changes', () => {
  const manifest = validManifest();
  const authorization = {
    kind: 'first-party', issuer: 'skillshelf', tool: 'demo',
    repository: manifest.acquisition.repository, commit: manifest.acquisition.commit,
    treeDigest: manifest.treeDigest, releaseDigest: manifest.releaseDigest,
    entrypoint: manifest.runtime.entrypoint,
  };
  assert.deepEqual(validateSourceManifest({ ...manifest, authorization }).authorization, authorization);
  for (const field of ['commit', 'treeDigest', 'releaseDigest', 'entrypoint']) {
    assertRejected({ ...manifest, authorization: { ...authorization, [field]: field === 'entrypoint' ? 'demo/other.mjs' : field === 'commit' ? commit('b') : 'b'.repeat(64) } });
  }
});

test('schema-2 validation and public catalog fixtures remain available', () => {
  const files = [
    { path: 'demo/LICENSE', size: 4, sha256: sha256('MIT\n'), executable: false },
    { path: 'demo/SKILL.md', size: 4, sha256: sha256('body'), executable: false },
  ];
  const runtime = { kind: 'instructions', requiresNetwork: false };
  const member = {
    id: 'demo', name: 'demo', path: 'demo', legacyId: 'demo', title: 'Demo', description: 'Demo', useWhen: 'Demo', examples: ['demo'],
    category: 'tools', subcategory: 'tools', tags: [], purpose: 'Demo', stack: [], dependencies: [], license: 'MIT', source: {}, runtime,
  };
  const manifest = { schemaVersion: 2, id: 'demo', name: 'demo', files: [...files, { path: 'LICENSE', size: 4, sha256: sha256('MIT\n'), executable: false }], contentDigest: '', runtime, members: [member] };
  manifest.contentDigest = digestPackManifest(manifest);
  assert.equal(validateManifest(manifest).schemaVersion, 2);
  const fixture = { schemaVersion: 1, catalogVersion: '0.2.1', minCliVersion: '0.2.1', scope: '@llx17669475', categories: [{ id: 'tools', title: 'Tools' }], collections: [{ id: 'fixture', title: 'Fixture', description: 'Fixture', skills: ['demo'] }], skills: [{ id: 'demo', name: 'demo', title: 'Demo', description: 'Demo', useWhen: 'Demo', examples: ['demo'], category: 'tools', tags: [], collection: 'fixture', license: 'MIT', source: {}, status: 'stable', runtime, packageName: '@llx17669475/skillshelf-skill-demo', version: '0.2.1', integrity: 'sha512-' + Buffer.from('A'.repeat(64)).toString('base64'), contentDigest: 'a'.repeat(64), fileCount: 2, unpackedSize: 8 }] };
  assert.equal(validatePublicCatalog(fixture).schemaVersion, 1);
});
