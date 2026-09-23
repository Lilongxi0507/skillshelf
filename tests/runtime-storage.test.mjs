import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, writeFile, readFile, readdir, lstat, rm, symlink, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { canonicalPath, ensurePrivateDir, fingerprint, keyFor, writeJson, FINGERPRINT_LIMITS } from '../packages/cli/dist/store/fs.js';
import { emptyState, validateState, releaseKey, loadState, initHome } from '../packages/cli/dist/store/state.js';
import { resolveAgentTarget } from '../packages/cli/dist/agents/agents.js';
import { inventory, digestManifest } from '../packages/cli/dist/validation.js';
import { transact, targetWorkRoot, checkJournal, recoverTransactions } from '../packages/cli/dist/transactions/transaction.js';
import { acquireLock, orderedLocks } from '../packages/cli/dist/transactions/locks.js';

const posix = { skip: process.platform === 'win32' ? 'POSIX symlink/mode fixtures; Windows ACL behavior is separately fail-closed' : false };
async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.SKILLSHELF_TEST_TMP ?? tmpdir(), 'skillshelf-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, ctx: { home: path.join(root, 'home'), offline: true } };
}
async function sampleState(t) {
  const result = await fixture(t); const { root } = result;
  const source = path.join(root, 'source'); await mkdir(source, { mode: 0o700 });
  await writeFile(path.join(source, 'SKILL.md'), '# Fixture\n', { mode: 0o600 });
  await writeFile(path.join(source, 'LICENSE'), 'MIT\n', { mode: 0o600 });
  const files = await inventory(source); const contentDigest = digestManifest(files); const id = 'fixture-skill';
  const manifest = { schemaVersion: 1, id, name: id, files, contentDigest, runtime: { kind: 'instructions', requiresNetwork: false } };
  const release = { key: releaseKey(id, '1.0.0', contentDigest), id, name: id, version: '1.0.0', packageName: 'local:' + id, integrity: '', contentDigest, manifest, source: {}, installedAt: new Date(0).toISOString(), origin: 'local' };
  const state = emptyState(); state.releases[release.key] = release; state.selections[id] = { releaseKey: release.key, pinned: false, history: [] };
  const target = await resolveAgentTarget('custom', { home: root, env: {}, path: path.join(root, 'agent', 'skills') });
  state.targets[target.id] = target;
  const projected = path.join(target.path, id); const key = keyFor(projected);
  state.projections[key] = { key, path: projected, releaseKey: release.key, mode: 'copy', targetIds: [target.id] };
  return { ...result, state, release, target };
}

test('strict state rejects extra schema, unsafe names, wrong keys and broken projection ownership', posix, async (t) => {
  const { state, release, target } = await sampleState(t);
  assert.deepEqual(validateState(state), state);
  const mutations = [
    (s) => { s.extra = true; },
    (s) => { s.releases[release.key].name = '../escape'; },
    (s) => { s.releases[release.key].key = release.id + '@1.0.0'; },
    (s) => { s.releases[release.key].manifest.files[0].sha256 = '0'.repeat(64); },
    (s) => { s.targets[target.id].id = 'made-up'; },
    (s) => { s.targets[target.id].scanRoots = []; },
    (s) => { const p = Object.values(s.projections)[0]; p.path = path.join(target.path, '..', 'outside'); },
    (s) => { Object.values(s.projections)[0].targetIds.push('missing'); },
    (s) => { s.selections[release.id].history = [release.key]; },
    (s) => { s.selections[release.id].pinned = 'false'; },
    (s) => { s.generation = 1; },
  ];
  for (const mutate of mutations) { const invalid = structuredClone(state); mutate(invalid); assert.throws(() => validateState(invalid)); }
});

test('state release provenance cannot be promoted without fixed npm namespace and exact catalog snapshot', posix, async (t) => {
  const { state, release } = await sampleState(t);
  const promoted = structuredClone(state); promoted.releases[release.key].origin = 'npm';
  assert.throws(() => validateState(promoted), /npm/);
  const localSnapshot = structuredClone(state); localSnapshot.releases[release.key].catalogEntry = {};
  assert.throws(() => validateState(localSnapshot), /npm/);
  const forged = structuredClone(state); forged.releases[release.key].manifest.runtime = { kind: 'python', entrypoint: 'scripts/run.py', requiresNetwork: true };
  assert.throws(() => validateState(forged), /manifest/);
});

