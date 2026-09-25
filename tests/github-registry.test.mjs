import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { digestSourceMappings, digestSourceRelease, digestSourceTree, validateSourceManifest } from '../packages/cli/dist/registry/manifest.js';

// Optional import makes the initial RED an explicit missing-contract assertion,
// rather than a test runner/module-resolution error.
let api = {};
try { api = await import('../packages/cli/dist/registry/github.js'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const sha = (data, algorithm = 'sha256') => createHash(algorithm).update(data).digest('hex');
const commit = 'a'.repeat(40), repository = 'acme/tools', root = `tools-${commit}`;
const key = `${repository}@${commit}`;
const url = `https://codeload.github.com/${repository}/tar.gz/${commit}`;
const data = Buffer.from('complete skill\n'), executable = Buffer.from('#!/bin/sh\necho fixture\n');
const license = Buffer.from('MIT\n'), notice = Buffer.from('Notice\n');
const file = (path, bytes, mode = 100644, origin) => ({ path, size: bytes.length, sha256: sha(bytes), mode, ...(origin ? { origin } : {}) });
function rebuild(manifest) {
  manifest.treeDigest = digestSourceTree(manifest.files);
  manifest.acquisition.manifestDigest = digestSourceMappings(manifest.acquisition.mappings, manifest.acquisition.overlays);
  manifest.releaseDigest = digestSourceRelease(manifest);
  return manifest;
}
function manifest() {
  return rebuild({ schemaVersion: 3, id: 'demo', name: 'demo', packRevision: 1,
    acquisition: { kind: 'github', repository, commit, mappings: [{ sourcePath: 'Skills/demo', destinationPath: 'skills/demo' }], overlays: [
      { origin: 'license', repository, commit, sourcePath: 'LICENSE', destinationPath: 'skills/demo/LICENSE', ...file('unused', license) },
      { origin: 'authored', repository, commit, sourcePath: 'NOTICE', destinationPath: 'skills/demo/NOTICE', ...file('unused', notice) },
    ].map(({ path, ...overlay }) => overlay) },
    provenance: { repository, commit, license: 'MIT' },
    files: [file('skills/demo/SKILL.md', data), file('skills/demo/run.sh', executable, 100755), file('skills/demo/LICENSE', license, 100644, 'license'), file('skills/demo/NOTICE', notice, 100644, 'authored')],
    runtime: { kind: 'instructions', requiresNetwork: false },
  });
}
const entries = () => [
  { path: `${root}/`, type: 'Directory' },
  { path: `${root}/Skills/demo/`, type: 'Directory' },
  { path: `${root}/Skills/demo/SKILL.md`, data },
  { path: `${root}/Skills/demo/run.sh`, data: executable, mode: 0o755 },
  { path: `${root}/LICENSE`, data: license },
  { path: `${root}/NOTICE`, data: notice },
  { path: `${root}/unselected/blob`, data: Buffer.from('discarded') },
];
function checksum(block) { block.fill(32, 148, 156); const sum = block.reduce((a, b) => a + b, 0); block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii'); }
function record({ path, type = 'File', data = Buffer.alloc(0), mode = 0o644, mutate, ...extra }) {
  const header = Buffer.alloc(512); data = Buffer.from(data);
  new Header({ path, type, size: data.length, mode, uid: 0, gid: 0, mtime: new Date(0), ...extra }).encode(header);
  if (mutate) { mutate(header); checksum(header); }
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
const raw = (rows = entries(), end = Buffer.alloc(1024)) => Buffer.concat([...rows.map(record), end]);
const archive = (rows = entries(), options) => gzipSync(raw(rows), options);
function paxLine(key, value) {
  const payload = ` ${key}=${value}\n`; let size = Buffer.byteLength(payload) + 1;
  while (String(size).length + Buffer.byteLength(payload) !== size) size = String(size).length + Buffer.byteLength(payload);
  return `${size}${payload}`;
}
const pax = (fields, type = 'GlobalExtendedHeader') => ({ path: 'pax/metadata', type, data: fields.map(([k, v]) => paxLine(k, v)).join('') });
function stream(bytes, chunkSize = 17, hooks = {}) {
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const next = bytes.subarray(offset, offset + chunkSize); offset += next.length; hooks.chunk?.(offset); controller.enqueue(next);
  }, cancel() { hooks.cancel?.(); } });
}
function memoryCache() {
  const values = new Map(), stats = { stages: 0, publishes: 0, aborts: 0, discards: 0 };
  return { values, stats,
    async open(key) { const value = values.get(key); return value && { receipt: structuredClone(value.receipt), body: stream(value.bytes) }; },
    async discard(key) { stats.discards++; values.delete(key); },
    async stage(key) {
      stats.stages++; let chunks = [], closed = false;
      return {
        async write(chunk) { assert.equal(closed, false); chunks.push(Buffer.from(chunk)); },
        async seal() { closed = true; },
        async publish(receipt) { assert.equal(closed, true); values.set(key, { bytes: Buffer.concat(chunks), receipt: structuredClone(receipt) }); stats.publishes++; chunks = []; },
        async abort() { stats.aborts++; chunks = []; closed = true; },
      };
    },
  };
}
function deps(bytes = archive(), overrides = {}) {
  const cache = memoryCache(), requests = [];
  return { cache, requests, fetch: async (address, options) => {
    requests.push({ address, options }); return new Response(stream(bytes));
  }, ...overrides };
}
async function acquire(m = manifest(), d = deps(), signal) {
  assert.equal(typeof api.acquireGithubSource, 'function', 'Task2 must expose the verified GitHub acquisition seam');
  return api.acquireGithubSource({ manifest: m, signal }, d);
}
async function rejectArchive(bytes, pattern = /archive|tar|gzip|path|root|entry|PAX|link|selected|mapping|mode|size|collision|unsafe|padding|UTF|header|unsupported|limit|truncat/i, m = manifest()) {
  const d = deps(bytes); await assert.rejects(acquire(m, d), pattern); assert.equal(d.cache.stats.publishes, 0); return d;
}

test('verified selected directory, overlays, executable and exact identities use one fixed credential-free URL', async () => {
  const m = manifest(), before = structuredClone(m), bytes = archive(), d = deps(bytes);
  const result = await acquire(m, d);
  assert.deepEqual(m, before); assert.equal(result.repository, repository); assert.equal(result.commit, commit); assert.equal(result.root, root);
  assert.deepEqual(result.files.map(({ data, ...metadata }) => metadata), validateSourceManifest(m).files);
  assert.deepEqual(result.files.map(f => f.data), [license, notice, data, executable]);
  assert.equal(result.treeDigest, m.treeDigest); assert.equal(result.releaseDigest, m.releaseDigest);
  assert.deepEqual(result.archiveReceipt, { compressedSha512: sha(bytes, 'sha512'), compressedBytes: bytes.length });
  assert.equal(result.authorization, undefined);
  assert.equal(d.requests.length, 1); assert.equal(d.requests[0].address, url);
  assert.equal(d.requests[0].options.redirect, 'error'); assert.equal(d.requests[0].options.credentials, 'omit');
  assert.equal(new Headers(d.requests[0].options.headers).has('authorization'), false);
  assert.deepEqual([...d.cache.values.keys()], [key]); assert.equal(d.cache.stats.publishes, 1);
});

test('gzip recoding changes receipt, never selected tree or release identity', async () => {
  const a = await acquire(manifest(), deps(archive(undefined, { level: 1 })));
  const b = await acquire(manifest(), deps(archive(undefined, { level: 9 })));
  assert.equal(a.treeDigest, b.treeDigest); assert.equal(a.releaseDigest, b.releaseDigest);
  assert.notEqual(a.archiveReceipt.compressedSha512, b.archiveReceipt.compressedSha512);
});

test('cross-source overlays acquire each pinned tuple independently and preserve source namespace case rename', async () => {
  const m = manifest(), otherCommit = 'b'.repeat(40), other = 'legal/supplement';
  Object.assign(m.acquisition.overlays[1], { repository: other, commit: otherCommit }); rebuild(m);
  const seen = [], d = deps(undefined, { fetch: async address => { seen.push(address); return new Response(stream(address === url ? archive() : archive([{ path: 'supplement-root/NOTICE', data: notice }]))); } });
  const result = await acquire(m, d);
  assert.deepEqual(result.files.find(f => f.path.endsWith('/NOTICE')).data, notice);
  assert.equal(seen.length, 2); assert.ok(seen.includes(`https://codeload.github.com/${other}/tar.gz/${otherCommit}`));
  assert.equal(d.cache.values.size, 2); assert.equal(result.releaseDigest, m.releaseDigest);
});

test('untrusted manifest and unsafe identity are rejected before fetching or staging', async () => {
  for (const patch of [{ commit: 'main' }, { commit: 'v1' }, { commit: 'a'.repeat(7) }, { commit: 'A'.repeat(40) }, ...['https://github.com/acme/tools', 'user:pass@host/repo', 'acme/tools?x=1', 'acme/tools#ref', 'acme%2ftools/repo', 'acme/..', '../tools', 'acme/./tools', 'acme:443/tools', 'acme/tools\\x'].map(repository => ({ repository }))]) {
    const m = manifest(); Object.assign(m.acquisition, patch); rebuild(m); const d = deps();
    await assert.rejects(acquire(m, d)); assert.equal(d.requests.length, 0); assert.equal(d.cache.stats.stages, 0);
  }
  for (const mutate of [m => { m.acquisition.url = url; }, m => { m.files[0].sha256 = '0'.repeat(64); }, m => { m.acquisition.mappings[0].repository = 'other/repo'; m.acquisition.mappings[0].commit = commit; rebuild(m); }, m => { m.origin = 'github'; }]) {
    const m = manifest(); mutate(m); const d = deps(); await assert.rejects(acquire(m, d)); assert.equal(d.requests.length, 0);
  }
});

test('HTTP errors, redirect evidence, body absence and transport interruption never retry or fallback', async () => {
  for (const [status, code] of [[404, 'NOT_FOUND'], [403, 'FORBIDDEN'], [429, 'RATE_LIMIT'], [500, 'HTTP'], [301, 'REDIRECT']]) {
    let count = 0; const d = deps(undefined, { fetch: async () => { count++; return new Response(null, { status, headers: { 'retry-after': '120' } }); } });
    await assert.rejects(acquire(manifest(), d), e => e.code === code && (status !== 429 || e.retryAfter === '120'));
    assert.equal(count, 1); assert.equal(d.cache.stats.publishes, 0);
  }
  for (const response of [new Response(null), { ...{ status: 200, ok: true, headers: new Headers(), body: stream(archive()) }, redirected: true, url: 'https://evil.test' }]) {
    await assert.rejects(acquire(manifest(), deps(undefined, { fetch: async () => response })), /body|redirect/i);
  }
  const tls = new Error('fetch failed', { cause: Object.assign(new Error('certificate'), { code: 'CERT_HAS_EXPIRED' }) });
  await assert.rejects(acquire(manifest(), deps(undefined, { fetch: async () => { throw tls; } })), e => e.code === 'TLS');
  await assert.rejects(acquire(manifest(), deps(undefined, { fetch: async () => new Response(new ReadableStream({ start(c) { c.error(new Error('connection reset')); } })) })), e => e.code === 'INTERRUPTED');
});

test('raw unsafe paths and all namespace aliases fail before tar normalization', async () => {
  for (const path of ['/absolute', `${root}/../escape`, `${root}//empty`, `${root}/./dot`, `${root}/a\\b`, `${root}/CON.txt`, `${root}/.git/config`, `${root}/trailing.`, `${root}/trailing `, `${root}/bad\x01x`, `${root}/e\u0301`, `${root}/${Array(17).fill('d').join('/')}`, `${root}/．git/config`, `${root}/a／b`]) {
    await rejectArchive(archive([...entries(), { path }]));
  }
  for (const mutate of [h => { h[0] = 0xff; }, h => { h[4] = 0; h[5] = 65; }, h => { h.fill(120, 0, 100); }]) await rejectArchive(archive([...entries(), { path: `${root}/bad`, mutate }]));
  for (const extras of [
    [{ path: `${root}/unselected/Blob` }], [{ path: `${root}/Unselected/other` }],
    [{ path: `${root}/alias/K` }, { path: `${root}/alias/Ｋ` }],
    [{ path: `${root}/collision` }, { path: `${root}/collision/child` }],
    [{ path: `${root}/parent/child` }, { path: `${root}/parent` }],
    [{ path: `${root}/unselected/blob` }],
  ]) await rejectArchive(archive([...entries(), ...extras]));
});

test('requires exactly one nonempty root with explicit complete framing', async () => {
  for (const bytes of [archive([]), archive([{ path: `${root}/`, type: 'Directory' }]), archive([...entries(), { path: 'other/file' }]), archive([{ path: root }]),
    gzipSync(raw(entries(), Buffer.alloc(0))), gzipSync(raw(entries(), Buffer.alloc(512))), gzipSync(raw().subarray(0, -1)),
    gzipSync(Buffer.concat([raw(), Buffer.from('trailing')])), gzipSync(Buffer.concat([raw(), raw()])),
    Buffer.concat([archive(), archive()]), Buffer.concat([archive(), gzipSync(Buffer.alloc(0))]), Buffer.concat([archive(), Buffer.alloc(8)]),
    archive().subarray(0, -4), Buffer.from('not gzip'), gzipSync(Buffer.alloc(0)),
  ]) await rejectArchive(bytes);
  const badPadding = raw(); badPadding[3 * 512 + data.length] = 1; await rejectArchive(gzipSync(badPadding));
  const badChecksum = raw(); badChecksum[0] ^= 1; await rejectArchive(gzipSync(badChecksum));
  const truncatedBody = raw().subarray(0, 3 * 512 + 2); await rejectArchive(gzipSync(truncatedBody));
  const badCrc = archive(); badCrc[badCrc.length - 8] ^= 1; await rejectArchive(badCrc);
  await acquire(manifest(), deps(gzipSync(Buffer.concat([raw(), Buffer.alloc(1024)]))));
});

test('PAX harmless global/local metadata passes, effective fields and malformed records fail closed', async () => {
  await acquire(manifest(), deps(archive([pax([['comment', 'reviewed'], ['mtime', '0'], ['uid', '0'], ['gid', '0'], ['uname', 'git'], ['gname', 'git']]), ...entries()])));
  await acquire(manifest(), deps(archive([pax([['mtime', '123.5']], 'ExtendedHeader'), ...entries()])));
  for (const field of ['path', 'linkpath', 'type', 'size', 'mode', 'SCHILY.nlink', 'GNU.sparse.size', 'unknown']) {
    for (const type of ['ExtendedHeader', 'GlobalExtendedHeader']) await rejectArchive(archive([pax([[field, '1']], type), ...entries()]));
  }
  for (const content of ['9 uid=0\n', 'bogus\n', paxLine('uid', '0') + paxLine('uid', '0'), '11 uid=0\0\n', '', 'x'.repeat(65537)]) {
    await rejectArchive(archive([{ path: 'pax', type: 'ExtendedHeader', data: content }, ...entries()]));
  }
  await rejectArchive(archive([...entries(), pax([['mtime', '0']], 'ExtendedHeader')]));
  await rejectArchive(archive([pax([['uid', '0']], 'ExtendedHeader'), pax([['uid', '1']], 'ExtendedHeader'), ...entries()]));
});

test('selected links, link ancestors, special entries, gitlinks and LFS pointers are unsupported', async () => {
  for (const type of ['SymbolicLink', 'Link', 'CharacterDevice', 'BlockDevice', 'FIFO', 'ContiguousFile', 'GNUDumpDir', 'NextFileHasLongPath', 'SparseFile']) {
    const extra = { path: `${root}/Skills/demo/link`, type, linkpath: type.includes('Link') ? 'SKILL.md' : '' };
    await rejectArchive(archive([...entries(), extra]));
    if (type !== 'SymbolicLink') await rejectArchive(archive([...entries(), { ...extra, path: `${root}/unselected/special` }]));
  }
  for (const extra of [{ path: `${root}/Skills`, type: 'SymbolicLink', linkpath: 'other' },
    { path: `${root}/Skills/demo/submodule`, mode: 0o160000 }, { path: `${root}/Skills/demo/.gitmodules`, data: '[submodule "x"]' },
    { path: `${root}/Skills/demo/suid`, mode: 0o4755 }, { path: `${root}/unknown`, mutate: h => { h[156] = 90; } },
  ]) await rejectArchive(archive([...entries(), extra]));
  const m = manifest(), pointer = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 100\n');
  m.files.find(f => f.path.endsWith('SKILL.md')).size = pointer.length; m.files.find(f => f.path.endsWith('SKILL.md')).sha256 = sha(pointer); rebuild(m);
  await rejectArchive(archive(entries().map(e => e.data === data ? { ...e, data: pointer } : e)), /LFS|unsupported/i, m);
});

test('safe unselected UIUX and Matt symlinks are discarded without resolving target bytes', async () => {
  const result = await acquire(manifest(), deps(archive([...entries(),
    { path: `${root}/gallery/data/styles.csv`, type: 'SymbolicLink', linkpath: '../../src/ui-ux-pro-max/data/styles.csv' },
    { path: `${root}/AGENTS.md`, type: 'SymbolicLink', linkpath: 'CLAUDE.md' },
  ])));
  assert.equal(result.files.length, 4);
  for (const linkpath of ['../escape', '/absolute', 'C:\\evil', './dot', 'a//b', 'CON', 'bad\x01x']) await rejectArchive(archive([...entries(), { path: `${root}/link`, type: 'SymbolicLink', linkpath }]));
});

test('missing/extra/duplicate files, wrong ownership/boundary, byte/size/mode and overlay collision reject', async () => {
  for (const rows of [entries().filter(e => e.data !== data), [...entries(), { path: `${root}/Skills/demo/extra`, data: 'extra' }],
    entries().map(e => e.data === data ? { ...e, path: `${root}/Skills/demo-other/SKILL.md` } : e),
    [...entries(), { path: `${root}/Skills/demo/LICENSE`, data: license }], [...entries(), { path: `${root}/Skills/demo/SKILL.md`, data }],
    entries().map(e => e.data === data ? { ...e, data: Buffer.alloc(data.length, 65) } : e),
    entries().map(e => e.data === data ? { ...e, data: 'short' } : e),
    entries().map(e => e.data === executable ? { ...e, mode: 0o644 } : e),
    entries().map(e => e.data === notice ? { ...e, data: 'wrong' } : e),
  ]) await rejectArchive(archive(rows));
  for (const mutate of [m => { m.acquisition.mappings[0].sourcePath = 'LICENSE'; }, m => { m.files.push(file('unrelated/file', data)); }, m => { m.acquisition.mappings.push({ sourcePath: 'Skills/demo/nested', destinationPath: 'other' }); }]) {
    const m = manifest(); mutate(m); rebuild(m); await assert.rejects(acquire(m, deps()));
  }
});

test('stream counters enforce compressed/expanded/entry/selected budgets independently of Content-Length', async () => {
  for (const limits of [{ compressedBytes: 20 }, { expandedBytes: 512 }, { entries: 3 }, { selectedFiles: 3 }, { selectedFileBytes: data.length - 1 }, { selectedBytes: data.length + executable.length }]) {
    const d = deps(archive(), { limits }); await assert.rejects(acquire(manifest(), d), /limit/i); assert.equal(d.cache.stats.publishes, 0);
  }
  for (const length of ['1', '999999999999', 'garbage', '-1']) {
    const d = deps(undefined, { limits: { compressedBytes: 20 }, fetch: async () => new Response(stream(archive()), { headers: { 'content-length': length } }) });
    await assert.rejects(acquire(manifest(), d), /limit|length/i); assert.equal(d.cache.stats.publishes, 0);
  }
  const largeUnselected = archive([...entries(), { path: `${root}/discard`, data: Buffer.alloc(256 * 1024) }]);
  await assert.rejects(acquire(manifest(), deps(largeUnselected, { limits: { expandedBytes: 8192 } })), /expanded.*limit/i);
  await acquire(manifest(), deps(largeUnselected));
});

test('abort, total deadline and idle deadline cancel streams and never publish staging', async () => {
  for (const kind of ['abort', 'idle', 'total']) {
    const controller = new AbortController(); let cancelled = false, started;
    const ready = new Promise(resolve => { started = resolve; });
    const body = new ReadableStream({ start(c) { c.enqueue(archive().subarray(0, 20)); started(); }, cancel() { cancelled = true; } });
    const d = deps(undefined, { fetch: async () => new Response(body), limits: { idleMs: kind === 'idle' ? 15 : 500, requestMs: kind === 'total' ? 15 : 1000 } });
    const result = acquire(manifest(), d, controller.signal); await ready;
    if (kind === 'abort') controller.abort();
    await assert.rejects(result, e => e.code === (kind === 'abort' ? 'ABORTED' : 'TIMEOUT'));
    assert.equal(cancelled, true); assert.equal(d.cache.stats.publishes, 0); assert.equal(d.cache.stats.aborts, 1);
  }
  const controller = new AbortController(); controller.abort(); const d = deps(); await assert.rejects(acquire(manifest(), d, controller.signal), e => e.code === 'ABORTED'); assert.equal(d.requests.length, 0);
  const d2 = deps(undefined, { fetch: async () => new Promise(() => {}), limits: { requestMs: 15, idleMs: 100 } });
  await assert.rejects(acquire(manifest(), d2), e => e.code === 'TIMEOUT');
});

test('cache revalidates bytes/receipt, deduplicates concurrent requests and provides deterministic offline behavior', async () => {
  const d = deps(), m = manifest(); const [a, b] = await Promise.all([acquire(m, d), acquire(m, d)]);
  assert.equal(d.requests.length, 1); assert.equal(d.cache.stats.publishes, 1); assert.equal(a.releaseDigest, b.releaseDigest);
  a.files[0].data.fill(0); assert.deepEqual(b.files[0].data, license);
  const offline = { ...d, offline: true, fetch: async () => { throw new Error('offline must not fetch'); } };
  assert.deepEqual((await acquire(m, offline)).files[0].data, license);
  d.cache.values.get(key).receipt.compressedSha512 = '0'.repeat(128);
  await assert.rejects(acquire(m, offline), e => e.code === 'OFFLINE_MISS'); assert.equal(d.cache.values.size, 0);
  await acquire(m, d); assert.equal(d.requests.length, 2);
  d.cache.values.get(key).bytes = archive(entries().filter(e => e.data !== data));
  await acquire(m, d); assert.equal(d.requests.length, 3); assert.ok(d.cache.stats.discards >= 2);
  await assert.rejects(acquire(m, { ...deps(), offline: true }), e => e.code === 'OFFLINE_MISS');
});

test('cross-source failure publishes none of the staged tuples', async () => {
  const m = manifest(); Object.assign(m.acquisition.overlays[1], { repository: 'legal/missing', commit: 'b'.repeat(40) }); rebuild(m);
  const d = deps(undefined, { fetch: async address => address === url ? new Response(stream(archive())) : new Response(null, { status: 404 }) });
  await assert.rejects(acquire(m, d), e => e.code === 'NOT_FOUND'); assert.equal(d.cache.stats.publishes, 0); assert.equal(d.cache.values.size, 0);
});
