import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProgram } from '../packages/cli/dist/index.js';
import { loadState } from '../packages/cli/dist/store/state.js';
import { serveDiscovery } from '../packages/cli/dist/mcp/discovery.js';
import { CLI_VERSION } from '../packages/cli/dist/release.js';

// Task 7: the read-only MCP stdio server.

async function scratch(t) {
  const base = await realpath(process.env.SKILLSHELF_TEST_TMP || process.env.TMPDIR || os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'run-skillshelf-t7-'));
  const { chmodTree } = await import('../packages/cli/dist/store/local.js');
  t.after(async () => { try { await chmodTree(directory, false); } catch { /* best effort */ } await rm(directory, { recursive: true, force: true }); });
  return directory;
}

test('mcp serve speaks the read-only protocol over stdio and refuses mutation', async t => {
  const home = await scratch(t);
  const lines = [];
  const output = {
    write: (chunk, callback) => { lines.push(String(chunk)); if (typeof callback === 'function') callback(); return true; },
  };
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'skillshelf_search', arguments: { query: '' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'skillshelf_doctor', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'skillshelf_install', arguments: {} } },
    { jsonrpc: '2.0', id: 6, method: 'resources/write', params: {} },
  ];
  const input = (async function* () { for (const request of requests) yield Buffer.from(JSON.stringify(request) + '\n'); })();
  await serveDiscovery({ home, offline: true }, { input, output });
  const responses = lines.map(line => JSON.parse(line));
  const byId = new Map(responses.map(response => [response.id, response]));
  assert.equal(byId.get(1).result.serverInfo.version, CLI_VERSION);
  assert.ok(byId.get(1).result.instructions.includes('只读'));
  const tools = byId.get(2).result.tools.map(tool => tool.name).sort();
  assert.deepEqual(tools, ['skillshelf_doctor', 'skillshelf_info', 'skillshelf_read', 'skillshelf_search']);
  assert.ok(tools.every(name => name !== 'skillshelf_install'));
  assert.equal(byId.get(3).result.content[0].type, 'text');
  assert.ok(JSON.parse(byId.get(3).result.content[0].text).catalogVersion);
  assert.equal(JSON.parse(byId.get(4).result.content[0].text).ok, true);
  assert.equal(byId.get(5).error.code, -32602, 'unknown tools are rejected');
  assert.equal(byId.get(6).error.code, -32601, 'non-tool methods are rejected');
  // The session never wrote anything into the home.
  const state = await loadState({ home, offline: true });
  assert.equal(Object.keys(state.selections).length, 0);
});
