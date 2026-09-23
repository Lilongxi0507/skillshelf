import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { Header, Pax } from 'tar';
import { makeTarball } from '../scripts/lib.mjs';
import { canonicalJson, digestManifest, validatePublicCatalog } from '../packages/cli/dist/validation.js';
import { acquireSkill, acquireLockedSkill, readTarball, verifySkillArchive, extractVerifiedSkill } from '../packages/cli/dist/registry/registry.js';
import { loadCatalog, searchCatalog, fetchLatestCatalog, refreshCatalog } from '../packages/cli/dist/catalog/catalog.js';
import { assertRegistryUrl, CATALOG_PACKAGE, CLI_PACKAGE, resolveNpmRelease } from '../packages/cli/dist/registry/http.js';
import { CLI_VERSION, NPM_SCOPE, PROJECT_URL, RELEASE_CHANNEL, REPOSITORY_URL } from '../packages/cli/dist/release.js';
import { buildProgram } from '../packages/cli/dist/index.js';

const sri = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const runtime = { kind: 'instructions', requiresNetwork: false };
const sourceFiles = [{ path: 'SKILL.md', data: Buffer.from('---\nname: fixture\ndescription: Fixture\n---\nComplete body.\n') }, { path: 'LICENSE', data: Buffer.from('MIT fixture\n') }, { path: '.hidden/data.bin', data: Buffer.from([0, 255, 1]) }];
function fixture(mutate = files => files, metadata = {}) {
  const files = sourceFiles.map(file => ({ path: file.path, size: file.data.length, sha256: createHash('sha256').update(file.data).digest('hex'), executable: false }));
  const manifest = { schemaVersion: 1, id: 'fixture', name: 'fixture', files, contentDigest: digestManifest(files), runtime };
  const pack = { name: '@llx17669475/skillshelf-skill-fixture', version: '0.1.0-preview.1', license: 'MIT', files: ['skill/', 'skillshelf.manifest.json', 'LICENSE'], ...metadata };
  const contents = [{ path: 'package/package.json', data: Buffer.from(canonicalJson(pack)) }, { path: 'package/skillshelf.manifest.json', data: Buffer.from(canonicalJson(manifest)) }, { path: 'package/LICENSE', data: sourceFiles[1].data }, ...sourceFiles.map(file => ({ ...file, path: 'package/skill/' + file.path }))];
  const bytes = makeTarball(mutate(contents));
  const entry = { id: 'fixture', name: 'fixture', title: 'Fixture 示例', description: 'Complete fixture', useWhen: 'Testing', examples: ['Verify a snapshot'], category: 'design', tags: ['hidden', '测试'], collection: 'fixture', license: 'MIT', source: {}, status: 'stable', runtime, packageName: pack.name, version: pack.version, integrity: sri(bytes), contentDigest: manifest.contentDigest, fileCount: files.length, unpackedSize: files.reduce((sum, item) => sum + item.size, 0) };
  return { entry, bytes, manifest };
}
function catalogFor(entry) { return { schemaVersion: 1, catalogVersion: '0.1.0-preview.1', minCliVersion: '0.1.0-preview.1', scope: '@llx17669475', categories: [{ id: 'design', title: 'Design' }], collections: [{ id: 'fixture', title: 'Fixture', description: 'Complete test fixture', skills: ['fixture'] }], skills: [entry] }; }
async function makeWritable(directory) {
  const info = await lstat(directory); if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) { await chmod(directory, 0o600); return; }
  await chmod(directory, 0o700);
  for (const file of await readdir(directory)) await makeWritable(path.join(directory, file));
}
async function scratch(t) { const root = await mkdtemp(path.join(process.env.SKILLSHELF_TEST_TMP || tmpdir(), 'run-skillshelf-registry-')); t.after(async () => { await makeWritable(root); await rm(root, { recursive: true, force: true }); }); return root; }
function customTar(type, name = 'package/unsafe', data = Buffer.alloc(0), extras = {}) { const block = Buffer.alloc(512); new Header({ path: name, type, mode: 0o644, size: data.length, ...extras }).encode(block); return gzipSync(Buffer.concat([block, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)])); }

