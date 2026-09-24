import assert from 'node:assert/strict';
import test from 'node:test';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCliArchive, CLI_ALLOWED_FILES } from '../scripts/audit-cli-package.mjs';
import { assertPublicationMetadata, assertReleaseConfig, catalogNotice, integrityFor, makeTarball, modules, outputDirectory, publicationEntry, publicationMetadata, publicationPlan, readRegularFile, validateOutputPath, verifyCatalogArchive, writeUnchangedOrNew } from '../scripts/lib.mjs';

const api = await modules();
const version = api.CLI_VERSION;
async function scratch(t) {
  const base = await realpath(process.env.SKILLSHELF_TEST_TMP || process.env.TMPDIR || os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'run-skillshelf-packaging-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function fixtureCatalog() {
  const names = Array.from({ length: 16 }, (_, index) => 'fixture-' + index);
  return api.validatePublicCatalog({ schemaVersion: 1, catalogVersion: version, minCliVersion: version, scope: api.ALLOWED_SCOPE,
    categories: [{ id: 'fixtures', title: 'Fixtures' }], collections: [{ id: 'fixtures', title: 'Fixtures', description: 'Test packages', skills: names }],
    skills: names.map(name => ({ id: name, name, title: name, description: 'Complete fixture', useWhen: 'Unit tests', examples: [], category: 'fixtures', tags: [], collection: 'fixtures', license: 'MIT', source: { path: 'fixtures/' + name }, status: 'stable', runtime: { kind: 'instructions', requiresNetwork: false }, packageName: `${api.ALLOWED_SCOPE}/skillshelf-skill-${name}`, version, integrity: integrityFor(Buffer.from(name)), contentDigest: 'a'.repeat(64), fileCount: 2, unpackedSize: 20 })) });
}
function fixtureCli(catalog = fixtureCatalog()) {
  const metadata = { name: `${api.ALLOWED_SCOPE}/skillshelf`, version, description: 'CLI fixture', type: 'module', license: 'MIT', engines: { node: '>=22.20.0' }, bin: { skillshelf: 'dist/index.js' }, files: ['dist/', 'README.md', 'LICENSE'], ...publicationMetadata(api), dependencies: { '@clack/prompts': '1.8.1', commander: '14.0.1', picocolors: '1.1.1', tar: '7.5.22', yaml: '2.8.3', zod: '4.1.12' } };
  metadata.repository.directory = 'packages/cli';
  return CLI_ALLOWED_FILES.map(filename => ({ path: filename, executable: filename === 'package/dist/index.js', data: filename === 'package/package.json' ? JSON.stringify(metadata) : filename === 'package/dist/catalog/bootstrap.json' ? JSON.stringify(catalog) : filename === 'package/dist/index.js' ? '#!/usr/bin/env node\n// fixture\n' : 'Fixture documentation or module.\n' }));
}
function fixtureCatalogArchive(catalog = fixtureCatalog()) {
  return [
    { path: 'package/package.json', data: JSON.stringify({ name: `${api.ALLOWED_SCOPE}/skillshelf-catalog`, version, description: 'SkillShelf metadata-only catalog', license: 'MIT', files: ['catalog.json', 'LICENSE', 'NOTICE'], ...publicationMetadata(api) }) },
    { path: 'package/catalog.json', data: JSON.stringify(catalog) },
    { path: 'package/LICENSE', data: 'MIT fixture' },
    { path: 'package/NOTICE', data: catalogNotice(api) },
  ];
}

test('output policy permits ordinary CI runner temp on POSIX and Windows', () => {
  assert.equal(validateOutputPath('/home/runner/work/_temp/release', { sourceRoot: '/home/runner/work/skillshelf/skillshelf', paths: path.posix }), '/home/runner/work/_temp/release');
  assert.equal(validateOutputPath('/private/var/folders/build/release', { sourceRoot: '/Users/runner/work/skillshelf', paths: path.posix }), '/private/var/folders/build/release');
  assert.equal(validateOutputPath('D:\\a\\_temp\\release', { sourceRoot: 'D:\\a\\skillshelf\\skillshelf', paths: path.win32 }), 'D:\\a\\_temp\\release');
  for (const candidate of ['/', '/data', '/srv', '/data/panel', '/data/panel/release', '/data/browser/release', '/data/caddy/release', '/data/docker/release', '/data/containerd/release', '/data/deepseek-harness/release', '/srv/workspaces/release', '/var/lib/containerd/release', '/home/runner/source/release', '/home/runner']) assert.throws(() => validateOutputPath(candidate, { sourceRoot: '/home/runner/source', paths: path.posix }), undefined, candidate);
  for (const candidate of ['C:\\', 'C:release', '\\release', '\\\\server\\share\\release', '\\\\?\\C:\\release', 'C:\\data\\panel\\release', 'C:\\runner\\source\\release']) assert.throws(() => validateOutputPath(candidate, { sourceRoot: 'C:\\runner\\source', paths: path.win32 }), undefined, candidate);
});

test('server source checkouts require strict run-scoped output subdirectories', () => {
  const policy = { sourceRoot: '/srv/panel/clients/skillshelf', paths: path.posix };
  assert.equal(validateOutputPath('/data/panel-agent-tmp/run-123/packed', policy), '/data/panel-agent-tmp/run-123/packed');
  for (const candidate of [undefined, '', 'relative', '/tmp/release', '/data/other/release', '/data/panel-agent-tmp', '/data/panel-agent-tmp/run-123', '/data/panel-agent-tmp/run-/packed', '/data/panel-agent-tmp/not-run/packed', '/data/panel-agent-tmp/run-123/../escape', '/data/panel-agent-tmp/run-123/CON', '/data/panel-agent-tmp/run-123/file.', '/data/panel-agent-tmp/run-123/a:b']) assert.throws(() => validateOutputPath(candidate, policy), undefined, String(candidate));
});

test('output directories are new/empty, non-checkout, and never follow links', async t => {
  const temporary = await scratch(t), sourceRoot = path.join(temporary, 'source'), out = path.join(temporary, 'packed');
  await mkdir(sourceRoot);
  assert.equal(await outputDirectory(out, { sourceRoot }), out);
  await writeFile(path.join(out, 'keep'), 'user data');
  await assert.rejects(outputDirectory(out, { sourceRoot }), /new or empty/);
  assert.equal(await outputDirectory(out, { sourceRoot, existing: true }), out);
  await assert.rejects(outputDirectory(path.join(temporary, 'missing'), { sourceRoot, existing: true }), /does not exist/);
  await assert.rejects(outputDirectory(path.join(sourceRoot, 'pack'), { sourceRoot }), /checkout/);
  const checkout = path.join(temporary, 'other-checkout'); await mkdir(checkout); await writeFile(path.join(checkout, '.git'), 'gitdir: elsewhere');
  await assert.rejects(outputDirectory(path.join(checkout, 'pack'), { sourceRoot }), /checkout/);
  assert.equal(await readFile(path.join(out, 'keep'), 'utf8'), 'user data');
});

test('output directory validation rejects a native directory link ancestor', async t => {
  const temporary = await scratch(t), sourceRoot = path.join(temporary, 'source'), out = path.join(temporary, 'packed');
  await mkdir(sourceRoot); await mkdir(out);
  const linked = path.join(temporary, 'linked');
  try { await symlink(out, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'UNKNOWN'].includes(error.code)) {
      t.skip('Windows runner cannot create junctions; ordinary output path checks remain covered');
      return;
    }
    throw error;
  }
  await assert.rejects(outputDirectory(path.join(linked, 'child'), { sourceRoot }), /links/);
});

