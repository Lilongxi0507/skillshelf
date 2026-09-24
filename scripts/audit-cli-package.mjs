import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicationMetadata, integrityFor, modules, readRegularFile } from './lib.mjs';

// Reviewed runtime modules, not a wildcard that would accept accidentally copied files.
// Adding a CLI source module intentionally requires reviewing this list.
const CLI_MODULES = Object.freeze([
  'agents/agents', 'agents/storage-boundary', 'catalog/catalog',
  'commands/maintenance', 'commands/portable', 'errors', 'index', 'manager',
  'registry/files', 'registry/http', 'registry/registry', 'registry/tar', 'release',
  'runtime/privacy', 'runtime/providers', 'runtime/runtime',
  'store/fs', 'store/local', 'store/projections', 'store/state',
  'transactions/core-guard', 'transactions/locks', 'transactions/operations', 'transactions/transaction',
  'tui/format', 'tui/ui', 'types', 'validation', 'core', 'mcp/discovery', 'mcp/manager',
  'agents/onboarding', 'authoring', 'profiles',
]);
export const CLI_ALLOWED_FILES = Object.freeze([
  'package/LICENSE', 'package/README.md', 'package/package.json', 'package/dist/catalog/bootstrap.json',
  ...CLI_MODULES.flatMap(name => ['package/dist/' + name + '.js', 'package/dist/' + name + '.d.ts']),
].sort());

/** Audit actual compressed CLI bytes without executing package code or lifecycle hooks. */
export async function auditCliArchive(bytes, { api, expectedCatalog } = {}) {
  api ??= await modules();
  const files = api.readTarball(bytes), names = files.map(file => file.path).sort();
  assert.deepEqual(names, CLI_ALLOWED_FILES, 'Unexpected/missing real CLI files; review the explicit allowlist');
  const get = filename => files.find(file => file.path === filename);
  for (const name of ['package/LICENSE', 'package/README.md']) assert.ok(get(name).data.length, 'Missing legal/user documentation');
  const metadata = api.parseJsonFile(get('package/package.json'));
  const metadataKeys = new Set(['name', 'version', 'description', 'type', 'license', 'engines', 'bin', 'exports', 'files', 'publishConfig', 'repository', 'homepage', 'bugs', 'dependencies']);
  assert.ok(Object.keys(metadata).every(key => metadataKeys.has(key)), 'Unreviewed CLI package metadata');
  assert.equal(metadata.name, `${api.ALLOWED_SCOPE}/skillshelf`);
  assert.equal(metadata.version, api.CLI_VERSION);
  assert.equal(metadata.type, 'module'); assert.equal(metadata.license, 'MIT');
  assert.deepEqual(metadata.bin, { skillshelf: 'dist/index.js' });
  assert.deepEqual(metadata.files, ['dist/', 'README.md', 'LICENSE']);
  assert.deepEqual(metadata.engines, { node: '>=22.20.0' });
  assertPublicationMetadata(metadata, api, { repositoryDirectory: 'packages/cli' });
  assert.deepEqual(Object.keys(metadata.dependencies ?? {}).sort(), ['@clack/prompts', 'commander', 'picocolors', 'tar', 'yaml', 'zod']);
  assert.ok(Object.values(metadata.dependencies).every(value => typeof value === 'string' && api.EXACT_VERSION.test(value)), 'Dependencies must have exact reviewed versions');
  const bootstrap = api.validatePublicCatalog(api.parseJsonFile(get('package/dist/catalog/bootstrap.json')));
  assert.ok(bootstrap.skills.length > 0); assert.equal(bootstrap.catalogVersion, metadata.version);
  assert.equal(bootstrap.scope, api.ALLOWED_SCOPE);
  assert.ok(bootstrap.skills.every(entry => entry.version === metadata.version));
  if (expectedCatalog) assert.equal(api.canonicalJson(bootstrap), api.canonicalJson(expectedCatalog), 'CLI bootstrap is stale; packSkills -> copyCatalog -> npmPackCLI -> prepare');
  const bin = get('package/dist/index.js');
  assert.ok(bin.data.toString('utf8').startsWith('#!/usr/bin/env node'));
  assert.equal(bin.executable, true, 'Actual npm CLI bin must be executable');
  assert.ok(files.every(file => file.path === bin.path || !file.executable), 'Only the CLI bin may be executable');
  return { name: metadata.name, version: metadata.version, integrity: integrityFor(bytes), files: files.length, bytes: files.reduce((sum, file) => sum + file.data.length, 0), bootstrapEntries: bootstrap.skills.length, skillBodiesIncluded: false, lifecycleHooks: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filename = process.argv[2];
  if (process.argv.length !== 3 || !filename || !path.isAbsolute(filename)) throw new Error('Usage: node scripts/audit-cli-package.mjs /absolute/cli.tgz');
  const result = await auditCliArchive(await readRegularFile(filename));
  console.log(JSON.stringify({ ok: true, filename, ...result }, null, 2));
}
