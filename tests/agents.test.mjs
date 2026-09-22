import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, lstat, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { agentHints, canonicalAgentPath, detectAgents, expandAgentPath, resolveAgentTarget } from '../packages/cli/dist/agents/agents.js';

async function fixture(t) {
  // CI sets SKILLSHELF_TEST_TMP to a private fixture root; no real Agent home is used.
  const root = await mkdtemp(path.join(process.env.SKILLSHELF_TEST_TMP ?? tmpdir(), 'skillshelf-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  await mkdir(home); await mkdir(project);
  return { root, home, project, env: {} };
}

test('resolution is read-only, absence is unverified, detect creates nothing', async (t) => {
  const options = await fixture(t);
  const target = await resolveAgentTarget('codex', options);
  assert.equal(target.path, path.join(options.project, '.agents', 'skills'));
  assert.equal(target.scope, options.project);
  assert.equal(target.discovery, 'unverified');
  // Explicit global resolution is independent of the fixture project.
  assert.equal((await resolveAgentTarget('codex', { home: options.home, env: {} })).scope, 'global');
  assert.deepEqual(await detectAgents({ home: options.home, env: {} }), []);
  assert.deepEqual(await readdir(options.home), []);
  assert.deepEqual(await readdir(options.project), []);
});

test('all native global adapters and current Codex root', async (t) => {
  const { home } = await fixture(t);
  const suffixes = {
    'claude-code': ['.claude', 'skills'], codex: ['.agents', 'skills'],
    opencode: ['.config', 'opencode', 'skills'], dsh: ['.dsh', 'skills'],
    cursor: ['.cursor', 'skills'], hermes: ['.hermes', 'skills'], universal: ['.agents', 'skills'],
  };
  for (const [agent, suffix] of Object.entries(suffixes)) {
    const target = await resolveAgentTarget(agent, { home, env: {} });
    assert.equal(target.path, path.join(home, ...suffix));
    assert.equal(target.scope, 'global');
    assert.equal(target.agent, agent);
    assert.equal(target.mode, 'auto');
  }
  const codex = await resolveAgentTarget('codex', { home, env: { CODEX_HOME: path.join(home, 'old-codex') } });
  assert.equal(codex.path, path.join(home, '.agents', 'skills'));
  assert.ok(codex.scanRoots.includes(path.join(home, 'old-codex', 'skills')));
});

test('all project adapters use canonical absolute scope and trust hints', async (t) => {
  const { home, project } = await fixture(t);
  const roots = { 'claude-code': '.claude', codex: '.agents', opencode: '.opencode', dsh: '.dsh', cursor: '.cursor', hermes: '.hermes', universal: '.agents' };
  for (const [agent, directory] of Object.entries(roots)) {
    const target = await resolveAgentTarget(agent, { home, project, env: {} });
    assert.equal(target.path, path.join(project, directory, 'skills'));
    assert.equal(target.scope, project);
  }
  const hermes = await resolveAgentTarget('hermes', { home, project, env: {} });
  assert.match(agentHints(hermes).join('\n'), /explicit project trust/);
  await assert.rejects(resolveAgentTarget('codex', { home, project: '.', env: {} }), /absolute/);
});

test('environment roots and explicit secondary DSH instances take precedence', async (t) => {
  const { home, root } = await fixture(t);
  const env = {
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), XDG_CONFIG_HOME: path.join(root, 'xdg'),
    DSH_HOME: path.join(root, 'dsh'), DSH_AGENTS_HOME: path.join(root, 'shared'), HERMES_HOME: path.join(root, 'hermes'),
  };
  assert.equal((await resolveAgentTarget('claude-code', { home, env })).path, path.join(root, 'claude', 'skills'));
  assert.equal((await resolveAgentTarget('opencode', { home, env })).path, path.join(root, 'xdg', 'opencode', 'skills'));
  const automatic = await resolveAgentTarget('dsh', { home, env });
  assert.equal(automatic.path, path.join(root, 'dsh', 'skills'));
  assert.ok(automatic.scanRoots.includes(path.join(root, 'shared', 'skills')));
  const explicit = await resolveAgentTarget('dsh', { home, env, path: path.join(root, 'another-dsh', 'skills'), label: 'Work' });
  assert.equal(explicit.path, path.join(root, 'another-dsh', 'skills'));
  assert.notEqual(explicit.id, automatic.id);
  assert.equal((await resolveAgentTarget('hermes', { home, env })).path, path.join(root, 'hermes', 'skills'));
  const override = await resolveAgentTarget('opencode', { home, env: { ...env, OPENCODE_CONFIG_DIR: path.join(root, 'open-work') } });
  assert.equal(override.path, path.join(root, 'open-work', 'skills'));
});

test('IDs are stable across labels, modes and realpath spellings but distinguish scope/agent/instances', async (t) => {
  const { root, home, project } = await fixture(t);
  const actual = path.join(root, 'actual'); await mkdir(actual);
  const alias = path.join(root, 'alias');
  try { await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Host has no junction privilege'); return; } throw error; }
  const first = await resolveAgentTarget('dsh', { home, env: {}, path: path.join(alias, 'skills'), label: 'One' });
  const second = await resolveAgentTarget('dsh', { home, env: {}, path: path.join(actual, 'skills'), label: 'Two', mode: 'copy' });
  assert.equal(first.path, path.join(actual, 'skills')); assert.equal(first.id, second.id);
  await mkdir(first.path);
  assert.equal((await resolveAgentTarget('dsh', { home, env: {}, path: first.path })).discovery, 'unverified');
  const inProject = await resolveAgentTarget('dsh', { home, project, env: {}, path: first.path });
  const otherAgent = await resolveAgentTarget('custom', { home, env: {}, path: first.path });
  assert.notEqual(first.id, inProject.id); assert.notEqual(first.id, otherAgent.id);
});

test('detect returns only existing native roots and never writes config', async (t) => {
  const { home } = await fixture(t);
  await mkdir(path.join(home, '.claude'));
  await mkdir(path.join(home, '.dsh', 'skills'), { recursive: true });
  const targets = await detectAgents({ home, env: {} });
  assert.deepEqual(targets.map((target) => target.agent), ['claude-code', 'dsh']);
  assert.equal(targets[0].discovery, 'unverified');
  assert.equal(targets[1].discovery, 'unverified');
  assert.deepEqual(await readdir(path.join(home, '.claude')), []);
});

test('unknown file collisions and dangling links fail closed', async (t) => {
  const { home, root } = await fixture(t);
  const conflict = path.join(root, 'file'); await writeFile(conflict, 'user content');
  await assert.rejects(resolveAgentTarget('custom', { home, env: {}, path: conflict }), /non-directory/);
  await assert.rejects(resolveAgentTarget('custom', { home, env: {}, path: path.join(conflict, 'child') }));
  const dangling = path.join(root, 'dangling');
  try { await symlink(path.join(root, 'absent'), dangling, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; }
  await assert.rejects(canonicalAgentPath(path.join(dangling, 'skills')), /dangling/);
  assert.equal((await lstat(conflict)).isFile(), true);
});

test('custom requires absolute path; invalid adapter/mode and missing variables refuse', async (t) => {
  const { home } = await fixture(t);
  await assert.rejects(resolveAgentTarget('custom', { home, env: {} }), /explicit/);
  await assert.rejects(resolveAgentTarget('custom', { home, env: {}, path: 'relative' }), /absolute/);
  await assert.rejects(resolveAgentTarget('__proto__', { home, env: {} }), /Unknown/);
  await assert.rejects(resolveAgentTarget('codex', { home, env: {}, mode: 'overwrite' }), /mode/);
  await assert.rejects(resolveAgentTarget('custom', { home, env: {}, path: '$MISSING/skills' }), /Missing/);
  assert.equal(expandAgentPath('~/skills', home, {}, process.platform), path.join(home, 'skills'));
  assert.equal(expandAgentPath('${ROOT}/skills', home, { ROOT: home }, process.platform), home + '/skills');
  assert.throws(() => expandAgentPath('~someone/skills', home, {}, process.platform), /Named-user/);
});

test('compatibility scan roots are hints and are deduplicated', async (t) => {
  const { home, root } = await fixture(t);
  const dsh = await resolveAgentTarget('dsh', { home, env: { DSH_HOME: path.join(root, 'shared'), DSH_AGENTS_HOME: path.join(root, 'shared') } });
  assert.equal(dsh.scanRoots.length, 1);
  const cursor = await resolveAgentTarget('cursor', { home, env: {} });
  assert.ok(cursor.scanRoots.includes(path.join(home, '.cursor', 'skills')));
  assert.ok(cursor.scanRoots.includes(path.join(home, '.claude', 'skills')));
  assert.ok(cursor.scanRoots.includes(path.join(home, '.agents', 'skills')));
  assert.match(agentHints(cursor).join('\n'), /Overlapping roots/);
});

test('Windows lexical paths, case-insensitive IDs and environment expansion (not a real-host test)', async () => {
  const options = { home: 'C:\\Users\\Alice', env: {}, platform: 'win32' };
  const codex = await resolveAgentTarget('codex', options);
  assert.equal(codex.path, 'C:\\Users\\Alice\\.agents\\skills');
  const target = await resolveAgentTarget('dsh', { ...options, env: { DSH_HOME: 'D:\\dsh-one' }, path: '%ROOT%\\skills', ...( { env: { ROOT: 'E:\\work', DSH_HOME: 'D:\\dsh-one' } } ) });
  assert.equal(target.path, 'E:\\work\\skills');
  const lower = await resolveAgentTarget('dsh', { ...options, path: 'e:\\WORK\\skills' });
  assert.equal(lower.id, target.id);
  assert.equal((await resolveAgentTarget('codex', { ...options, project: 'D:\\project' })).scope, 'D:\\project');
  assert.equal(target.discovery, process.platform === 'win32' ? target.discovery : 'unverified');
});

test('Windows rejects drive-relative, device, ADS and reserved paths', async () => {
  for (const value of ['C:skills', '\\skills', '\\\\?\\C:\\skills', 'C:\\data\\NUL', 'C:\\data\\file:stream', 'C:\\data\\trailing.']) {
    await assert.rejects(resolveAgentTarget('custom', { home: 'C:\\Users\\Alice', env: {}, platform: 'win32', path: value }));
  }
});
