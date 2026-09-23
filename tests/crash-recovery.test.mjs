import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, realpath, symlink, chmod, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { emptyState, loadState } from '../packages/cli/dist/store/state.js';
import { fingerprint } from '../packages/cli/dist/store/fs.js';
import { transact, recoverTransactions, pendingTransactions, targetWorkRoot, targetLock } from '../packages/cli/dist/transactions/transaction.js';

// Enable real process-crash tests with an existing private fixture directory in
// SKILLSHELF_TEST_TMP. No fixture ever uses the real user's home.
const supported = Boolean(process.env.SKILLSHELF_TEST_TMP);
const skip = supported ? false : 'Set SKILLSHELF_TEST_TMP to an existing isolated test directory';
const moduleUrls = {
  transaction: new URL('../packages/cli/dist/transactions/transaction.js', import.meta.url).href,
  state: new URL('../packages/cli/dist/store/state.js', import.meta.url).href,
};
const CHILD_TIMEOUT_MS = 20_000;
const MAX_CAPTURE = 64 * 1024;

function inside(root, path) {
  const part = relative(root, path);
  return part === '' || part !== '..' && !part.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(part);
}

/** Only descend actual directories within this exact mkdtemp root; unlink links. */
async function removeFixture(root, path = root) {
  assert.ok(inside(root, path), 'fixture cleanup must not leave its exact root');
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) { await unlink(path); return; }
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await removeFixture(root, join(path, name));
  await rmdir(path);
}

function isolatedEnvironment(root) {
  const home = join(root, 'os-home');
  return {
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local', 'state'),
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'),
    OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
    DSH_HOME: join(home, '.dsh'), DSH_AGENTS_HOME: join(home, '.agents'),
    HERMES_HOME: join(home, '.hermes'), SKILLSHELF_HOME: join(root, 'unused-default-home'),
    TMPDIR: root, TMP: root, TEMP: root, SKILLSHELF_TEST_TMP: root,
  };
}

