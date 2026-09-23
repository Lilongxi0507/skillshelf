import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addProvider, listProviders, removeProvider, runSkill, runtimeDoctor, SecretRedactor } from '../packages/cli/dist/runtime/runtime.js';
import { providerUrl } from '../packages/cli/dist/runtime/providers.js';
import { parseWindowsAclRecord, sanitizedEnvironment, validateWindowsAcl } from '../packages/cli/dist/runtime/privacy.js';
import { digestManifest, inventory } from '../packages/cli/dist/validation.js';

const posix = { skip: process.platform === 'win32' ? 'POSIX permissions/fake executable; no claim of Windows integration verification' : false };
async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.SKILLSHELF_TEST_TMP ?? tmpdir(), 'skillshelf-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  return { root, ctx: { home, offline: true } };
}
function envValue(t, name, value) {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
}
const search = (overrides = {}) => ({ id: 'search-main', kind: 'search', adapter: 'tavily', baseUrl: 'https://api.tavily.com', apiKeyEnv: 'SKILLSHELF_TEST_SEARCH_KEY', ...overrides });

// A tiny deterministic data-only fixture; no npm install/pack, subprocess or network.
function tarGzip(files) {
  const parts = [];
  for (const [name, data] of Object.entries(files)) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    const octal = (value, offset, length) => header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(body.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    parts.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

async function releaseFixture(t, media = false) {
  const fixtureValue = await fixture(t);
  const { root, ctx } = fixtureValue;
  await mkdir(ctx.home, { mode: 0o700 });
  const source = path.join(root, 'source'); await mkdir(path.join(source, 'scripts'), { recursive: true, mode: 0o700 });
  const id = media ? 'skillshelf-media-generation' : 'skillshelf-web-search';
  const contents = { 'SKILL.md': `---\nname: ${id}\ndescription: Test fixture\n---\n# ${id}\nTest fixture only.\n`, LICENSE: 'MIT\n', 'scripts/run.py': '# inert test fixture; executed by a controlled fake interpreter only\n' };
  for (const [name, data] of Object.entries(contents)) await writeFile(path.join(source, name), data, { mode: 0o600 });
  const files = await inventory(source);
  const digest = digestManifest(files);
  const runtime = { kind: 'python', entrypoint: 'scripts/run.py', minimumVersion: '3.10', requiresNetwork: true, providers: media ? ['image', 'video'] : ['search'], dependencies: [] };
  const manifest = { schemaVersion: 1, id, name: id, files, contentDigest: digest, runtime };
  const packageName = '@llx17669475/skillshelf-skill-' + id;
  const version = '0.1.0-preview.1';
  const archive = tarGzip({
    'package/package.json': JSON.stringify({ name: packageName, version, license: 'MIT', files: ['skill/', 'skillshelf.manifest.json', 'LICENSE'] }),
    'package/skillshelf.manifest.json': JSON.stringify(manifest), 'package/LICENSE': contents.LICENSE,
    ...Object.fromEntries(Object.entries(contents).map(([name, data]) => ['package/skill/' + name, data])),
  });
  const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
  const entry = {
    id, name: id, title: id, description: 'Fixture, no provider calls', useWhen: 'Tests', examples: ['local test'],
    category: 'tools', tags: [], collection: 'first-party', license: 'MIT', source: { repository: 'skillshelf/skillshelf', path: 'skills/' + id },
    status: 'stable', runtime, packageName, version, integrity, contentDigest: digest, fileCount: files.length, unpackedSize: files.reduce((sum, file) => sum + file.size, 0),
  };
  const object = path.join(ctx.home, 'store', digest);
  await mkdir(path.join(object, 'skill', 'scripts'), { recursive: true, mode: 0o700 });
  for (const [name, data] of Object.entries(contents)) await writeFile(path.join(object, 'skill', name), data, { mode: 0o600 });
  await writeFile(path.join(object, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  await mkdir(path.join(ctx.home, 'artifacts'), { mode: 0o700 });
  const artifact = path.join(ctx.home, 'artifacts', `${digest}-${createHash('sha256').update(integrity).digest('hex').slice(0, 16)}.tgz`);
  await writeFile(artifact, archive, { mode: 0o600 });
  const release = { key: id + '@' + version, id, name: id, version, packageName, integrity, contentDigest: digest, manifest, source: entry.source, installedAt: new Date(0).toISOString(), origin: 'npm', catalogEntry: entry };
  return { ...fixtureValue, release, artifact, object };
}

async function fakePython(t, root, version = '3.12.1') {
  const executable = path.join(root, 'fake-python');
  // This executable never contacts a provider. It records exactly what Node passed to spawn.
  await writeFile(executable, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('-c')) { process.stdout.write(VERSION); process.exit(0); }
const filename = process.env.SKILLSHELF_RUNTIME_CONFIG;
const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
const key = config.resources.find(row => row.api_key)?.api_key || '';
const report = {
  argv: process.argv.slice(2), cwd: process.cwd(), resources: config.resources.map(row => ({ id: row.id, kind: row.kind, hasKey: Boolean(row.api_key), envRef: row.api_key_env ?? null })),
  environment: Object.keys(process.env).sort(), outputs: process.env.SKILLSHELF_OUTPUTS, configPath: filename,
  directoryMode: fs.statSync(process.cwd()).mode & 511, configMode: fs.statSync(filename).mode & 511,
};
fs.writeFileSync(path.join(process.env.SKILLSHELF_OUTPUTS, 'record.json'), JSON.stringify(report));
process.stdout.write(JSON.stringify(report) + '\n');
process.stderr.write(key.slice(0, 3)); process.stderr.write(key.slice(3));
if (process.argv.includes('--fail-fixture')) process.exitCode = 7;
`.replace('VERSION', JSON.stringify(version)), { mode: 0o700 });
  envValue(t, 'SKILLSHELF_PYTHON', executable);
  return executable;
}

test('list and doctor on empty home are read-only and management needs no Python', posix, async (t) => {
  const { root, ctx } = await fixture(t);
  envValue(t, 'SKILLSHELF_PYTHON', '/does/not/exist');
  assert.deepEqual(await listProviders(ctx), { version: 1, resources: [], defaults: {} });
  const report = await runtimeDoctor(ctx, []);
  assert.equal(report.network, 'not-requested'); assert.equal(report.python, undefined);
  assert.equal(report.configuration.providerCount, 0);
  assert.deepEqual(await readdir(root), []);
});

test('env reference is preferred, unresolved on disk and metadata is redacted', posix, async (t) => {
  const { ctx } = await fixture(t);
  envValue(t, 'SKILLSHELF_TEST_SEARCH_KEY', 'test-secret-never-store');
  const result = await addProvider(ctx, search({ apiKey: 'ignored-key-never-store' }));
  const file = path.join(ctx.home, 'config', 'providers.json');
  const contents = await readFile(file, 'utf8');
  assert.equal(contents.includes('test-secret-never-store'), false);
  assert.equal(contents.includes('ignored-key-never-store'), false);
  assert.equal(JSON.parse(contents).resources[0].api_key_env, 'SKILLSHELF_TEST_SEARCH_KEY');
  assert.equal(JSON.stringify(result).includes('test-secret-never-store'), false);
  assert.equal(result.resources[0].key.source, 'env');
  assert.equal(result.resources[0].key.configured, true);
  assert.equal((await lstat(ctx.home)).mode & 0o7777, 0o700);
  assert.equal((await lstat(path.dirname(file))).mode & 0o7777, 0o700);
  assert.equal((await lstat(file)).mode & 0o7777, 0o600);
});

test('plaintext requires explicit authorization and never appears in return values', posix, async (t) => {
  const { root, ctx } = await fixture(t);
  const input = search({ apiKeyEnv: undefined, apiKey: 'sensitive-test-key' });
  await assert.rejects(addProvider(ctx, input), /explicitly authorize/);
  assert.deepEqual(await readdir(root), []);
  const result = await addProvider(ctx, { ...input, allowPlaintext: true });
  assert.equal(result.resources[0].key.source, 'plaintext');
  assert.equal(JSON.stringify(result).includes(input.apiKey), false);
  assert.equal((await listProviders(ctx)).resources[0].key.source, 'plaintext');
  assert.equal(JSON.parse(await readFile(path.join(ctx.home, 'config', 'providers.json'), 'utf8')).resources[0].api_key, input.apiKey);
});

test('add/remove defaults and duplicate conflicts preserve local state', posix, async (t) => {
  const { ctx } = await fixture(t);
  await addProvider(ctx, search());
  await assert.rejects(addProvider(ctx, search()), /already exists/);
  const two = await addProvider(ctx, search({ id: 'second', adapter: 'brave', baseUrl: 'https://api.search.brave.com', makeDefault: true }));
  assert.equal(two.defaults.search, 'second');
  const one = await removeProvider(ctx, 'second');
  assert.equal(one.resources.length, 1); assert.equal(one.defaults.search, undefined);
  assert.equal((await removeProvider(ctx, 'search-main')).resources.length, 0);
  await assert.rejects(removeProvider(ctx, 'absent'), /No provider/);
});

test('read and update refuse existing wide permissions without chmod', posix, async (t) => {
  const { ctx } = await fixture(t);
  await addProvider(ctx, search());
  const filename = path.join(ctx.home, 'config', 'providers.json');
  await chmod(filename, 0o644);
  await assert.rejects(listProviders(ctx), /0600/);
  await assert.rejects(addProvider(ctx, search({ id: 'second' })), /0600/);
  assert.equal((await lstat(filename)).mode & 0o7777, 0o644);
  await chmod(filename, 0o600);
  await chmod(path.dirname(filename), 0o755);
  await assert.rejects(listProviders(ctx), /0700/);
  assert.equal((await lstat(path.dirname(filename))).mode & 0o7777, 0o755);
});

test('symlink, hardlink, unknown file and corrupt config are protected', posix, async (t) => {
  const { root, ctx } = await fixture(t);
  await mkdir(ctx.home, { mode: 0o700 });
  const outside = path.join(root, 'outside'); await mkdir(outside, { mode: 0o700 });
  await symlink(outside, path.join(ctx.home, 'config'));
  await assert.rejects(addProvider(ctx, search()), /symbolic|junction/);
  assert.deepEqual(await readdir(outside), []);
  await rm(path.join(ctx.home, 'config'));
  await writeFile(path.join(ctx.home, 'config'), 'user-file', { mode: 0o600 });
  await assert.rejects(addProvider(ctx, search()), /unexpected|non-directory/);
  assert.equal(await readFile(path.join(ctx.home, 'config'), 'utf8'), 'user-file');
  await rm(path.join(ctx.home, 'config'));
  await addProvider(ctx, search());
  const filename = path.join(ctx.home, 'config', 'providers.json');
  const extra = path.join(root, 'hardlink'); await link(filename, extra);
  await assert.rejects(listProviders(ctx), /hard links/);
  await rm(extra);
  await writeFile(filename, '{broken-json', { mode: 0o600 });
  await assert.rejects(addProvider(ctx, search({ id: 'new' })), /Invalid JSON/);
  assert.equal(await readFile(filename, 'utf8'), '{broken-json');
});

test('provider lock does not overwrite or remove someone else’s lock', posix, async (t) => {
  const { ctx } = await fixture(t);
  await addProvider(ctx, search());
  const lock = path.join(ctx.home, 'config', '.providers.lock');
  await writeFile(lock, 'other-operation', { mode: 0o600 });
  await assert.rejects(addProvider(ctx, search({ id: 'new' })), /locked/);
  assert.equal(await readFile(lock, 'utf8'), 'other-operation');
});

test('URLs disallow credentials, query tokens, plaintext, redirects to another origin and private hosts', posix, async (t) => {
  const { root, ctx } = await fixture(t);
  for (const baseUrl of ['http://api.example.com', 'https://u:p@api.example.com', 'https://api.example.com/?key=secret', 'https://api.example.com/#token', 'https://127.0.0.1', 'https://10.1.2.3', 'https://[::1]', 'https://localhost', 'https://api.example.com:8443']) {
    await assert.rejects(addProvider(ctx, search({ baseUrl })));
  }
  await assert.rejects(addProvider(ctx, search({ endpoint: 'https://other.example.com/search' })), /origin/);
  await assert.rejects(addProvider(ctx, search({ apiKeyEnv: 'KEY=$(whoami)' })), /environment variable/);
  assert.deepEqual(await readdir(root), []);
  assert.equal(providerUrl('https://api.example.com/v1'), 'https://api.example.com/v1');
});

test('profile accepts bounded protocol JSON but rejects hidden credentials and corrupt schemas', posix, async (t) => {
  const { ctx } = await fixture(t);
  await addProvider(ctx, { id: 'image-main', kind: 'image', model: 'gpt-image-1', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'IMG_KEY', profile: { sizes: ['1024x1024'], edit: true } });
  assert.equal((await listProviders(ctx)).resources[0].endpoint, 'https://api.openai.com/v1/images/generations');
  await assert.rejects(addProvider(ctx, search({ profile: { headers: { Authorization: 'secret' } } })), /credentials/);
  const filename = path.join(ctx.home, 'config', 'providers.json');
  await writeFile(filename, JSON.stringify({ version: 2, resources: [], defaults: {} }), { mode: 0o600 });
  await assert.rejects(listProviders(ctx), /Unrecognized/);
});

test('environment sanitization strips injection hooks, unrelated keys and unsafe PATH components', () => {
  const env = sanitizedEnvironment({ PATH: ['', '.', '/usr/bin', '/bin'].join(path.delimiter), NODE_OPTIONS: '--require=bad', PYTHONPATH: '/bad', PYTHONSTARTUP: '/bad', HTTP_PROXY: 'http://secret@proxy', AWS_SECRET_ACCESS_KEY: 'secret', PANEL_API_KEY: 'secret', SKILLSHELF_TEST_SEARCH_KEY: 'secret', LANG: 'C.UTF-8' });
  assert.equal(env.PATH, ['/usr/bin', '/bin'].join(path.delimiter));
  assert.equal(env.LANG, 'C.UTF-8');
  for (const name of ['NODE_OPTIONS', 'PYTHONPATH', 'PYTHONSTARTUP', 'HTTP_PROXY', 'AWS_SECRET_ACCESS_KEY', 'PANEL_API_KEY', 'SKILLSHELF_TEST_SEARCH_KEY']) assert.equal(env[name], undefined);
});

test('Windows SID/ACL validation fails closed (pure fixtures, not live icacls execution)', () => {
  const sid = 'S-1-5-21-111-222-333-1001';
  const rule = { sid, type: 'Allow', rights: 2032127, inherited: false };
  const good = { owner: sid, protected: true, rules: [rule, { ...rule, sid: 'S-1-5-18' }] };
  assert.equal(validateWindowsAcl(good, sid), true);
  for (const bad of [{ ...good, owner: 'S-1-5-18' }, { ...good, protected: false }, { ...good, rules: [{ ...rule, inherited: true }] }, { ...good, rules: [{ ...rule, sid: 'S-1-1-0' }] }, { ...good, rules: [{ ...rule, type: 'Deny' }] }, { ...good, rules: [{ ...rule, rights: 1 }] }]) assert.equal(validateWindowsAcl(bad, sid), false);
  assert.equal(validateWindowsAcl(good, 'administrator'), false);
});

test('Windows ACL line protocol accepts only complete typed records and preserves permission rejection', () => {
  const sid = 'S-1-5-21-111-222-333-1001';
  const lines = ['SSACL1', `O\t${sid}`, 'P\t1', 'N\t2', `A\t${sid}\t0\t2032127\t0`, 'A\tS-1-5-18\t0\t2032127\t0', 'END', ''];
  const good = lines.join('\r\n');
  assert.deepEqual(parseWindowsAclRecord(good), {
    owner: sid, protected: true,
    rules: [
      { sid, type: 'Allow', rights: 2032127, inherited: false },
      { sid: 'S-1-5-18', type: 'Allow', rights: 2032127, inherited: false },
    ],
  });
  assert.equal(validateWindowsAcl(parseWindowsAclRecord(good), sid), true);
  assert.equal(validateWindowsAcl(parseWindowsAclRecord(good.replace('P\t1', 'P\t0')), sid), false);
  assert.equal(validateWindowsAcl(parseWindowsAclRecord(good.replace(`A\t${sid}\t0`, `A\t${sid}\t1`)), sid), false);
  assert.equal(validateWindowsAcl(parseWindowsAclRecord(good.replace(`A\t${sid}\t0\t2032127\t0`, `A\t${sid}\t0\t2032127\t1`)), sid), false);
  const minimumRights = parseWindowsAclRecord(good.replace('2032127', '-2147483648'));
  assert.equal(minimumRights?.rules[0]?.rights, -2147483648);
  assert.equal(validateWindowsAcl(minimumRights, sid), false);
  for (const malformed of [
    good.replace('SSACL1', 'SSACL2'),
    '\ufeff' + good,
    good.trimEnd(),
    good.replace('END\r\n', ''),
    good.replace('N\t2', 'N\t3'),
    ['SSACL1', `O\t${sid}`, 'P\t1', 'N\t0', 'END', ''].join('\r\n'),
    good.replace('N\t2', 'N\t9999'),
    good.replace(`A\t${sid}\t0`, `A\t${sid}\t2`),
    good.replace('2032127', '2147483648'),
    good.replace('2032127', '-2147483649'),
    good.replace('2032127', '-0'),
    good.replace('2032127\t0', '2032127\t2'),
    good.replace(`O\t${sid}`, `O\t${sid}\tunexpected`),
    good.replace(`O\t${sid}`, 'O\tS-1-5-021-111-222-333-1001'),
    good + 'A\tS-1-1-0\t0\t1\t0\r\n',
    good.replace('END', 'E\u0000ND'),
  ]) assert.equal(parseWindowsAclRecord(malformed), null);
});

test('secret redactor handles arbitrary chunk boundaries, overlapping keys and encoded forms', () => {
  const secret = 'sk-fixture+/secret';
  const values = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
  for (const value of values) for (let split = 0; split <= value.length; split++) {
    const redactor = new SecretRedactor([secret]);
    const output = redactor.write('before ' + value.slice(0, split)) + redactor.write(value.slice(split) + ' after') + redactor.write('', true);
    assert.equal(output, 'before [REDACTED] after');
  }
  const redactor = new SecretRedactor(['abc', 'abcdef']);
  assert.equal(redactor.write('abc') + redactor.write('def and abc', true), '[REDACTED] and [REDACTED]');
});

test('run uses verified artifact and minimal private config, safe argv/env, isolated cwd/outputs and cleanup', posix, async (t) => {
  const { root, ctx, release } = await releaseFixture(t);
  await fakePython(t, root);
  envValue(t, 'SKILLSHELF_TEST_SEARCH_KEY', 'secret-key-for-run');
  envValue(t, 'PANEL_API_KEY', 'unrelated-panel-key');
  envValue(t, 'NODE_OPTIONS', '--require=/not/a/module');
  envValue(t, 'PYTHONPATH', '/untrusted-python');
  envValue(t, 'PYTHONIOENCODING', 'cp1252');
  envValue(t, 'PYTHONUTF8', '0');
  await addProvider(ctx, search());
  await addProvider(ctx, { id: 'image-unused', kind: 'image', model: 'gpt-image-1', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'UNRELATED_IMAGE_KEY' });
  const args = ['query with spaces; $(not-a-shell)', '--count', '2'];
  const result = await runSkill({ ...ctx, offline: false }, release, args, { capture: true, project: root });
  assert.equal(result.exitCode, 0); assert.equal(result.stderr, '[REDACTED]');
  const record = JSON.parse(result.stdout);
  assert.deepEqual(record.argv.slice(0, 6), ['-B', '-E', '-s', '-S', '-X', 'utf8']);
  assert.deepEqual(record.argv.slice(7), args);
  assert.deepEqual(record.resources, [{ id: 'search-main', kind: 'search', hasKey: true, envRef: null }]);
  assert.equal(record.cwd, result.workdir); assert.equal(record.outputs, result.outputs);
  assert.equal(record.directoryMode, 0o700); assert.equal(record.configMode, 0o600);
  for (const key of ['PANEL_API_KEY', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONIOENCODING', 'PYTHONUTF8', 'SKILLSHELF_TEST_SEARCH_KEY']) assert.equal(record.environment.includes(key), false);
  assert.equal(record.environment.includes('SKILLSHELF_RUNTIME_CONFIG'), true);
  assert.equal(record.environment.includes('SKILLSHELF_OUTPUTS'), true);
  await assert.rejects(lstat(result.workdir), { code: 'ENOENT' });
  await assert.rejects(lstat(record.configPath), { code: 'ENOENT' });
  assert.equal((await lstat(path.join(result.outputs, 'record.json'))).isFile(), true);
  assert.deepEqual(await readdir(path.join(ctx.home, 'runtime')), []);
  assert.equal(JSON.stringify(result).includes('secret-key-for-run'), false);
});

test('run verifies the full tree and artifact before any interpreter starts', posix, async (t) => {
  const { root, ctx, release, object, artifact } = await releaseFixture(t);
  const executable = await fakePython(t, root);
  envValue(t, 'SKILLSHELF_TEST_SEARCH_KEY', 'safe-test-key');
  await addProvider(ctx, search());
  await writeFile(path.join(object, 'skill', 'unexpected.txt'), 'injected');
  await assert.rejects(runSkill({ ...ctx, offline: false }, release, ['query'], { capture: true }));
  await rm(path.join(object, 'skill', 'unexpected.txt'));
  await writeFile(artifact, 'tampered');
  await assert.rejects(runSkill({ ...ctx, offline: false }, release, ['query'], { capture: true }), /integrity|gzip|package/);
  assert.equal((await lstat(executable)).isFile(), true);
  await assert.rejects(lstat(path.join(ctx.home, 'runtime')), { code: 'ENOENT' });
});

test('run rejects arbitrary/local/panel skills, wrong kind/entrypoint/provider declaration or snapshot', posix, async (t) => {
  const { ctx, release } = await releaseFixture(t);
  for (const modified of [
    { ...release, id: 'other-skill' }, { ...release, origin: 'local' }, { ...release, origin: 'panel' }, { ...release, packageName: '@untrusted/' + release.id },
    { ...release, manifest: { ...release.manifest, runtime: { ...release.manifest.runtime, kind: 'node' } } },
    { ...release, manifest: { ...release.manifest, runtime: { ...release.manifest.runtime, entrypoint: '../evil.py' } } },
    { ...release, manifest: { ...release.manifest, runtime: { ...release.manifest.runtime, providers: ['image'] } } },
    { ...release, catalogEntry: { ...release.catalogEntry, integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64') } },
  ]) await assert.rejects(runSkill(ctx, modified, ['query'], { capture: true }));
});

test('current catalog changes do not invalidate an installed exact historical snapshot', posix, async (t) => {
  const { root, ctx, release } = await releaseFixture(t);
  await fakePython(t, root);
  const result = await runSkill({ ...ctx, catalogPath: path.join(root, 'nonexistent-new-catalog.json') }, release, ['--help'], { capture: true });
  assert.equal(result.exitCode, 0); assert.equal(JSON.parse(result.stdout).resources.length, 0);
});

test('offline refuses billable/network work while --help stays local and no credentials are provided', posix, async (t) => {
  const { root, ctx, release } = await releaseFixture(t);
  await fakePython(t, root);
  envValue(t, 'SKILLSHELF_TEST_SEARCH_KEY', 'key-fixture');
  await addProvider(ctx, search());
  await assert.rejects(runSkill(ctx, release, ['query'], { capture: true }), /offline/);
  const help = await runSkill(ctx, release, ['--help'], { capture: true });
  assert.deepEqual(JSON.parse(help.stdout).resources, []); assert.equal(help.stderr, '');
});

test('run refuses config/output/key overrides, abbreviations and known secrets in process argv', posix, async (t) => {
  const { ctx, release } = await releaseFixture(t);
  envValue(t, 'SKILLSHELF_TEST_SEARCH_KEY', 'key-never-in-argv');
  await addProvider(ctx, search());
  for (const args of [['query', '--config', '/tmp/config'], ['query', '--conf=other'], ['query', '--output=/tmp'], ['query', '--api-key=other'], ['query', '--token=other'], ['key-never-in-argv']]) {
    await assert.rejects(runSkill({ ...ctx, offline: false }, release, args, { capture: true }), /overridden|arguments/);
  }
});

test('missing/old interpreter is a local dependency report with no auto-install', posix, async (t) => {
  const { root, ctx, release } = await releaseFixture(t);
  envValue(t, 'SKILLSHELF_PYTHON', path.join(root, 'missing-python'));
  await assert.rejects(runSkill(ctx, release, ['--help'], { capture: true }), /Python 3.10/);
  await fakePython(t, root, '3.9.9');
  await assert.rejects(runSkill(ctx, release, ['--help'], { capture: true }), /Python 3.10/);
  await assert.rejects(lstat(path.join(ctx.home, 'runtime')), { code: 'ENOENT' });
});

test('nonzero execution is returned once and private temp config is removed without retry', posix, async (t) => {
  const { root, ctx, release } = await releaseFixture(t);
  await fakePython(t, root); envValue(t, 'SKILLSHELF_TEST_SEARCH_KEY', 'failure-secret');
  await addProvider(ctx, search());
  const result = await runSkill({ ...ctx, offline: false }, release, ['query', '--fail-fixture'], { capture: true });
  assert.equal(result.exitCode, 7); assert.equal(result.stderr, '[REDACTED]');
  assert.equal((await readdir(path.join(ctx.home, 'outputs'))).length, 1);
  assert.deepEqual(await readdir(path.join(ctx.home, 'runtime')), []);
});

test('media selects only needed resource and supports protocol profile with relative input rebasing', posix, async (t) => {
  const { root, ctx, release } = await releaseFixture(t, true);
  await fakePython(t, root); envValue(t, 'IMAGE_TEST_KEY', 'image-secret');
  await addProvider(ctx, { id: 'image-main', kind: 'image', model: 'gpt-image-1', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'IMAGE_TEST_KEY' });
  await addProvider(ctx, { id: 'video-unused', kind: 'video', model: 'video-fixture', baseUrl: 'https://video.example.com/v1', apiKeyEnv: 'ABSENT_VIDEO_KEY' });
  const result = await runSkill({ ...ctx, offline: false }, release, ['image', 'prompt', '--reference', 'reference.png', '--output-format', 'png'], { capture: true, project: root });
  const record = JSON.parse(result.stdout);
  assert.deepEqual(record.resources.map(row => row.id), ['image-main']);
  assert.equal(record.argv.includes(path.join(root, 'reference.png')), true);
  const metadata = await runSkill(ctx, release, ['resources'], { capture: true });
  assert.equal(JSON.parse(metadata.stdout).resources.length, 2);
  assert.equal(JSON.parse(metadata.stdout).resources.every(row => row.hasKey === false), true);
});

test('doctor inspects versions, permissions, providers and integrity without task execution', posix, async (t) => {
  const { root, ctx, release } = await releaseFixture(t);
  await fakePython(t, root); envValue(t, 'SKILLSHELF_TEST_SEARCH_KEY', undefined);
  await addProvider(ctx, search());
  const report = await runtimeDoctor(ctx, [release, { ...release, id: 'instruction-only', manifest: { ...release.manifest, runtime: { kind: 'instructions', requiresNetwork: false } } }]);
  assert.equal(report.network, 'not-requested'); assert.equal(report.python.available, true);
  assert.equal(report.configuration.ok, false); assert.deepEqual(report.configuration.missingEnvironment, ['SKILLSHELF_TEST_SEARCH_KEY']);
  assert.equal(report.releases[0].status, 'missing'); assert.equal(report.releases[1].status, 'instructions');
  await assert.rejects(lstat(path.join(ctx.home, 'outputs')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(ctx.home, 'runtime')), { code: 'ENOENT' });
});