test('preparation preserves identical files and refuses different files, links and dry-run data', async t => {
  const temporary = await scratch(t), filename = path.join(temporary, 'artifact.tgz');
  await writeUnchangedOrNew(filename, Buffer.from('exact'));
  await writeUnchangedOrNew(filename, Buffer.from('exact'));
  await assert.rejects(writeUnchangedOrNew(filename, Buffer.from('other')), /different existing/);
  assert.equal((await readRegularFile(filename)).toString(), 'exact');
  const hardlinked = path.join(temporary, 'hardlink.tgz'); await link(filename, hardlinked);
  await assert.rejects(readRegularFile(hardlinked), /without links/); await rm(hardlinked);
  const linked = path.join(temporary, 'symlink.tgz'); let canSymlink = true;
  try { await symlink(filename, linked, 'file'); } catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error; canSymlink = false; }
  if (canSymlink) await assert.rejects(writeUnchangedOrNew(linked, Buffer.from('other')), /without links/);
  await assert.rejects(auditCliArchive(Buffer.from('[{"filename":"dry-run.tgz"}]'), { api }), /gzip/);
});

test('deterministic tar generation preserves complete bytes and executable state', () => {
  const files = [{ path: 'package/z.bin', data: Buffer.from([0, 255, 1]) }, { path: 'package/a.sh', data: '#!/bin/sh\n', executable: true }];
  const one = makeTarball(files), two = makeTarball([...files].reverse());
  assert.ok(one.equals(two)); assert.equal(integrityFor(one), integrityFor(two));
  const actual = api.readTarball(one); assert.deepEqual(actual.map(file => file.path), ['package/a.sh', 'package/z.bin']);
  assert.equal(actual[0].executable, true); assert.equal(actual[1].executable, false); assert.ok(actual[1].data.equals(files[0].data));
});

