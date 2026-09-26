// Unified acquisition dispatcher: the GitHub branch of the verified store seam.
// A trusted entry's `sourceManifest` is the self-contained identity — the
// adapter deep-validates it on every acquisition — and the materialized tree
// enters the content-addressed store as a legacy-compatible single-skill
// object (schema-1 manifest, SKILL.md at the tree root) plus a source receipt
// that records the pack-relative destination root. No source fallback ever
// happens, and `origin: github` alone grants nothing.

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArchiveReceipt, CatalogEntry, Context, SkillManifest, SourceManifest } from '../types.js';
import { validateStoredHomeLocation } from '../store/state.js';
import { ensurePrivateDirectory as ensurePrivateHome } from '../runtime/privacy.js';
import { chmodTree } from '../store/local.js';
import { canonicalJson, digestManifest, LIMITS, validateManifest, verifyTree } from '../validation.js';
import { readRegularFile } from './files.js';
import { acquireGithubSource } from './github.js';

export interface GithubSourceReceipt {
  repository: string;
  commit: string;
  root: string;
  destinationPath: string;
  archiveReceipt: ArchiveReceipt;
  treeDigest: string;
  releaseDigest: string;
}

export interface GithubAcquisitionResult {
  manifest: SkillManifest;
  directory: string;
  artifact: string;
  origin: 'github';
  receipt: GithubSourceReceipt;
}

async function exists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause; }
}

/** The reviewed member root: a single mapping is its own root; multi-mapping
 * members share the common prefix one segment above the shallowest mapping
 * destination. Every selected file must live below this root. */
export function memberRootFor(mappings: ReadonlyArray<{ destinationPath: string }>): string {
  if (mappings.length === 1) return mappings[0]!.destinationPath;
  const shallowest = Math.min(...mappings.map((mapping) => mapping.destinationPath.split('/').length));
  const first = [...mappings].sort((a, b) => a.destinationPath.length - b.destinationPath.length)[0]?.destinationPath ?? '';
  return first.split('/').slice(0, shallowest - 1).join('/');
}

/** Deterministic legacy-compatible store manifest: the member's verified tree
 * relative to its member root, so `SKILL.md` sits at the tree root and the
 * existing validate/verify/projection machinery keeps working unchanged. */
