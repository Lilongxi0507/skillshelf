import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addProvider, listProviders } from '../packages/cli/dist/runtime/providers.js';
import { assertPrivatePath, createPrivateFile, ensurePrivateDirectory } from '../packages/cli/dist/runtime/privacy.js';

function ownerSid(target) {
  const powershell = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '[Console]::Write((Get-Acl -LiteralPath $env:SKILLSHELF_TEST_ACL_PATH).GetOwner([System.Security.Principal.SecurityIdentifier]).Value)';
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, SKILLSHELF_TEST_ACL_PATH: target },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

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

test('Windows elevated creation assigns user ownership but does not repair existing storage', { skip: process.platform === 'win32' ? false : 'Windows ACL integration test', timeout: 60_000 }, async t => {
  const root = await mkdtemp(path.join(process.env.SKILLSHELF_TEST_TMP ?? tmpdir(), 'skillshelf-win-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (ownerSid(root) !== 'S-1-5-32-544') {
    t.skip('requires an elevated Windows token that creates Administrators-owned paths');
    return;
  }

  const whoami = path.win32.join(process.env.SystemRoot, 'System32', 'whoami.exe');
  const identity = spawnSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  assert.equal(identity.status, 0, identity.stderr);
  const sid = identity.stdout.match(/\bS-1-5-21-\d+-\d+-\d+-\d+\b/u)?.[0];
  assert.ok(sid);

  const existing = path.join(root, 'existing');
  await mkdir(existing);
  assert.equal(ownerSid(existing), 'S-1-5-32-544');
  const icacls = path.win32.join(process.env.SystemRoot, 'System32', 'icacls.exe');
  const secured = spawnSync(icacls, [existing, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/q'], { encoding: 'utf8', windowsHide: true });
  assert.equal(secured.status, 0, secured.stderr);
  await assert.rejects(ensurePrivateDirectory(existing), /Windows storage ACLs are not private/);
  assert.equal(ownerSid(existing), 'S-1-5-32-544');

  const home = path.join(root, 'home');
  await ensurePrivateDirectory(home);
  assert.equal(ownerSid(home), sid);
  await assertPrivatePath(home, true);
  const file = path.join(home, 'private.json');
  await createPrivateFile(file, '{}');
  assert.equal(ownerSid(file), sid);
  await assertPrivatePath(file, false);
});
