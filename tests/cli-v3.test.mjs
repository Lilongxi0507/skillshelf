import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProgram } from '../packages/cli/dist/index.js';
import { installSkills } from '../packages/cli/dist/manager.js';
import { loadState } from '../packages/cli/dist/store/state.js';
import { CLI_VERSION } from '../packages/cli/dist/release.js';

// Task 7: new CLI surface (history/rollback --revision/sources check/migrate
// sources/mcp serve), stable JSON output, and the read-only MCP stdio server.

async function scratch(t) {
  const base = await realpath(process.env.SKILLSHELF_TEST_TMP || process.env.TMPDIR || os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'run-skillshelf-t7-'));
  const { chmodTree } = await import('../packages/cli/dist/store/local.js');
  t.after(async () => { try { await chmodTree(directory, false); } catch { /* best effort */ } await rm(directory, { recursive: true, force: true }); });
  return directory;
}
async function run(program, argv) {
  const output = [];
  const log = console.log;
  console.log = (value) => output.push(String(value));
  try {
    await program.parseAsync(argv, { from: 'node' });
  } finally { console.log = log; }
  return output.map(line => JSON.parse(line));
}

test('new commands appear in help and JSON output stays stable and redacted', async t => {
  const program = buildProgram();
  const help = program.helpInformation();
  for (const name of ['history', 'sources']) assert.ok(help.includes(name), 'help must mention ' + name);
  const rollback = program.commands.find(command => command.name() === 'rollback');
  assert.ok(rollback?.helpInformation().includes('--revision'), 'rollback help must mention --revision');
  for (const [group, leaf] of [['migrate', 'sources'], ['mcp', 'serve']]) {
    const parent = program.commands.find(command => command.name() === group);
    assert.ok(parent?.helpInformation().includes(leaf), `${group} help must mention ${leaf}`);
  }
  const home = await scratch(t);
  const rows = await run(buildProgram(), ['node', 'skillshelf', '--home', home, '--json', 'sources', 'check']);
  assert.equal(rows.length, 1);
  const data = rows[0].data;
  assert.equal(data.wrote, false);
  assert.equal(data.network, 'not-requested');
  assert.ok(Array.isArray(data.sources));
  // Nothing was written: no home side effects from a read-only command.
  await assert.rejects(run(buildProgram(), ['node', 'skillshelf', '--home', home, '--json', 'history', 'demo']), /未安装/u);
  // migrate sources without --yes is a preview; without installs it is empty.
  const migration = await run(buildProgram(), ['node', 'skillshelf', '--home', home, '--json', 'migrate', 'sources', '--dry-run']);
  assert.deepEqual(migration[0].data.migrations, []);
  assert.equal(migration[0].data.dryRun, true);
});
