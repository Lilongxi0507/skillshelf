import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const workspace = fileURLToPath(new URL('..', import.meta.url));
const catalog = JSON.parse(await readFile(path.join(workspace, 'catalog', 'sources.json'), 'utf8'));
const definitions = catalog.skills.filter((entry) => entry.source === 'superpowers');
const snapshotRoot = path.join(workspace, 'skills');

async function filesUnder(directory) {
  const result = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `snapshot contains a link: ${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
      else assert.fail(`snapshot contains a special file: ${absolute}`);
    }
  }
  await visit(directory);
  return result;
}

test('catalog maps the complete pinned Superpowers collection', async () => {
  assert.equal(definitions.length, 15);
  assert.equal(new Set(definitions.map((entry) => entry.name)).size, 15);
  assert.equal(new Set(definitions.map((entry) => entry.snapshot)).size, 15);
  assert.equal(catalog.repositories.superpowers.commit, '5bf4e78011075bcfc0dc295f0724994cd123ee71');

  let originalFileCount = 0;
  for (const entry of definitions) {
    const skillRoot = path.join(snapshotRoot, entry.snapshot, 'skill');
    const files = await filesUnder(skillRoot);
    assert.ok(files.includes(path.join(skillRoot, 'SKILL.md')));
    assert.ok(files.includes(path.join(skillRoot, 'LICENSE')));
    originalFileCount += files.length - 1;
  }
  assert.equal(originalFileCount, 75);
});

test('installing the collection into one flat Agent root resolves local links', async (t) => {
  const temporary = await mkdtemp(path.join(process.env.SKILLSHELF_TEST_TMP || tmpdir(), 'skillshelf-superpowers-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));

  for (const entry of definitions) {
    await cp(path.join(snapshotRoot, entry.snapshot, 'skill'), path.join(temporary, entry.name), { recursive: true, errorOnExist: true });
  }

  for (const entry of definitions) {
    const skillRoot = path.join(temporary, entry.name);
    const files = await filesUnder(skillRoot);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const body = await readFile(file, 'utf8');
      const sourceDirectory = path.dirname(file);
      for (const match of body.matchAll(/\[[^\]]+\]\((\.\.?\/[^)]+)\)/gu)) {
        const target = path.resolve(sourceDirectory, match[1]);
        await assert.doesNotReject(stat(target), `${entry.name}: broken local link ${match[1]}`);
      }
    }
  }

  const names = new Set(definitions.map((entry) => entry.name));
  for (const entry of definitions) {
    const files = await filesUnder(path.join(temporary, entry.name));
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const body = await readFile(file, 'utf8');
      for (const match of body.matchAll(/superpowers:([a-z-]+)/gu)) {
        assert.equal(names.has(match[1]), true, `${entry.name}: missing referenced skill ${match[1]}`);
        await assert.doesNotReject(stat(path.join(temporary, match[1], 'SKILL.md')));
      }
    }
  }
});
