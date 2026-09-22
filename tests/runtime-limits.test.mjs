import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addProvider, listProviders } from '../packages/cli/dist/runtime/providers.js';
import { readPrivateFile, PRIVATE_CONFIG_MAX_BYTES } from '../packages/cli/dist/runtime/privacy.js';

const posix = { skip: process.platform === 'win32' ? 'POSIX private-mode fixtures; does not imply real-host Windows verification' : false };
async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.SKILLSHELF_TEST_TMP ?? tmpdir(), 'skillshelf-private-limits-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = { home: path.join(root, 'home'), offline: true };
  return { root, ctx };
}

test('provider UTF-8 byte budget refuses overflow before replacing readable configuration', posix, async (t) => {
  const { ctx } = await fixture(t);
  await mkdir(path.join(ctx.home, 'config'), { recursive: true, mode: 0o700 });
  const filename = path.join(ctx.home, 'config', 'providers.json');
  // Each valid profile is <32Ki characters but materially larger in UTF-8 bytes.
  const profile = { descriptions: Array.from({ length: 15 }, () => '界'.repeat(1800)) };
  const row = (index) => ({ id: 'search-' + index, kind: 'search', name: 'Search', model: 'tavily', base_url: 'https://api.tavily.com/', endpoint: 'https://api.tavily.com/search', adapter: 'tavily', profile, api_key_env: 'SKILLSHELF_LIMIT_TEST_KEY' });
  const resources = []; let previous;
  for (let index = 0; ; index++) {
    resources.push(row(index));
    const contents = JSON.stringify({ version: 1, resources, defaults: { search: 'search-0' } }, null, 2) + '\n';
    if (Buffer.byteLength(contents) > PRIVATE_CONFIG_MAX_BYTES) { resources.pop(); break; }
    previous = contents;
  }
  assert.ok(previous); await writeFile(filename, previous, { mode: 0o600 });
  assert.equal((await listProviders(ctx)).resources.length, resources.length);
  await assert.rejects(addProvider(ctx, { id: 'one-too-many', kind: 'search', adapter: 'tavily', baseUrl: 'https://api.tavily.com', apiKeyEnv: 'SKILLSHELF_LIMIT_TEST_KEY', profile }), /1 MiB/);
  assert.equal(await readFile(filename, 'utf8'), previous);
  assert.equal((await listProviders(ctx)).resources.length, resources.length);
  assert.deepEqual(await readdir(path.dirname(filename)), ['providers.json']);
});

test('private reads accept the exact byte limit, refuse oversize and reject invalid UTF-8', posix, async (t) => {
  const { root } = await fixture(t); const filename = path.join(root, 'private.json');
  await writeFile(filename, Buffer.alloc(PRIVATE_CONFIG_MAX_BYTES, 65), { mode: 0o600 });
  assert.equal((await readPrivateFile(filename)).length, PRIVATE_CONFIG_MAX_BYTES);
  await appendFile(filename, 'B');
  await assert.rejects(readPrivateFile(filename), /too large/);
  await writeFile(filename, Buffer.from([0xc3, 0x28]), { mode: 0o600 });
  await assert.rejects(readPrivateFile(filename), /UTF-8/);
});

test('private read detects a concurrently grown file with bounded allocation and post-read stat', posix, async (t) => {
  const { root } = await fixture(t); const filename = path.join(root, 'private.json');
  await writeFile(filename, 'original', { mode: 0o600 });
  const probe = await open(filename, 'r'); const prototype = Object.getPrototypeOf(probe); const originalRead = prototype.read; await probe.close();
  let grew = false;
  t.mock.method(prototype, 'read', async function (...args) {
    const result = await Reflect.apply(originalRead, this, args);
    if (!grew) { grew = true; await appendFile(filename, 'unexpected-growth'); }
    return result;
  });
  await assert.rejects(readPrivateFile(filename), /changed while reading/);
  assert.equal(grew, true); assert.equal((await lstat(filename)).size, Buffer.byteLength('originalunexpected-growth'));
});
