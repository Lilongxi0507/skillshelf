import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { createDiscoverySession, serveDiscovery } from '../packages/cli/dist/mcp/discovery.js';
import { inventory, digestManifest } from '../packages/cli/dist/validation.js';
import { emptyState, releaseKey } from '../packages/cli/dist/store/state.js';
import { importTree, chmodTree } from '../packages/cli/dist/store/local.js';
import { transact } from '../packages/cli/dist/transactions/transaction.js';
import { installSkills } from '../packages/cli/dist/manager.js';

async function fixture(context) {
  const root = await mkdtemp(join(process.env.SKILLSHELF_TEST_TMP || tmpdir(), 'skillshelf-discovery-'));
  context.after(async () => { await chmodTree(root, false); await rm(root, { recursive: true, force: true }); });
  const catalogPath = join(root, 'catalog.json');
  await writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, catalogVersion: '1.0.0', minCliVersion: '0.1.0-preview.1', scope: '@llx17669475', categories: [{ id: 'tools', title: 'Tools' }], collections: [], skills: [] }));
  return { root, ctx: { home: join(root, 'home'), offline: true, catalogPath } };
}

async function ready(ctx) {
  const session = createDiscoverySession(ctx);
  const response = await session({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } });
  assert.equal(response.result.protocolVersion, '2025-03-26');
  assert.equal(await session({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  return session;
}

test('MCP discovery exposes only readonly tools after the initialization handshake', async context => {
  const { ctx } = await fixture(context);
  const session = createDiscoverySession(ctx);
  assert.equal((await session({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).error.code, -32002);
  const active = await ready(ctx);
  const listed = await active({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['skillshelf_search', 'skillshelf_info', 'skillshelf_read', 'skillshelf_doctor']);
  assert.ok(listed.result.tools.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  assert.equal((await active({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'skillshelf_install', arguments: { id: 'taste' } } })).error.code, -32602);
  assert.equal((await active({ jsonrpc: '2.0', id: 4, method: 'shell/execute', params: { command: 'anything' } })).error.code, -32601);
  await assert.rejects(lstat(ctx.home), { code: 'ENOENT' });
});

test('MCP validates requests and tool arguments without creating local state', async context => {
  const { ctx } = await fixture(context);
  const session = await ready(ctx);
  for (const request of [[], null, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: {}, method: 'ping' }]) {
    assert.equal((await session(request)).error.code, -32600);
  }
  for (const args of [{ query: 'test', shell: true }, { query: 'x'.repeat(513) }, { query: '', limit: 501 }, { query: '', offset: -1 }]) {
    assert.equal((await session({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'skillshelf_search', arguments: args } })).error.code, -32602);
  }
  const result = await session({ jsonrpc: '2.0', id: 'search', method: 'tools/call', params: { name: 'skillshelf_search', arguments: { query: '' } } });
  assert.equal(result.result.isError, false);
  assert.equal(JSON.parse(result.result.content[0].text).total, 0);
  await assert.rejects(lstat(ctx.home), { code: 'ENOENT' });
});

test('MCP reads verified local content and rejects traversal without exposing host paths', async context => {
  const { root, ctx } = await fixture(context);
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), '---\nname: shared-example\ndescription: Discovery fixture\n---\n# Shared example\n');
  await writeFile(join(source, 'LICENSE'), 'MIT\n');
  await writeFile(join(source, 'large.txt'), '"\\'.repeat(400_000));
  const files = await inventory(source), contentDigest = digestManifest(files);
  const manifest = { schemaVersion: 1, id: 'shared-example', name: 'shared-example', files, contentDigest, runtime: { kind: 'instructions', requiresNetwork: false } };
  await importTree(ctx, source, manifest);
  const state = emptyState(), key = releaseKey('shared-example', '1.0.0', contentDigest);
  state.releases[key] = { key, id: 'shared-example', name: 'shared-example', version: '1.0.0', packageName: 'local:shared-example', integrity: '', contentDigest, manifest, source: {}, installedAt: new Date().toISOString(), origin: 'local' };
  state.selections['shared-example'] = { releaseKey: key, pinned: false, history: [] };
  await transact(ctx, emptyState(), state, []);
  const stateBefore = await readFile(join(ctx.home, 'state.json'), 'utf8');
  const session = await ready(ctx);
  const read = await session({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'skillshelf_read', arguments: { id: 'shared-example' } } });
  assert.equal(read.result.isError, false);
  assert.match(read.result.content[0].text, /Shared example/);
  assert.equal(read.result.content[0].text.includes(ctx.home), false);
  const escaped = await session({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'skillshelf_read', arguments: { id: 'shared-example', path: '../state.json' } } });
  assert.equal(escaped.result.isError, true);
  assert.equal(JSON.stringify(escaped).includes(ctx.home), false);
  const large = await session({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'skillshelf_read', arguments: { id: 'shared-example', path: 'large.txt' } } });
  assert.equal(large.error.code, -32001);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) + 1 <= 2 * 1024 * 1024);
  assert.equal(await readFile(join(ctx.home, 'state.json'), 'utf8'), stateBefore);
});

test('MCP stdio handles split UTF-8 frames and writes one JSON response per request', async context => {
  const { ctx } = await fixture(context);
  const input = new PassThrough(), output = new PassThrough();
  let wire = '';
  output.on('data', chunk => { wire += chunk.toString('utf8'); });
  const serving = serveDiscovery(ctx, { input, output });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: '中文客户端', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'skillshelf_search', arguments: { query: '前端' } } },
  ];
  const bytes = Buffer.from(requests.map(item => JSON.stringify(item)).join('\n') + '\n');
  for (let offset = 0; offset < bytes.length; offset += 7) input.write(bytes.subarray(offset, offset + 7));
  input.end();
  await serving;
  const responses = wire.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(responses.map(response => response.id), [1, 2]);
  assert.equal(responses[1].result.isError, false);
});

test('MCP stdio closes oversized frames and reports malformed JSON', async context => {
  const { ctx } = await fixture(context);
  for (const [data, expected] of [['{bad}\n', -32700], ['x'.repeat(1025), -32600]]) {
    const input = new PassThrough(), output = new PassThrough();
    let wire = '';
    output.on('data', chunk => { wire += chunk.toString(); });
    const serving = serveDiscovery(ctx, { input, output, maxMessageBytes: 1024 });
    input.end(data);
    await serving;
    assert.equal(JSON.parse(wire.trim()).error.code, expected);
  }
});

test('MCP installed false excludes actually installed packs from search results', { skip: !process.env.SKILLSHELF_TEST_CATALOG && 'Requires development catalog' }, async context => {
  const { ctx } = await fixture(context);
  ctx.catalogPath = process.env.SKILLSHELF_TEST_CATALOG;
  const catalog = JSON.parse(await readFile(ctx.catalogPath, 'utf8'));
  const entry = catalog.skills[0];
  await installSkills(ctx, [entry.id], { agents: [] });
  const session = await ready(ctx);
  const response = await session({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'skillshelf_search', arguments: { query: '', installed: false, limit: 100 } } });
  const found = JSON.parse(response.result.content[0].text);
  assert.equal(found.total, catalog.skills.length - 1);
  assert.ok(found.items.every(item => item.id !== entry.id && !item.installed));
});
