import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateHomeLocation } from '../packages/cli/dist/agents/storage-boundary.js';
import { resolveAgentTarget } from '../packages/cli/dist/agents/agents.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(process.env.SKILLSHELF_TEST_TMP ?? tmpdir(), 'skillshelf-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userHome = path.join(root, 'user'); await mkdir(userHome, { mode: 0o700 });
  return { root, userHome, options: { home: userHome, env: {} } };
}

test('boundary protects absent default roots in both directions without creating anything', async (t) => {
  const { userHome, options } = await fixture(t);
  const root = path.join(userHome, '.agents', 'skills');
  for (const home of [root, path.join(root, 'SkillShelf'), path.join(userHome, '.agents'), userHome]) {
    await assert.rejects(validateHomeLocation({ home }, [], options), /disjoint/);
  }
  assert.deepEqual(await readdir(userHome), []);
});

test('all seven native defaults are protected independent of detection', async (t) => {
  const { options } = await fixture(t);
  for (const agent of ['claude-code', 'codex', 'opencode', 'dsh', 'cursor', 'hermes', 'universal']) {
    const target = await resolveAgentTarget(agent, options);
    await assert.rejects(validateHomeLocation({ home: path.join(target.path, 'data') }, [], options), /disjoint/);
  }
});

test('separate private home and adjacent prefix paths are permitted with no writes', async (t) => {
  const { root, userHome, options } = await fixture(t);
  const safeHomes = [path.join(root, 'data', 'skillshelf'), path.join(userHome, '.local', 'share', 'skillshelf'), path.join(userHome, '.agents', 'skills-extra')];
  for (const home of safeHomes) await validateHomeLocation({ home }, [], options);
  assert.deepEqual(await readdir(root), ['user']); assert.deepEqual(await readdir(userHome), []);
});

test('active environment instance roots and standard fallback roots are both protected', async (t) => {
  const { root, userHome, options } = await fixture(t);
  const env = { DSH_HOME: path.join(root, 'instance'), DSH_AGENTS_HOME: path.join(root, 'compat'), HERMES_HOME: path.join(root, 'hermes-instance'), XDG_CONFIG_HOME: path.join(root, 'xdg') };
  for (const home of [path.join(env.DSH_HOME, 'skills', 'data'), path.join(env.DSH_AGENTS_HOME, 'skills', 'data'), path.join(env.HERMES_HOME, 'skills', 'data'), path.join(env.XDG_CONFIG_HOME, 'opencode', 'skills', 'data'), path.join(userHome, '.dsh', 'skills', 'data')]) {
    await assert.rejects(validateHomeLocation({ home }, [], { ...options, env }), /disjoint/);
  }
});

test('registered and proposed custom targets include actual path plus compatibility scan roots', async (t) => {
  const { root, options } = await fixture(t);
  const data = path.join(root, 'data');
  const custom = await resolveAgentTarget('custom', { ...options, path: path.join(data, 'nested', 'skills') });
  await assert.rejects(validateHomeLocation({ home: data }, [custom], options), /disjoint/);
  const safe = await resolveAgentTarget('custom', { ...options, path: path.join(root, 'safe-agent') });
  safe.scanRoots.push(path.join(data, 'compatibility'));
  await assert.rejects(validateHomeLocation({ home: data }, [safe], options), /disjoint/);
  safe.scanRoots = []; safe.path = path.join(data, 'nested');
  await assert.rejects(validateHomeLocation({ home: data }, [safe], options), /disjoint/);
});

test('unregistered project roots protect all native project scan locations', async (t) => {
  const { root, options } = await fixture(t); const project = path.join(root, 'project');
  await mkdir(project);
  for (const name of ['.agents', '.claude', '.opencode', '.dsh', '.cursor', '.hermes']) {
    await assert.rejects(validateHomeLocation({ home: path.join(project, name, 'skills', 'data') }, [], { ...options, projects: [project] }), /disjoint/);
  }
  await validateHomeLocation({ home: path.join(project, '.local-data', 'skillshelf') }, [], { ...options, projects: [project] });
  assert.deepEqual(await readdir(project), []);
});

test('registered target scopes imply native project roots without separate project arguments', async (t) => {
  const { root, options } = await fixture(t); const project = path.join(root, 'project'); await mkdir(project);
  const target = await resolveAgentTarget('custom', { ...options, project, path: path.join(project, 'custom') });
  await assert.rejects(validateHomeLocation({ home: path.join(project, '.agents', 'skills', 'data') }, [target], options), /disjoint/);
});

test('canonical existing ancestors catch aliases; broken/unknown roots fail closed', { skip: process.platform === 'win32' }, async (t) => {
  const { root, userHome, options } = await fixture(t);
  const actual = path.join(root, 'actual'); await mkdir(actual); await mkdir(path.join(userHome, '.agents'));
  await symlink(actual, path.join(userHome, '.agents', 'skills'));
  await assert.rejects(validateHomeLocation({ home: path.join(actual, 'data') }, [], options), /disjoint/);
  const alias = path.join(root, 'alias'); await symlink(actual, alias);
  await assert.rejects(validateHomeLocation({ home: path.join(alias, 'data') }, [], options), /disjoint/);
  const broken = path.join(root, 'broken'); await symlink(path.join(root, 'absent'), broken);
  await assert.rejects(validateHomeLocation({ home: path.join(root, 'safe') }, [{ path: broken, scope: 'global', scanRoots: [] }], options), /dangling/);
  const file = path.join(root, 'file'); await writeFile(file, 'user');
  await assert.rejects(validateHomeLocation({ home: file }, [], options), /non-directory/);
});

test('Windows overlap is case insensitive and component based (lexical fixtures only)', { skip: process.platform === 'win32' }, async () => {
  const options = { home: 'C:\\Users\\Alice', env: {}, platform: 'win32' };
  await assert.rejects(validateHomeLocation({ home: 'c:\\users\\ALICE\\.agents\\skills\\Data' }, [], options), /disjoint/);
  await assert.rejects(validateHomeLocation({ home: 'C:\\Users\\Alice\\.agents' }, [], options), /disjoint/);
  await validateHomeLocation({ home: 'D:\\SkillShelf' }, [], options);
  await validateHomeLocation({ home: 'C:\\Users\\Alice\\.agents\\skills-adjacent' }, [], options);
});
