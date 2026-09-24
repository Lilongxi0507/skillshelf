import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkills } from '../packages/cli/dist/manager.js';
import { getRelease, loadState } from '../packages/cli/dist/store/state.js';
import { chmodTree } from '../packages/cli/dist/store/local.js';
import { runSkill, verifyExecutionRelease } from '../packages/cli/dist/runtime/runtime.js';
import { prepareExecution } from '../packages/cli/dist/core.js';

const catalogPath = process.env.SKILLSHELF_TEST_CATALOG;
const catalog = catalogPath ? JSON.parse(await readFile(catalogPath, 'utf8')) : undefined;
const enabled = catalog?.schemaVersion === 2;
async function fixture(context, id) {
  const root = await mkdtemp(join(process.env.SKILLSHELF_TEST_TMP || tmpdir(), 'skillshelf-pack-runtime-'));
  context.after(async () => { await chmodTree(root, false); await rm(root, { recursive: true, force: true }); });
  const ctx = { home: join(root, 'home'), offline: true, catalogPath };
  await installSkills(ctx, [id], { agents: [] });
  return { root, ctx, release: await getRelease(await loadState(ctx), id) };
}

test('real first-party pack archives retain their approved member-relative execution entrypoints', { skip: !enabled && 'Requires schema2 development pack catalog' }, async context => {
  for (const id of ['skillshelf-web-search', 'skillshelf-media-generation']) {
    const { root, ctx, release } = await fixture(context, id);
    const directory = await verifyExecutionRelease(ctx, release);
    const member = release.manifest.members[0];
    assert.equal(release.manifest.runtime.entrypoint, member.path + '/scripts/run.py');
    assert.match(await readFile(join(directory, release.manifest.runtime.entrypoint), 'utf8'), /argparse/);
    const prepared = await prepareExecution({ ...ctx, offline: false }, id, { kind: 'podman-rootless', isolationVerified: true, runId: 'pack-fixture', signal: new AbortController().signal, deadlineMs: Date.now() + 30_000, outputDirectory: join(root, 'sandbox-output') });
    assert.equal(prepared.entrypoint, release.manifest.runtime.entrypoint);
    for (const modify of [
      changed => { changed.origin = 'local'; },
      changed => { changed.manifest.members[0].id = 'foreign-tool'; },
      changed => { changed.manifest.runtime.entrypoint = member.path + '/other.py'; },
      changed => { changed.manifest.members.push({ ...member, id: 'extra', name: 'extra', path: 'extra' }); },
    ]) {
      const changed = structuredClone(release);
      modify(changed);
      await assert.rejects(verifyExecutionRelease(ctx, changed));
    }
  }
});

test('schema2 run launches the verified nested entrypoint while offline help needs no provider', { skip: !enabled ? 'Requires schema2 development pack catalog' : process.platform === 'win32' ? 'POSIX controlled interpreter fixture' : false }, async context => {
  const { root, ctx, release } = await fixture(context, 'skillshelf-web-search');
  const interpreter = join(root, 'fixture-interpreter');
  await writeFile(interpreter, '#!' + process.execPath + '\nif(process.argv.includes("-c")){process.stdout.write("3.12.0");}else{process.stdout.write(JSON.stringify({argv:process.argv.slice(2)}));}\n', { mode: 0o700 });
  const previous = process.env.SKILLSHELF_PYTHON;
  process.env.SKILLSHELF_PYTHON = interpreter;
  context.after(() => { if (previous === undefined) delete process.env.SKILLSHELF_PYTHON; else process.env.SKILLSHELF_PYTHON = previous; });
  const output = await runSkill(ctx, release, ['--help'], { capture: true, project: root });
  assert.equal(output.exitCode, 0);
  const invocation = JSON.parse(output.stdout).argv;
  assert.ok(invocation.includes(join(ctx.home, 'store', release.contentDigest, 'skill', release.manifest.runtime.entrypoint)));
  assert.equal(invocation.at(-1), '--help');
});