test('CLI audit uses fixed scope and a real exact file allowlist', async () => {
  const catalog = fixtureCatalog(), files = fixtureCli(catalog);
  const result = await auditCliArchive(makeTarball(files), { api, expectedCatalog: catalog });
  assert.equal(result.name, `${api.ALLOWED_SCOPE}/skillshelf`); assert.equal(result.version, version); assert.equal(result.files, CLI_ALLOWED_FILES.length);
  for (const name of ['package/dist/unreviewed.js', 'package/dist/secrets.d.ts', 'package/.env', 'package/dist/index.js.map', 'package/skills/body/SKILL.md']) await assert.rejects(auditCliArchive(makeTarball([...files, { path: name, data: 'should not publish' }]), { api }), /allowlist/);
  await assert.rejects(auditCliArchive(makeTarball(files.filter(file => file.path !== 'package/dist/release.js')), { api }), /allowlist/);
  await assert.rejects(auditCliArchive(makeTarball(files.map(file => file.path === 'package/dist/index.js' ? { ...file, executable: false } : file)), { api }), /executable/);
  const changed = structuredClone(catalog); changed.skills[0].title = 'Stale catalog';
  await assert.rejects(auditCliArchive(makeTarball(files), { api, expectedCatalog: changed }), /stale/);
  for (const patch of [{ name: '@unreviewed/skillshelf' }, { scripts: { postinstall: 'untrusted' } }, { repository: { type: 'git', url: 'https://example.com/elsewhere.git' } }, { publishConfig: { access: 'public', tag: 'latest' } }]) {
    const mutated = files.map(file => file.path === 'package/package.json' ? { ...file, data: JSON.stringify({ ...JSON.parse(file.data), ...patch }) } : file);
    await assert.rejects(auditCliArchive(makeTarball(mutated), { api }));
  }
});

test('catalog archive is metadata only and retains exact verified public catalog', () => {
  const catalog = fixtureCatalog(), files = fixtureCatalogArchive(catalog);
  verifyCatalogArchive(makeTarball(files), catalog, api);
  assert.throws(() => verifyCatalogArchive(makeTarball([...files, { path: 'package/private.json', data: '{}' }]), catalog, api), /only reviewed/);
  const changed = structuredClone(catalog); changed.skills[0].title = 'Changed';
  assert.throws(() => verifyCatalogArchive(makeTarball(files), changed, api), /differ/);
  const local = structuredClone(catalog); local.skills[0].localArtifact = 'secret.tgz';
  assert.throws(() => verifyCatalogArchive(makeTarball(fixtureCatalogArchive(local)), catalog, api), /localArtifact/);
});

test('publication plans retain the reviewed package count and SRI', () => {
  const bytes = Buffer.from('verified fixture');
  const rows = Array.from({ length: 16 }, (_, index) => publicationEntry(`${api.ALLOWED_SCOPE}/skillshelf-pack-fixture-${index}`, version, `artifacts/fixture-${index}.tgz`, bytes, api));
  rows.push(publicationEntry(`${api.ALLOWED_SCOPE}/skillshelf-catalog`, version, `catalog-${version}.tgz`, bytes, api));
  assert.equal(publicationPlan(rows, api, 16).complete, false);
  assert.throws(() => publicationPlan(rows, api, 16, true), /count/);
  rows.push(publicationEntry(`${api.ALLOWED_SCOPE}/skillshelf`, version, `cli-${version}.tgz`, bytes, api));
  const plan = publicationPlan(rows, api, 16, true);
  assert.equal(plan.packages.length, 18); assert.equal(plan.complete, true); assert.equal(plan.published, false);
  for (const row of plan.packages) { assert.deepEqual(Object.keys(row).sort(), ['access', 'file', 'integrity', 'name', 'repository', 'tag', 'version']); assert.equal(row.tag, 'next'); assert.equal(row.access, 'public'); assert.equal(row.repository, api.REPOSITORY_URL); assert.equal(row.integrity, integrityFor(bytes)); }
  assert.throws(() => publicationPlan([...rows.slice(0, 17), rows[0]], api, 16, true), /unique/);
  assert.throws(() => publicationPlan(rows.map((row, index) => index ? row : { ...row, tag: 'latest' }), api, 16, true), /Unreviewed/);
  assert.throws(() => publicationEntry('@unreviewed/skillshelf', version, 'cli.tgz', bytes, api), /identity/);
  assert.throws(() => publicationEntry(`${api.ALLOWED_SCOPE}/skillshelf`, version, '../cli.tgz', bytes, api));
});

test('public package metadata and source config use the reviewed distribution identity', async () => {
  assertPublicationMetadata(publicationMetadata(api), api);
  assert.throws(() => assertPublicationMetadata({ ...publicationMetadata(api), homepage: 'https://example.com' }, api));
  const filename = fileURLToPath(new URL('../catalog/sources.json', import.meta.url));
  const config = JSON.parse(await readFile(filename, 'utf8')); assertReleaseConfig(config, api);
  assert.throws(() => assertReleaseConfig({ ...config, scope: '@unreviewed' }, api));
  assert.throws(() => assertReleaseConfig({ ...config, skills: [...config.skills.slice(0, -1), config.skills[0]] }, api));
  assert.throws(() => assertReleaseConfig({ ...config, skills: [{ ...config.skills[0], name: '../escape' }, ...config.skills.slice(1)] }, api));
});