export function storeManifestFor(source: SourceManifest): { manifest: SkillManifest; memberRoot: string } {
  if (source.acquisition.kind !== 'github') throw new Error('GitHub store manifest requires a github source manifest');
  const memberRoot = memberRootFor(source.acquisition.mappings);
  if (!memberRoot) throw new Error('GitHub source manifest has no member root');
  const files = source.files.map((file) => {
    if (file.path !== memberRoot && !file.path.startsWith(memberRoot + '/')) throw new Error(`Selected file escapes the member root: ${file.path}`);
    return { path: file.path.slice(memberRoot.length + 1), size: file.size, sha256: file.sha256, executable: file.mode === 100755 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest: SkillManifest = { schemaVersion: 1, id: source.id, name: source.name, files, runtime: source.runtime, contentDigest: '' };
  manifest.contentDigest = digestManifest(manifest.files);
  return { manifest, memberRoot };
}

type GithubDiskCache = ReturnType<typeof createGithubDiskCache>;
const cacheByBase = new Map<string, GithubDiskCache>();

/** Private disk cache under `home/cache/github/<sha256(key)>`. The instance is
 * memoized per base directory so concurrent acquisitions share the adapter's
 * per-cache single-flight; the key is recorded inside the receipt so a moved
 * or renamed cache directory cannot masquerade as another source. */
function githubDiskCache(base: string): GithubDiskCache {
  const cached = cacheByBase.get(base);
  if (cached) return cached;
  const created = createGithubDiskCache(base);
  cacheByBase.set(base, created);
  return created;
}

function createGithubDiskCache(base: string) {
  const directoryFor = (key: string) => path.join(base, createHash('sha256').update(key).digest('hex'));
  return {
    archivePath(key: string) { return path.join(directoryFor(key), 'archive.tgz'); },
    async open(key: string) {
      try {
        const receipt = JSON.parse((await readRegularFile(path.join(directoryFor(key), 'receipt.json'), LIMITS.catalogBytes)).toString('utf8')) as { key?: unknown; receipt?: ArchiveReceipt };
        if (receipt?.key !== key || !receipt.receipt?.compressedSha512 || typeof receipt.receipt.compressedBytes !== 'number') throw new Error('GitHub cache receipt does not match the requested source');
        const bytes = await readRegularFile(path.join(directoryFor(key), 'archive.tgz'), LIMITS.tarBytes);
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } });
        return { receipt: receipt.receipt, body };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async discard(key: string) {
      await rm(directoryFor(key), { recursive: true, force: true });
    },
    async stage(key: string) {
      await ensurePrivateHome(base);
      const staging = path.join(base, `.staging-${randomUUID()}`);
      await mkdir(staging, { mode: 0o700 });
      const archiveFile = path.join(staging, 'archive.tgz');
      const handle = await open(archiveFile, 'wx', 0o600);
      let sealed = false;
      return {
        async write(chunk: Uint8Array) { if (sealed) throw new Error('GitHub cache staging already sealed'); await handle.writeFile(chunk); },
        async seal() { sealed = true; await handle.close(); },
        async publish(receipt: ArchiveReceipt) {
          if (!sealed) { await handle.close(); throw new Error('GitHub cache staging was not sealed'); }
          await writeFile(path.join(staging, 'receipt.json'), canonicalJson({ key, receipt }) + '\n', { flag: 'wx', mode: 0o400 });
          try { await rename(staging, directoryFor(key)); }
          catch (cause) {
            const code = (cause as NodeJS.ErrnoException).code;
            if (code === 'EEXIST' || code === 'ENOTEMPTY') { await rm(staging, { recursive: true, force: true }); return; }
            throw cause;
          }
        },
        async abort() {
          sealed = true;
          await handle.close().catch(() => {});
          await rm(staging, { recursive: true, force: true });
        },
      };
    },
  };
}

async function transportFetch(address: string, options: { redirect: 'error'; credentials: 'omit'; signal: AbortSignal; headers: Record<string, string> }) {
  return fetch(address, options);
}

async function checkGithubStore(object: string, expected: SkillManifest, source: SourceManifest): Promise<GithubSourceReceipt> {
  if (source.acquisition.kind !== 'github') throw new Error('GitHub store check requires a github source manifest');
  const info = await lstat(object);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Content store object must be a real directory');
  const names = (await readdir(object)).sort();
  if (canonicalJson(names) !== canonicalJson(['manifest.json', 'skill', 'source-receipt.json'])) throw new Error('Unexpected GitHub content store object files');
  const manifest = validateManifest(JSON.parse((await readRegularFile(path.join(object, 'manifest.json'), LIMITS.catalogBytes)).toString('utf8')));
  if (canonicalJson(manifest) !== canonicalJson(expected)) throw new Error('Store manifest does not match the verified GitHub artifact');
  const receipt = JSON.parse((await readRegularFile(path.join(object, 'source-receipt.json'), LIMITS.catalogBytes)).toString('utf8')) as GithubSourceReceipt;
  if (receipt.repository !== source.acquisition.repository || receipt.commit !== source.acquisition.commit || receipt.treeDigest !== source.treeDigest || receipt.releaseDigest !== source.releaseDigest) {
    throw new Error('Store source receipt does not match the trusted source manifest');
  }
  await verifyTree(path.join(object, 'skill'), expected);
  return receipt;
}

/** Acquire a trusted GitHub entry into the verified content store. */
export async function acquireGithubEntry(ctx: Context, entry: CatalogEntry): Promise<GithubAcquisitionResult> {
  const source = entry.sourceManifest;
  if (!source || source.acquisition.kind !== 'github') throw new Error('GitHub acquisition requires a reviewed github source manifest');
  await validateStoredHomeLocation(ctx);
  const home = path.resolve(ctx.home);
  const store = path.join(home, 'store');
  await ensurePrivateHome(home);
  await ensurePrivateHome(store);
  const { manifest: expected, memberRoot } = storeManifestFor(source);
  const object = path.join(store, source.releaseDigest);
  const cacheBase = path.join(home, 'cache', 'github');
  const cache = githubDiskCache(cacheBase);
  const cacheKey = `${source.acquisition.repository}@${source.acquisition.commit}`;
  const artifact = cache.archivePath(cacheKey);
  if (await exists(object)) {
    const storedReceipt = await checkGithubStore(object, expected, source);
    return { manifest: expected, directory: path.join(object, 'skill'), artifact, origin: 'github', receipt: storedReceipt };
  }
  const acquired = await acquireGithubSource({ manifest: source }, { fetch: transportFetch, cache, offline: ctx.offline });
  const receipt: GithubSourceReceipt = {
    repository: acquired.repository,
    commit: acquired.commit,
    root: acquired.root,
    destinationPath: memberRoot,
    archiveReceipt: acquired.archiveReceipt,
    treeDigest: acquired.treeDigest,
    releaseDigest: acquired.releaseDigest,
  };
  if (await exists(object)) {
    const storedReceipt = await checkGithubStore(object, expected, source);
    return { manifest: expected, directory: path.join(object, 'skill'), artifact, origin: 'github', receipt: storedReceipt };
  }
  const staging = await mkdtemp(path.join(store, '.staging-'));
  try {
    await mkdir(path.join(staging, 'skill'), { mode: 0o700 });
    for (const file of acquired.files) {
      if (file.path !== memberRoot && !file.path.startsWith(memberRoot + '/')) throw new Error(`Acquired file escapes the member root: ${file.path}`);
      const relative = file.path.slice(memberRoot.length + 1);
      const destination = path.join(staging, 'skill', relative);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.data, { flag: 'wx', mode: file.mode === 100755 ? 0o755 : 0o644 });
    }
    await writeFile(path.join(staging, 'manifest.json'), canonicalJson(expected) + '\n', { flag: 'wx', mode: 0o444 });
    await writeFile(path.join(staging, 'source-receipt.json'), canonicalJson(receipt) + '\n', { flag: 'wx', mode: 0o444 });
    // Second verification of the materialized tree before atomic publication.
    await verifyTree(path.join(staging, 'skill'), expected);
    await chmodTree(staging, true);
    try { await rename(staging, object); }
    catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw cause;
      const storedReceipt = await checkGithubStore(object, expected, source);
      return { manifest: expected, directory: path.join(object, 'skill'), artifact, origin: 'github', receipt: storedReceipt };
    }
  } finally {
    if (await exists(staging)) { await chmodTree(staging, false); await rm(staging, { recursive: true, force: true }); }
  }
  return { manifest: expected, directory: path.join(object, 'skill'), artifact, origin: 'github', receipt };
}
