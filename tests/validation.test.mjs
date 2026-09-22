import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { canonicalJson, digestManifest, inventory, safeRelativePath, validateManifest, validateSkillDocument, verifyTree, LIMITS } from '../packages/cli/dist/validation.js';

async function scratch(t) {
  const base = process.env.SKILLSHELF_TEST_TMP || os.tmpdir();
  const directory = await mkdtemp(path.join(base, 'run-skillshelf-validation-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
test('relative paths reject traversal, aliases, platform reserved and noncanonical names', () => {
  for (const value of ['', '/', '../a', 'a/../b', './a', 'a//b', 'a\\b', 'C:/a', 'CON.txt', 'nul', 'COM1', 'LPT².log', 'a.', 'a ', ' a', '.git/config', 'x\0y', 'a:*', 'a\u007fb', 'e\u0301.md', Array(17).fill('a').join('/')]) assert.throws(() => safeRelativePath(value), undefined, value);
  for (const value of ['SKILL.md', '.hidden/data.bin', '资源/模板.md', 'scripts/run.py']) assert.equal(safeRelativePath(value), value);
  assert.equal(LIMITS.archiveBytes, 20 * 1024 * 1024); assert.equal(LIMITS.files, 2000);
});
test('native SKILL document requires bounded UTF-8 YAML with exact name and nonempty description', () => {
  const valid = '---\nname: fixture\ndescription: |\n  完整的测试技能\n---\n# Body\n';
  validateSkillDocument(Buffer.from(valid), 'fixture');
  validateSkillDocument(Buffer.from(valid.replaceAll('\n','\r\n')), 'fixture');
  for (const body of ['# no metadata', valid.replace('name: fixture','name: other'), valid.replace('name: fixture','name: fixture\nname: fixture'), '---\nname: fixture\ndescription: ""\n---\n', '---\nname: &n fixture\ndescription: *n\n---\n', '---\n[broken\n---\n']) assert.throws(() => validateSkillDocument(Buffer.from(body), 'fixture'));
  assert.throws(() => validateSkillDocument(Buffer.from([0xff,0xfe]), 'fixture'), /UTF-8/);
  assert.throws(() => validateSkillDocument(Buffer.alloc(1024*1024+1), 'fixture'), /limit/);
});
test('JCS uses finite ECMAScript JSON numbers, UTF16 key order and exact array order', () => {
  assert.equal(canonicalJson({ z: 1, a: [3, { b: true, a: 'x' }], n: -0 }), '{"a":[3,{"a":"x","b":true}],"n":0,"z":1}');
  assert.equal(canonicalJson({ '\ufb33': 1, '😀': 2, '\r': 3 }), '{"\\r":3,"😀":2,"דּ":1}');
  for (const value of [NaN, Infinity, undefined, BigInt(1), new Date(), [undefined], Array(1), '\ud800']) assert.throws(() => canonicalJson(value));
  const loop = {}; loop.loop = loop; assert.throws(() => canonicalJson(loop));
  assert.throws(() => canonicalJson({ get secret() { throw new Error('accessor executed'); } }), /accessor/);
});
test('inventory preserves hidden/binary files and executable normalization across read-only store modes', async t => {
  const root = await scratch(t); await mkdir(path.join(root, '.hidden'));
  await writeFile(path.join(root, 'SKILL.md'), '---\nname: fixture\ndescription: Fixture\n---\nComplete.\n');
  await writeFile(path.join(root, 'LICENSE'), 'MIT fixture\n');
  await writeFile(path.join(root, '.hidden/data.bin'), Buffer.from([0, 255, 13, 10]));
  await writeFile(path.join(root, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const files = await inventory(root), manifest = validateManifest({ schemaVersion: 1, id: 'fixture', name: 'fixture', files, contentDigest: digestManifest(files), runtime: { kind: 'instructions', requiresNetwork: false } });
  assert.equal(files.length, 4); assert.equal(digestManifest([...files].reverse()), manifest.contentDigest);
  await chmod(path.join(root, 'run.sh'), 0o555); await verifyTree(root, manifest);
  await writeFile(path.join(root, 'extra.txt'), 'unexpected'); await assert.rejects(verifyTree(root, manifest));
});
test('tree inventory rejects symlink, hard link and case-colliding directories', async t => {
  const root = await scratch(t); await writeFile(path.join(root, 'SKILL.md'), 'body');
  const linked = path.join(root, 'link'); await symlink('SKILL.md', linked); await assert.rejects(inventory(root), /Links/); await rm(linked);
  await link(path.join(root, 'SKILL.md'), linked); await assert.rejects(inventory(root), /Hard link/); await rm(linked);
  if (process.platform !== 'win32') { await mkdir(path.join(root, 'Data')); await mkdir(path.join(root, 'data')); await writeFile(path.join(root, 'Data/a'), 'a'); await writeFile(path.join(root, 'data/b'), 'b'); await assert.rejects(inventory(root), /Case-colliding/); }
});