async function fixture(t) {
  assert.ok(supported, 'fixture must be skipped without an isolated temp root');
  const base = await realpath(resolve(process.env.SKILLSHELF_TEST_TMP));
  assert.ok((await lstat(base)).isDirectory());
  const root = await mkdtemp(join(base, 'skillshelf-crash-'));
  const env = isolatedEnvironment(root), saved = new Map(), children = [];
  await mkdir(env.HOME, { mode: 0o700 });
  for (const [key, value] of Object.entries(env)) { saved.set(key, process.env[key]); process.env[key] = value; }
  const identity = await lstat(root);
  t.after(async () => {
    try {
      for (const child of children) await child.stop();
      const current = await lstat(root);
      assert.equal(current.isSymbolicLink(), false, 'fixture root was replaced with a link');
      assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
      await removeFixture(root);
    } finally {
      for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  const script = join(root, 'transaction-worker.mjs');
  // This is our constant, trusted test program, not code from a catalog or skill.
  await writeFile(script, `
import { writeFile, symlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { transact, targetWorkRoot } from ${JSON.stringify(moduleUrls.transaction)};
import { emptyState } from ${JSON.stringify(moduleUrls.state)};
const input = JSON.parse(process.argv[2]);
const send = (message) => new Promise((resolve, reject) => {
  if (!process.send) return reject(new Error('IPC channel required'));
  process.send(message, error => error ? reject(error) : resolve());
});
let release;
const gate = new Promise(resolve => { release = resolve; });
process.on('message', message => { if (message?.type === 'release') release(); });
try {
  const changes = input.items.map(item => ({
    path: item.path,
    workRoot: targetWorkRoot(dirname(item.path)),
    expected: item.expected,
    prepare: stage => item.kind === 'link'
      ? symlink(item.linkTarget, stage, process.platform === 'win32' ? 'junction' : 'dir')
      : writeFile(stage, Buffer.from(item.next, 'base64'), { flag: 'wx', mode: 0o600 }),
  }));
  await transact({ home: input.home, offline: true }, emptyState(), emptyState(), changes, {
    afterStep: async (step, index) => {
      if (input.mode === 'kill' && step === input.step && (index === -1 || index === 0)) {
        await send({ type: 'killing', step, index });
        // On Windows the parent force-terminates the child after this IPC
        // barrier. This avoids treating a failed self-signal as a crash.
        if (process.platform === 'win32') await new Promise(() => {});
        process.kill(process.pid, 'SIGKILL');
        throw new Error('SIGKILL unexpectedly returned');
      }
      if (input.mode === 'hold' && step === 'prepared') {
        await send({ type: 'held', step, index });
        await gate;
      }
    },
  });
  await send({ type: 'completed' });
} catch (error) {
  console.error(error?.stack || String(error)); process.exitCode = 1;
} finally { if (process.connected) process.disconnect(); }
`, { flag: 'wx', mode: 0o600 });
  return { root, env, script, children, ctx: { home: join(root, 'home'), offline: true } };
}

function startWorker(f, input) {
  const child = spawn(process.execPath, [f.script, JSON.stringify(input)], {
    cwd: f.env.HOME,
    // Deliberately do not inherit NODE_OPTIONS, provider credentials or Panel config.
    env: { ...f.env, PATH: process.env.PATH || '', LANG: 'C.UTF-8', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '', stderr = '', spawnError, timedOut = false;
  const messages = [], listeners = new Set();
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-MAX_CAPTURE); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-MAX_CAPTURE); });
  child.on('message', message => {
    messages.push(message); for (const listener of listeners) listener(message);
    if (process.platform === 'win32' && message?.type === 'killing') child.kill('SIGKILL');
  });
  child.on('error', error => { spawnError = error; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, CHILD_TIMEOUT_MS);
  const done = new Promise(resolveDone => child.once('close', (code, signal) => {
    clearTimeout(timer); resolveDone({ code, signal, stdout, stderr, spawnError, timedOut });
  }));
  const worker = {
    child, done, messages,
    waitFor(type) {
      const prior = messages.find(message => message?.type === type);
      if (prior) return Promise.resolve(prior);
      return new Promise((resolveMessage, rejectMessage) => {
        const listener = message => {
          if (message?.type === type) { listeners.delete(listener); resolveMessage(message); }
        };
        listeners.add(listener);
        void done.then(result => { listeners.delete(listener); rejectMessage(new Error(`Worker ended before ${type}: ${JSON.stringify(result)}`)); });
      });
    },
    release() { return new Promise((resolveSent, rejectSent) => child.send({ type: 'release' }, error => error ? rejectSent(error) : resolveSent())); },
    async stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; },
  };
  f.children.push(worker);
  return worker;
}

function fileBytes(label, index) {
  return Buffer.concat([Buffer.from(`${label} 完整文件 ${index}\n`, 'utf8'), Buffer.from([0, 255, 1, 128, 13, 10]), Buffer.alloc(257 + index, index + 17)]);
}
async function fileItems(f, count = 2) {
  const items = [];
  for (let index = 0; index < count; index++) {
    const path = join(f.root, `agent-${index}`, 'skills', 'fixture-skill');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const old = fileBytes('old', index), next = fileBytes('new', index);
    await writeFile(path, old, { flag: 'wx', mode: 0o600 });
    items.push({ path, expected: await fingerprint(path), next: next.toString('base64'), old, nextBytes: next });
  }
  return items;
}
async function journalFor(ctx) {
  const names = (await readdir(join(ctx.home, 'transactions'))).filter(name => name.endsWith('.json'));
  assert.equal(names.length, 1, 'exactly one real interrupted journal');
  return JSON.parse(await readFile(join(ctx.home, 'transactions', names[0]), 'utf8'));
}
function childItems(items) { return items.map(({ old, nextBytes, ...item }) => item); }
function assertExit(result, expectedSignal = null) {
  assert.equal(result.spawnError, undefined, result.stderr);
  assert.equal(result.timedOut, false, `child exceeded deadline: ${result.stderr}`);
  if (process.platform === 'win32' && expectedSignal === 'SIGKILL') {
    assert.ok(result.signal === 'SIGKILL' || result.code !== 0, `worker was not terminated: ${result.stderr}`);
  } else {
    assert.equal(result.signal, expectedSignal, result.stderr);
    assert.equal(result.code, expectedSignal ? null : 0, result.stderr);
  }
}

for (const step of ['prepared', 'backed-up', 'switched', 'state-committed']) {
  test(`real SIGKILL at ${step} recovers exact files and ${step === 'state-committed' ? 'committed' : 'previous'} state`, { skip, timeout: 45_000, concurrency: false }, async t => {
    const f = await fixture(t), items = await fileItems(f);
    const worker = startWorker(f, { mode: 'kill', step, home: f.ctx.home, items: childItems(items) });
    const result = await worker.done;
    assertExit(result, 'SIGKILL');
    assert.deepEqual(worker.messages, [{ type: 'killing', step, index: ['prepared', 'state-committed'].includes(step) ? -1 : 0 }]);
    const journal = await journalFor(f.ctx);
    assert.equal(journal.phase, 'prepared');
    assert.equal(journal.baseGeneration, 0); assert.equal(journal.newGeneration, 1);
    assert.equal(journal.operations.length, items.length);
    for (const [index, operation] of journal.operations.entries()) {
      assert.equal(operation.path, items[index].path);
      assert.equal(operation.workRoot, targetWorkRoot(dirname(operation.path)));
      assert.equal(inside(dirname(operation.path), operation.stage), false, 'staging must not be in a skill scan root');
      assert.equal(inside(dirname(operation.path), operation.backup), false, 'backups must not be in a skill scan root');
      assert.equal(inside(f.root, operation.workRoot), true);
    }
    const before = await loadState(f.ctx);
    assert.equal(before.generation, step === 'state-committed' ? 1 : 0);
    assert.equal(before.lastTransactionId, step === 'state-committed' ? journal.id : null);
    assert.deepEqual(await pendingTransactions(f.ctx), [journal.id + '.json']);
    if (step === 'backed-up') assert.equal(await fingerprint(items[0].path), null);
    if (step === 'switched') {
      assert.deepEqual(await readFile(items[0].path), items[0].nextBytes);
      assert.deepEqual(await readFile(items[1].path), items[1].old, 'second target was not switched before the kill');
    }
    assert.deepEqual(await recoverTransactions(f.ctx), { recovered: [journal.id] });
    const after = await loadState(f.ctx), committed = step === 'state-committed';
    assert.deepEqual(after, committed ? { ...emptyState(), generation: 1, lastTransactionId: journal.id } : emptyState());
    for (const [index, item] of items.entries()) {
      assert.deepEqual(await readFile(item.path), committed ? item.nextBytes : item.old, 'exact binary and UTF-8 bytes survive recovery');
      assert.equal(await fingerprint(item.path), committed ? journal.operations[index].newHash : item.expected);
      assert.equal(await fingerprint(journal.operations[index].stage), null, 'no staged replacement survives recovery');
      assert.equal(await fingerprint(journal.operations[index].backup), committed ? item.expected : null, 'committed backups remain available; rolled-back backups are restored');
      assert.equal(await fingerprint(targetLock(dirname(item.path))), null, 'dead target lock reclaimed and released');
    }
    assert.equal(await fingerprint(join(f.ctx.home, 'writer.lock')), null);
    assert.equal((await journalFor(f.ctx)).phase, committed ? 'committed' : 'recovered');
    assert.deepEqual(await recoverTransactions(f.ctx), { recovered: [] }, 'recovery is idempotent');
    assert.deepEqual(await pendingTransactions(f.ctx), []);
  });
}

test('independent homes contend for the same physical target lock and reject stale overwrite', { skip, timeout: 45_000, concurrency: false }, async t => {
  const f = await fixture(t), items = await fileItems(f, 1), [item] = items;
  const first = { home: join(f.root, 'home-a'), offline: true };
  const second = { home: join(f.root, 'home-b'), offline: true };
  assert.notEqual(first.home, second.home);
  const worker = startWorker(f, { mode: 'hold', home: first.home, items: childItems(items) });
  await worker.waitFor('held'); // IPC barrier: no sleeps or races guessing lock acquisition.
  const lockPath = targetLock(dirname(item.path));
  const heldLock = await readFile(lockPath, 'utf8');
  assert.equal(JSON.parse(heldLock).pid, worker.child.pid);
  let prepareCalls = 0;
  const change = {
    path: item.path, workRoot: targetWorkRoot(dirname(item.path)), expected: item.expected,
    prepare: async stage => { prepareCalls++; await writeFile(stage, 'must not overwrite', { flag: 'wx' }); },
  };
  await assert.rejects(transact(second, emptyState(), emptyState(), [change]), error => {
    assert.equal(error.code, 'CONFLICT'); assert.match(error.message, /持有安装锁/); return true;
  });
  assert.equal(prepareCalls, 0, 'contender cannot even stage while another home holds the target');
  assert.deepEqual(await loadState(second), emptyState());
  assert.deepEqual(await readFile(item.path), item.old);
  assert.equal(await readFile(lockPath, 'utf8'), heldLock, 'contender must not delete or replace the live owner lock');
  await worker.release(); assertExit(await worker.done);
  assert.deepEqual(await readFile(item.path), item.nextBytes);
  assert.equal((await loadState(first)).generation, 1);
  assert.equal(await fingerprint(lockPath), null);
  await assert.rejects(transact(second, emptyState(), emptyState(), [change]), error => {
    assert.equal(error.code, 'CONFLICT'); assert.match(error.message, /目标内容已变化/); return true;
  });
  assert.equal(prepareCalls, 0, 'after lock release the stale precondition must still prevent overwrite');
  assert.deepEqual(await loadState(second), emptyState());
  assert.deepEqual(await readFile(item.path), item.nextBytes);
});

test('SIGKILL recovery unlinks only the projection and preserves both linked content trees', { skip, timeout: 45_000, concurrency: false }, async t => {
  const f = await fixture(t);
  const oldTree = join(f.root, 'content-old'), newTree = join(f.root, 'content-new');
  for (const [index, directory] of [oldTree, newTree].entries()) {
    await mkdir(join(directory, 'references'), { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: fixture-skill\ndescription: ${index}\n---\n`);
    await writeFile(join(directory, 'references', 'asset.bin'), fileBytes('untouched', index));
  }
  const path = join(f.root, 'agent', 'skills', 'fixture-skill');
  await mkdir(dirname(path), { recursive: true });
  try { await symlink(oldTree, path, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL', 'UNKNOWN'].includes(error.code)) {
      t.skip('Windows runner cannot create junctions; file-tree crash recovery remains covered');
      return;
    }
    throw error;
  }
  const oldHash = await fingerprint(oldTree), newHash = await fingerprint(newTree), linkHash = await fingerprint(path);
  const worker = startWorker(f, { mode: 'kill', step: 'switched', home: f.ctx.home,
    items: [{ path, expected: linkHash, kind: 'link', linkTarget: newTree }] });
  const result = await worker.done;
  assert.deepEqual(worker.messages, [{ type: 'killing', step: 'switched', index: 0 }],
    `worker must reach the switched crash barrier before its exit is accepted: ${result.stderr}`);
  assertExit(result, 'SIGKILL');
  assert.equal(await realpath(path), await realpath(newTree));
  const journal = await journalFor(f.ctx);
  assert.deepEqual(await recoverTransactions(f.ctx), { recovered: [journal.id] });
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.equal(await realpath(path), await realpath(oldTree));
  assert.equal(await fingerprint(oldTree), oldHash, 'old tree is never removed through its projection');
  assert.equal(await fingerprint(newTree), newHash, 'new tree is never removed through its projection');
  assert.deepEqual(await loadState(f.ctx), emptyState());
  assert.deepEqual(await recoverTransactions(f.ctx), { recovered: [] });
});
