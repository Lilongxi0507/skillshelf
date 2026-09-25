import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  digestSourceMappings,
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
const mappingDigest = digestSourceMappings;

function withReleaseDigest(manifest) {
  return { ...manifest, releaseDigest: digestSourceRelease(manifest) };
}

function rebuilt(manifest, patch) {
  const next = { ...manifest, ...patch };
  if (patch.files !== undefined) next.treeDigest = digestSourceTree(next.files);
  if (patch.acquisition !== undefined) {
    next.acquisition = patch.acquisition;
    if (next.acquisition.kind === 'github') {
      next.acquisition.manifestDigest = mappingDigest(next.acquisition.mappings, next.acquisition.overlays ?? []);
    }
  }
  return withReleaseDigest(next);
}

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
  acquisition.manifestDigest = mappingDigest(acquisition.mappings, acquisition.overlays);
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

function assertRejected(value, expected = /invalid|unsafe|duplicate|colli|pinned|digest|mode|size|overlay|authorization|unknown|public|mapping|commit|package|local/i, message = '') {
  assert.throws(() => validateSourceManifest(value), expected, message);
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

test('accepts valid fixed npm skill and pack acquisitions', () => {
  const base = validManifest();
  for (const packageName of ['@llx17669475/skillshelf-skill-demo', '@llx17669475/skillshelf-pack-demo-pack']) {
    const manifest = withReleaseDigest({
      ...base,
      acquisition: {
        kind: 'npm',
        packageName,
        version: '1.2.3',
        integrity: 'sha512-' + Buffer.from('A'.repeat(64)).toString('base64'),
      },
    });
    assert.equal(validateSourceManifest(manifest).acquisition.packageName, packageName);
  }
});

test('binds manifestDigest to canonical mappings and overlays without circular release identity', () => {
  const manifest = validManifest();
  assert.equal(manifest.acquisition.manifestDigest, mappingDigest(manifest.acquisition.mappings, manifest.acquisition.overlays));
  assert.notEqual(manifest.acquisition.manifestDigest, manifest.releaseDigest);
  assertRejected({ ...manifest, acquisition: { ...manifest.acquisition, manifestDigest: 'b'.repeat(64) } });
  assertRejected({ ...manifest, acquisition: { ...manifest.acquisition, manifestDigest: manifest.releaseDigest } });
});

test('rejects floating refs, arbitrary URLs, unsafe mappings, duplicate files, invalid modes, and overlay collisions', () => {
  const base = validManifest();
  assertRejected(rebuilt(base, { acquisition: { ...base.acquisition, commit: 'main' } }));
  assertRejected(rebuilt(base, { acquisition: { ...base.acquisition, commit: 'A'.repeat(40) } }));
  assertRejected(rebuilt(base, { acquisition: { ...base.acquisition, repository: 'https://github.com/acme/tools' } }));
  assertRejected(rebuilt(base, { acquisition: { ...base.acquisition, mappings: [{ sourcePath: '../secret', destinationPath: 'demo' }] } }));
  assertRejected(rebuilt(base, { files: [...base.files, { ...base.files[0] }] }));
  assertRejected(rebuilt(base, { files: base.files.map((file) => file.path.endsWith('LICENSE') ? { ...file, mode: 100664 } : file) }));
  assertRejected(rebuilt(base, {
    acquisition: {
      ...base.acquisition,
      overlays: [...base.acquisition.overlays, { ...base.acquisition.overlays[0], sourcePath: 'OTHER', destinationPath: 'demo/NOTICE' }],
    },
  }));
  assertRejected(rebuilt(base, {
    acquisition: {
      ...base.acquisition,
      overlays: [{ ...base.acquisition.overlays[0], repository: 'other/tools' }],
    },
  }), /overlay source identity/i);
});

test('requires non-overlapping mapping roots and exact selected-file ownership', () => {
  const base = validManifest();
  assertRejected(rebuilt(base, {
    acquisition: {
      ...base.acquisition,
      mappings: [
        { sourcePath: 'skills', destinationPath: 'demo' },
        { sourcePath: 'skills/extra', destinationPath: 'demo/nested' },
      ],
    },
  }));
  assertRejected(rebuilt(base, {
    acquisition: {
      ...base.acquisition,
      mappings: [
        { sourcePath: 'skills', destinationPath: 'demo' },
        { sourcePath: 'skills/demo', destinationPath: 'other' },
      ],
    },
  }));
  assertRejected(rebuilt(base, {
    files: [...base.files, { path: 'unrelated/file', size: 1, sha256: sha256('x'), mode: 100644 }],
  }), /ownership|mapping|selected|unrelated/i);
  assertRejected(rebuilt(base, {
    files: [...base.files, { path: 'demo-other/file', size: 1, sha256: sha256('x'), mode: 100644 }],
  }), /ownership|mapping|selected/i);
  assertRejected(rebuilt(base, {
    files: [...base.files, { path: 'demo', size: 1, sha256: sha256('x'), mode: 100644 }],
  }), /file.directory|collision/i);
  assertRejected(rebuilt(base, {
    acquisition: {
      ...base.acquisition,
      mappings: [{ sourcePath: 'skills/demo', destinationPath: 'Demo' }],
    },
  }), /case|collision|ownership/i);
  assertRejected(rebuilt(base, {
    files: [...base.files, { path: 'demo/NOTICE/child', size: 1, sha256: sha256('x'), mode: 100644 }],
  }), /file.directory|collision/i);
  assertRejected(rebuilt(base, {
    acquisition: {
      ...base.acquisition,
      overlays: [{ ...base.acquisition.overlays[0], destinationPath: 'demo' }],
    },
  }), /overlay|file.directory|collision/i);
});

test('rejects case-colliding directory spellings in selected inventory', () => {
  const base = validManifest();
  assertRejected(rebuilt(base, {
    files: [...base.files, { path: 'Demo/other', size: 1, sha256: sha256('x'), mode: 100644 }],
  }));
});

test('requires exact npm identity and keeps local acquisition explicitly non-public', () => {
  const base = validManifest();
  assertRejected({ ...base, acquisition: { kind: 'npm', packageName: '@acme/demo', version: 'latest', integrity: 'sha512-' + Buffer.from('A'.repeat(64)).toString('base64') } });
  assertRejected({ ...base, acquisition: { kind: 'npm', packageName: '@acme/demo', version: '1.0.0', integrity: 'sha256-' + 'A'.repeat(86) } });
  assertRejected({ ...base, acquisition: { kind: 'local', purpose: 'public' } });
  assertRejected({ ...base, acquisition: { kind: 'local', purpose: 'fixture', trusted: true } });
  const local = rebuilt(base, { acquisition: { kind: 'local', purpose: 'import' } });
  assertRejected({ ...local, authorization: { kind: 'first-party', issuer: 'skillshelf', tool: 'demo', repository: 'acme/tools', commit: commit(), treeDigest: local.treeDigest, releaseDigest: local.releaseDigest, entrypoint: local.runtime.entrypoint } });
});

test('rejects a first-party authorization receipt whose identity changes', () => {
  const manifest = validManifest();
  const authorization = {
    kind: 'first-party', issuer: 'skillshelf', tool: 'demo',
    repository: manifest.acquisition.repository, commit: manifest.acquisition.commit,
    mappingDigest: manifest.acquisition.manifestDigest,
    treeDigest: manifest.treeDigest, releaseDigest: manifest.releaseDigest,
    entrypoint: manifest.runtime.entrypoint,
  };
  assert.deepEqual(validateSourceManifest({ ...manifest, authorization }).authorization, authorization);
  assertRejected({ ...manifest, authorization: { ...authorization, mappingDigest: 'b'.repeat(64) } }, /mapping digest/i);
  for (const field of ['commit', 'treeDigest', 'releaseDigest', 'entrypoint']) {
    assertRejected({ ...manifest, authorization: { ...authorization, [field]: field === 'entrypoint' ? 'demo/other.mjs' : field === 'commit' ? commit('b') : 'b'.repeat(64) } });
  }
});

test('binds authorization identity to a declared member and its runtime', () => {
  const base = validManifest();
  const manifest = rebuilt(base, {
    members: [{
      id: 'demo-member', name: 'Demo member', path: 'demo',
      runtime: { kind: 'node', entrypoint: 'run.mjs', requiresNetwork: false },
    }],
    layout: [{ memberId: 'demo-member', path: 'demo' }],
  });
  const authorization = {
    kind: 'first-party', issuer: 'skillshelf', tool: 'demo-member', skillId: 'demo-member', memberId: 'demo-member',
    repository: manifest.acquisition.repository, commit: manifest.acquisition.commit,
    mappingDigest: manifest.acquisition.manifestDigest,
    treeDigest: manifest.treeDigest, releaseDigest: manifest.releaseDigest,
    entrypoint: 'demo/run.mjs', runtime: manifest.members[0].runtime,
    requiresNetwork: false,
  };
  assert.deepEqual(validateSourceManifest({ ...manifest, authorization }).authorization, authorization);
  assertRejected({ ...manifest, authorization: { ...authorization, memberId: 'other' } }, /member identity/i);
  assertRejected({ ...manifest, authorization: { ...authorization, tool: 'demo' } }, /tool identity/i);
  assertRejected({ ...manifest, authorization: { ...authorization, skillId: 'demo' } }, /skill identity/i);
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

  const packCatalogFixture = {
    schemaVersion: 2,
    catalogVersion: '0.2.1',
    minCliVersion: '0.2.1',
    scope: '@llx17669475',
    categories: [{ id: 'tools', title: 'Tools' }],
    collections: [{ id: 'fixture', title: 'Fixture', description: 'Fixture', skills: ['demo'] }],
    skills: [{
      id: 'demo', name: 'demo', title: 'Demo', description: 'Demo', useWhen: 'Demo', examples: ['demo'],
      category: 'tools', tags: [], collection: 'fixture', license: 'MIT', source: {}, status: 'stable', runtime,
      packageName: '@llx17669475/skillshelf-pack-demo', version: '0.2.1',
      integrity: 'sha512-' + Buffer.from('A'.repeat(64)).toString('base64'), contentDigest: 'a'.repeat(64), fileCount: 3, unpackedSize: 12,
      kind: 'pack', members: [member],
    }],
  };
  assert.equal(validatePublicCatalog(packCatalogFixture).schemaVersion, 2);
});
