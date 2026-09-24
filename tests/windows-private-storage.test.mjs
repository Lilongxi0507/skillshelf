import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addProvider, listProviders } from '../packages/cli/dist/runtime/providers.js';
import { assertPrivatePath } from '../packages/cli/dist/runtime/privacy.js';

test('Windows creates private provider ACLs and refuses an added Everyone ACE', { skip: process.platform === 'win32' ? false : 'Windows ACL integration test', timeout: 60_000 }, async t => {
  const root = await mkdtemp(path.join(process.env.SKILLSHELF_TEST_TMP ?? tmpdir(), 'skillshelf-win-acl-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = { home: path.join(root, 'home'), offline: true };
  const view = await addProvider(ctx, {
    id: 'search-fixture', kind: 'search', adapter: 'tavily',
    baseUrl: 'https://api.tavily.com', apiKeyEnv: 'SKILLSHELF_TEST_ONLY_KEY',
  });
  assert.equal(view.resources.length, 1);
  const filename = path.join(ctx.home, 'config', 'providers.json');
  await assertPrivatePath(ctx.home, true);
  await assertPrivatePath(path.dirname(filename), true);
  await assertPrivatePath(filename, false);
  assert.equal((await listProviders(ctx)).resources[0].key.env, 'SKILLSHELF_TEST_ONLY_KEY');
  assert.equal((await readFile(filename, 'utf8')).includes('SKILLSHELF_TEST_ONLY_KEY'), true);

  const icacls = path.win32.join(process.env.SystemRoot, 'System32', 'icacls.exe');
  const granted = spawnSync(icacls, [filename, '/grant', '*S-1-1-0:R', '/q'], { encoding: 'utf8', windowsHide: true });
  assert.equal(granted.status, 0, granted.stderr);
  try {
    await assert.rejects(listProviders(ctx), /ACL|private/);
  } finally {
    const removed = spawnSync(icacls, [filename, '/remove', '*S-1-1-0', '/q'], { encoding: 'utf8', windowsHide: true });
    assert.equal(removed.status, 0, removed.stderr);
  }
  assert.equal((await listProviders(ctx)).resources.length, 1);
});