test('complete data-only tarball verifies hidden and binary content with exact SRI', () => {
  const { bytes, entry, manifest } = fixture();
  assert.equal(verifySkillArchive(bytes, entry).manifest.contentDigest, manifest.contentDigest);
  assert.equal(readTarball(bytes).length, 6);
  assert.throws(() => verifySkillArchive(bytes, { ...entry, integrity: sri(Buffer.from('wrong')) }), /integrity/);
  assert.throws(() => verifySkillArchive(bytes, { ...entry, version: '0.1.0-preview.2' }), /identity/);
});
test('lifecycle, dependencies, extra/missing files and content substitution fail closed', () => {
  for (const metadata of [{ scripts: { install: 'echo unsafe' } }, { bin: 'run.js' }, { dependencies: {} }, { optionalDependencies: {} }, { bundledDependencies: [] }]) { const data = fixture(undefined, metadata); assert.throws(() => verifySkillArchive(data.bytes, data.entry), /data-only/); }
  for (const mutate of [files => [...files, { path: 'package/skill/extra', data: Buffer.from('unexpected') }], files => files.filter(file => file.path !== 'package/skill/.hidden/data.bin'), files => files.map(file => file.path.endsWith('data.bin') ? { ...file, data: Buffer.from('wrong') } : file)]) { const data = fixture(mutate); assert.throws(() => verifySkillArchive(data.bytes, data.entry)); }
});
test('data-only packages accept reviewed public metadata and reject registry/source overrides', () => {
  const metadata = { repository: { type: 'git', url: REPOSITORY_URL }, homepage: PROJECT_URL+'#readme', bugs: { url: PROJECT_URL+'/issues' }, publishConfig: { access:'public', tag:RELEASE_CHANNEL } };
  const good=fixture(undefined,metadata); verifySkillArchive(good.bytes,good.entry);
  for(const bad of [{repository:{type:'git',url:'https://example.com/other.git'}},{homepage:'https://example.com/'},{bugs:{url:PROJECT_URL+'/issues',email:'unused@example.com'}},{publishConfig:{access:'public',tag:'latest'}},{publishConfig:{access:'public',tag:RELEASE_CHANNEL,registry:'https://example.com'}}]){
    const item=fixture(undefined,{...metadata,...bad});assert.throws(()=>verifySkillArchive(item.bytes,item.entry),/untrusted/);
  }
});
test('maintained tar parser is guarded against links, special entries, traversal and aliases', () => {
  for (const type of ['SymbolicLink', 'Link', 'FIFO', 'CharacterDevice', 'BlockDevice', 'ContiguousFile', 'GlobalExtendedHeader']) assert.throws(() => readTarball(customTar(type, 'package/unsafe', Buffer.alloc(0), { linkpath: type.includes('Link') ? '../../escape' : '' })));
  for (const name of ['../escape', '/absolute', 'package/../escape', 'package/CON', 'package/a\\b']) assert.throws(() => readTarball(customTar('File', name)));
  assert.throws(() => readTarball(makeTarball([{ path: 'package/a', data: 'a' }, { path: 'package/A', data: 'b' }])));
  assert.throws(() => readTarball(makeTarball([{ path: 'package/a', data: 'a' }, { path: 'package/a/b', data: 'b' }])));
  assert.throws(() => readTarball(customTar('File', 'package/suid', Buffer.alloc(0), { mode: 0o4755 })));
});
test('PAX paths remain supported but links/sparse and traversal metadata are rejected', () => {
  const long = 'package/' + 'a'.repeat(80) + '/' + 'b'.repeat(80) + '/file';
  assert.equal(readTarball(makeTarball([{ path: long, data: 'hello' }]))[0].path, long);
  const pax = new Pax({ path: 'package/../../escape' }).encode();
  const block = Buffer.alloc(512); new Header({ path: 'package/placeholder', type: 'File', size: 0, mode: 0o644 }).encode(block);
  assert.throws(() => readTarball(gzipSync(Buffer.concat([pax, block, Buffer.alloc(1024)]))));
  const raw = makeTarball([{ path: 'package/ok', data: 'x' }]);
  assert.throws(() => readTarball(Buffer.concat([raw, raw])), /trailing/);
});
test('failed validation happens before any extraction destination is created', async t => {
  const root = await scratch(t), destination = path.join(root, 'skill'), { bytes, entry } = fixture();
  await assert.rejects(extractVerifiedSkill(bytes, { ...entry, integrity: sri(Buffer.from('bad')) }, destination));
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
  await extractVerifiedSkill(bytes, entry, destination); assert.deepEqual(await readFile(path.join(destination, '.hidden/data.bin')), sourceFiles[2].data);
});
test('offline development acquisition survives source deletion and verifies persistent artifact/store', async t => {
  const root = await scratch(t), { bytes, entry } = fixture();
  const dev = { ...entry, localArtifact: 'fixture.tgz' }, catalogPath = path.join(root, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify(catalogFor(dev))); await writeFile(path.join(root, 'fixture.tgz'), bytes);
  const ctx = { home: path.join(root, 'home'), offline: true, catalogPath };
  const first = await acquireSkill(ctx, dev); await rm(path.join(root, 'fixture.tgz'));
  const second = await acquireSkill(ctx, dev); assert.equal(second.directory, first.directory); assert.equal(second.artifact, first.artifact);
  assert.ok(second.directory.includes(path.join('store', entry.contentDigest, 'skill')));
  await chmod(path.join(second.directory, 'SKILL.md'), 0o600); await writeFile(path.join(second.directory, 'SKILL.md'), 'tamper');
  await assert.rejects(acquireSkill(ctx, dev), /Tree/);
});
test('catalog local search/check does no network and public catalogs reject local fields', async t => {
  const root = await scratch(t), { entry } = fixture(); const catalog = catalogFor(entry), catalogPath = path.join(root, 'catalog.json'); await writeFile(catalogPath, JSON.stringify(catalog));
  const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('unexpected network'); }; t.after(() => { globalThis.fetch = original; });
  const ctx = { home: path.join(root, 'never-created-home'), offline: true, catalogPath };
  assert.equal((await loadCatalog(ctx)).skills.length, 1); assert.equal((await fetchLatestCatalog(ctx)).skills.length, 1);
  await assert.rejects(lstat(ctx.home), { code: 'ENOENT' });
  assert.equal(searchCatalog(catalog, '示例 hidden').length, 1); assert.equal(searchCatalog(catalog, '', { installed: [] }).length, 0);
  assert.throws(() => validatePublicCatalog(catalogFor({ ...entry, localArtifact: 'fixture.tgz' })), /localArtifact/);
  assert.throws(() => validatePublicCatalog({ ...catalog, scope: '@foreign' }));
});
test('npm source is fixed and no project lock can authorize arbitrary scope/local artifact', async t => {
  assert.equal(CATALOG_PACKAGE, '@llx17669475/skillshelf-catalog');
  for (const url of ['http://registry.npmjs.org/a', 'https://registry.npmjs.org.evil/a', 'https://user:secret@registry.npmjs.org/a', 'https://example.com/a', 'https://registry.npmjs.org/a?token=x']) assert.throws(() => assertRegistryUrl(url));
  const root = await scratch(t), { entry } = fixture();
  await assert.rejects(acquireLockedSkill({ home: root, offline: true }, { ...entry, packageName: '@evil/fixture' }));
  await assert.rejects(acquireLockedSkill({ home: root, offline: true }, { ...entry, localArtifact: 'fixture.tgz' }), /cannot authorize/);
});
test('only CLI and catalog may resolve the fixed next channel, never arbitrary tags or foreign scopes', async t => {
  assert.equal(NPM_SCOPE,'@llx17669475');assert.equal(RELEASE_CHANNEL,'next');
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async(url)=>{calls++;const name=decodeURIComponent(new URL(url).pathname.split('/')[1]);assert.ok([CATALOG_PACKAGE,CLI_PACKAGE].includes(name));assert.ok(String(url).endsWith('/next'));return new Response(JSON.stringify({name,version:CLI_VERSION,dist:{integrity:sri(Buffer.from('fixture')),tarball:`https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-${CLI_VERSION}.tgz`}}));};t.after(()=>{globalThis.fetch=original;});
  for(const name of [CATALOG_PACKAGE,CLI_PACKAGE])assert.equal((await resolveNpmRelease(name,'next',true)).version,CLI_VERSION);
  for(const [name,version,allow] of [[CLI_PACKAGE,'latest',true],[CATALOG_PACKAGE,'beta',true],[CLI_PACKAGE,'next',false],[NPM_SCOPE+'/skillshelf-skill-brandkit','next',true],['@skillshelf-local/skillshelf','next',true]])await assert.rejects(resolveNpmRelease(name,version,allow));
  assert.equal(calls,2);
});
test('self-update checks next and never writes local state or marks the real scope unpublished', async t => {
  const root=await scratch(t),home=path.join(root,'missing-home'),original=globalThis.fetch,log=console.log,output=[];
  globalThis.fetch=async url=>{assert.equal(String(url),`https://registry.npmjs.org/${encodeURIComponent(CLI_PACKAGE)}/next`);return new Response(JSON.stringify({name:CLI_PACKAGE,version:CLI_VERSION,dist:{integrity:sri(Buffer.from('fixture')),tarball:`https://registry.npmjs.org/${CLI_PACKAGE}/-/skillshelf-${CLI_VERSION}.tgz`}}));};console.log=(value)=>output.push(value);t.after(()=>{globalThis.fetch=original;console.log=log;});
  await buildProgram().parseAsync(['node','skillshelf','--home',home,'--json','self-update','--check']);
  const data=JSON.parse(output[0]).data;assert.equal(data.channel,'next');assert.equal(data.latest,CLI_VERSION);assert.equal(data.command,`npm install -g ${CLI_PACKAGE}@${CLI_VERSION}`);assert.equal(data.published,undefined);await assert.rejects(lstat(home),{code:'ENOENT'});
});
test('public frozen lock may borrow only a fully matching explicit development artifact', async t => {
  const root = await scratch(t), { entry, bytes } = fixture(), catalogPath = path.join(root, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify(catalogFor({ ...entry, localArtifact: 'fixture.tgz' })));
  await writeFile(path.join(root, 'fixture.tgz'), bytes);
  const result = await acquireLockedSkill({ home: path.join(root, 'fresh-home'), offline: true, catalogPath }, entry);
  assert.equal(result.manifest.id, 'fixture');
  await assert.rejects(acquireLockedSkill({ home: path.join(root, 'different-home'), offline: true, catalogPath }, { ...entry, version: '0.1.0-preview.2' }), /Offline/);
});
test('read-only npm check and explicit refresh use bounded fixed source and verified persistent catalog receipt', async t => {
  const root = await scratch(t), { entry } = fixture(), catalog = catalogFor(entry), version = catalog.catalogVersion;
  const catalogBytes = makeTarball([{ path: 'package/package.json', data: JSON.stringify({ name: CATALOG_PACKAGE, version, license: 'MIT', files: ['catalog.json', 'LICENSE'] }) }, { path: 'package/catalog.json', data: JSON.stringify(catalog) }, { path: 'package/LICENSE', data: 'MIT' }]);
  const tarball = `https://registry.npmjs.org/${CATALOG_PACKAGE}/-/skillshelf-catalog-${version}.tgz`;
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url)); assert.equal(options.redirect, 'error');
    if (String(url) === tarball) return new Response(catalogBytes);
    assert.equal(String(url), `https://registry.npmjs.org/${encodeURIComponent(CATALOG_PACKAGE)}/next`);
    return new Response(JSON.stringify({ name: CATALOG_PACKAGE, version, dist: { integrity: sri(catalogBytes), tarball } }));
  };
  t.after(() => { globalThis.fetch = original; });
  const ctx = { home: path.join(root, 'home'), offline: false };
  assert.equal((await fetchLatestCatalog(ctx)).skills[0].id, 'fixture');
  await assert.rejects(lstat(ctx.home), { code: 'ENOENT' });
  assert.equal((await refreshCatalog(ctx)).skills[0].id, 'fixture');
  assert.ok((await lstat(path.join(ctx.home, 'catalogs/cache.json'))).isFile());
  globalThis.fetch = () => { throw new Error('offline network leak'); };
  assert.equal((await loadCatalog({ ...ctx, offline: true })).skills[0].id, 'fixture');
  assert.equal(calls.length, 4);
});
test('catalog requiring a newer CLI is rejected without touching home', async t => {
  const root = await scratch(t), { entry } = fixture(), catalogPath = path.join(root, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify({ ...catalogFor(entry), minCliVersion: '999.0.0' }));
  const home = path.join(root, 'home');
  await assert.rejects(loadCatalog({ home, offline: true, catalogPath }), /requires SkillShelf CLI/);
  await assert.rejects(lstat(home), { code: 'ENOENT' });
});