test('project state permits exact recorded spec/lock hashes but rejects outside project files', posix, async (t) => {
  const { root, state } = await sampleState(t);
  const project = path.join(root, 'project');
  state.projects[project] = { root: project, specPath: path.join(project, 'skillshelf.json'), lockPath: path.join(project, 'skillshelf-lock.json'), specHash: 'file:' + 'a'.repeat(64), lockHash: 'file:' + 'b'.repeat(64), selections: {} };
  validateState(state);
  state.projects[project].specPath = path.join(root, 'outside.json');
  assert.throws(() => validateState(state), /项目/);
});

test('ensurePrivateDir refuses changed ancestor links and leaves native permissions unchanged', posix, async (t) => {
  const { root } = await fixture(t);
  const native = path.join(root, 'native'); await mkdir(native, { mode: 0o755 }); await chmod(native, 0o755);
  await ensurePrivateDir(native); assert.equal((await lstat(native)).mode & 0o7777, 0o755);
  const outside = path.join(root, 'outside'); await mkdir(outside); const alias = path.join(root, 'alias'); await symlink(outside, alias);
  await assert.rejects(ensurePrivateDir(path.join(alias, 'new')), /链接/);
  assert.deepEqual(await readdir(outside), []);
  const dangling = path.join(root, 'dangling'); await symlink(path.join(root, 'absent'), dangling);
  await assert.rejects(canonicalPath(path.join(dangling, 'child')), /悬空/);
});

test('fingerprint rejects oversized sparse files without reading them and preserves old hash grammar', posix, async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, 'large'); const handle = await open(file, 'wx');
  await handle.truncate(FINGERPRINT_LIMITS.fileBytes + 1); await handle.close();
  await assert.rejects(fingerprint(file), /安全大小/);
  await writeFile(path.join(root, 'small'), 'fixture');
  assert.match(await fingerprint(path.join(root, 'small')), /^file:[a-f0-9]{64}$/);
  const directory = path.join(root, 'directory'); await mkdir(directory); await writeFile(path.join(directory, 'one'), 'a');
  assert.match(await fingerprint(directory), /^dir:[a-f0-9]{64}$/);
  const alias = path.join(root, 'link'); await symlink(directory, alias);
  assert.equal(await fingerprint(alias), 'link:' + directory);
});

test('partial prepare failure removes only owned stage even before journal persistence', posix, async (t) => {
  const { root, ctx } = await fixture(t); const target = path.join(root, 'agent', 'skills', 'fixture');
  const workRoot = targetWorkRoot(path.dirname(target));
  await assert.rejects(transact(ctx, emptyState(), emptyState(), [{ path: target, workRoot, expected: null, prepare: async (stage) => {
    await mkdir(stage); await writeFile(path.join(stage, 'partial.txt'), 'partial'); throw new Error('prepare-fixture-failure');
  } }]), /prepare-fixture-failure/);
  assert.deepEqual(await readdir(workRoot), []);
  assert.deepEqual(await readdir(path.join(ctx.home, 'transactions')), []);
  assert.equal((await loadState(ctx)).generation, 0);
});

test('transaction checks stage integrity and swapped parent symlinks after prepare', posix, async (t) => {
  const { root, ctx } = await fixture(t); const skills = path.join(root, 'agent', 'skills'); const target = path.join(skills, 'fixture');
  await mkdir(skills, { recursive: true });
  const outside = path.join(root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'keep'), 'user');
  const workRoot = targetWorkRoot(skills); const moved = path.join(root, 'moved-skills');
  await assert.rejects(transact(ctx, emptyState(), emptyState(), [{ path: target, workRoot, expected: null, prepare: (stage) => writeFile(stage, 'new') }], {
    afterStep: async (step) => { if (step === 'prepared') { await rename(skills, moved); await symlink(outside, skills); } },
  }), /恢复|目录|链接/);
  assert.deepEqual(await readdir(outside), ['keep']); assert.equal(await readFile(path.join(outside, 'keep'), 'utf8'), 'user');
  await rm(skills); await rename(moved, skills);
  assert.equal((await recoverTransactions(ctx)).recovered.length, 1);
  await assert.rejects(lstat(target), { code: 'ENOENT' });
});

test('recovery rejects permissive substring stage/backup paths and unknown workroots', () => {
  const id = randomUUID(); const target = path.resolve('fixture', 'agent', 'skills', 'one'); const workRoot = targetWorkRoot(path.dirname(target));
  const journal = { schemaVersion: 1, id, baseGeneration: 0, newGeneration: 1, phase: 'prepared', operations: [{ path: target, workRoot, stage: path.join(workRoot, 'anything-' + id, '0-new'), backup: path.join(workRoot, id, '0-old'), oldHash: null, newHash: null, anchors: [{ path: workRoot, ino: 1, dev: 1 }] }], createdAt: new Date().toISOString() };
  assert.throws(() => checkJournal(journal), /路径/);
  journal.operations[0].stage = path.join(workRoot, id, '0-new'); journal.operations[0].workRoot = path.resolve('untrusted-work');
  assert.throws(() => checkJournal(journal), /路径/);
  assert.throws(() => checkJournal({ ...journal, extra: true }), /日志/);
});

test('journal anchors retain exact unsigned 64-bit identities and reject rounded numbers', () => {
  const id = randomUUID(); const target = path.resolve('fixture', 'agent', 'skills', 'one');
  const workRoot = targetWorkRoot(path.dirname(target)); const work = path.join(workRoot, id);
  const ancestors = (value) => { const result = []; for (let current = value; ; current = path.dirname(current)) { result.push(current); if (path.dirname(current) === current) return result; } };
  const paths = [...new Set([...ancestors(path.dirname(target)), ...ancestors(workRoot), work])].sort();
  const anchors = paths.map((value) => ({ path: value, dev: '18446744073709551615', ino: '9007199254740993' }));
  const journal = { schemaVersion: 1, id, baseGeneration: 0, newGeneration: 1, phase: 'prepared', operations: [{ path: target, workRoot, stage: path.join(work, '0-new'), backup: path.join(work, '0-old'), oldHash: null, newHash: null, anchors }], createdAt: new Date().toISOString() };
  assert.equal(checkJournal(journal).operations[0].anchors[0].ino, '9007199254740993');
  const legacy = structuredClone(journal); legacy.operations[0].anchors = anchors.map((anchor) => ({ ...anchor, dev: 1, ino: 2 }));
  assert.equal(checkJournal(legacy).operations[0].anchors[0].ino, 2);
  const rounded = structuredClone(journal); rounded.operations[0].anchors[0].ino = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => checkJournal(rounded), /日志/);
  for (const invalid of ['01', '-1', '18446744073709551616']) {
    const changed = structuredClone(journal); changed.operations[0].anchors[0].ino = invalid;
    assert.throws(() => checkJournal(changed), /日志/);
  }
});

test('transactions persist exact filesystem identities in recovery journals', async (t) => {
  const { root, ctx } = await fixture(t);
  const target = path.join(root, 'agent', 'skills', 'one'); const workRoot = targetWorkRoot(path.dirname(target));
  await transact(ctx, emptyState(), emptyState(), [{ path: target, workRoot, expected: null, prepare: (stage) => writeFile(stage, 'fixture') }]);
  const names = (await readdir(path.join(ctx.home, 'transactions'))).filter((name) => name.endsWith('.json'));
  assert.equal(names.length, 1);
  const journal = JSON.parse(await readFile(path.join(ctx.home, 'transactions', names[0]), 'utf8'));
  for (const anchor of journal.operations[0].anchors) {
    assert.match(anchor.dev, /^(?:0|[1-9]\d*)$/);
    assert.match(anchor.ino, /^(?:0|[1-9]\d*)$/);
    const actual = await lstat(anchor.path, { bigint: true });
    assert.equal(anchor.dev, actual.dev.toString()); assert.equal(anchor.ino, actual.ino.toString());
  }
});

test('lock ordering always takes home writer first and never releases another nonce', posix, async (t) => {
  const { root, ctx } = await fixture(t); await initHome(ctx);
  const writer = path.join(ctx.home, 'writer.lock'); const target = path.join(root, 'a-target', 'target.lock');
  assert.equal(orderedLocks([target, writer, target])[0], writer); assert.equal(orderedLocks([target, writer]).length, 2);
  const release = await acquireLock(writer);
  await assert.rejects(acquireLock(writer), /持有/);
  const lock = JSON.parse(await readFile(writer, 'utf8')); await writeJson(writer, { ...lock, nonce: randomUUID() });
  await assert.rejects(release(), /变化/);
  assert.equal((await lstat(writer)).isFile(), true);
});

test('transact validates proposed state before touching a home and rejects arbitrary workroot', posix, async (t) => {
  const { root, ctx } = await fixture(t);
  await assert.rejects(transact(ctx, emptyState(), { ...emptyState(), unexpected: true }, []), /状态/);
  assert.deepEqual(await readdir(root), []);
  const target = path.join(root, 'agent', 'skills', 'one');
  await assert.rejects(transact(ctx, emptyState(), emptyState(), [{ path: target, workRoot: path.join(root, 'anything'), expected: null }]), /受控/);
  assert.deepEqual(await readdir(root), []);
});
