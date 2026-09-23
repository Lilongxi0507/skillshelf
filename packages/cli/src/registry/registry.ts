import { createHash } from 'node:crypto';
import { link, lstat, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CatalogEntry, Context, SkillManifest } from '../types.js';
import { loadCatalog } from '../catalog/catalog.js';
import { loadState } from '../store/state.js';
import { validateHomeLocation } from '../agents/storage-boundary.js';
import { ensurePrivateDirectory as ensurePrivateHome } from '../runtime/privacy.js';
import { chmodTree } from '../store/local.js';
import { ALLOWED_SCOPE, canonicalJson, LIMITS, validateCatalog, validateManifest, verifyTree } from '../validation.js';
import { localArtifactPath, readRegularFile } from './files.js';
import { fetchRegistryBytes, resolveNpmRelease } from './http.js';
import { extractVerifiedSkill, verifySkillArchive } from './tar.js';
export { assertIntegrity, extractVerifiedSkill, readTarball, verifySkillArchive } from './tar.js';

async function exists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause; }
}
async function checkStore(object: string, expected: SkillManifest): Promise<void> {
  const info = await lstat(object);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Content store object must be a real directory');
  const names = (await readdir(object)).sort();
  if (canonicalJson(names) !== '["manifest.json","skill"]') throw new Error('Unexpected content store object files');
  const manifest = validateManifest(JSON.parse((await readRegularFile(path.join(object, 'manifest.json'), LIMITS.catalogBytes)).toString('utf8')));
  if (canonicalJson(manifest) !== canonicalJson(expected)) throw new Error('Store manifest does not match verified artifact');
  await verifyTree(path.join(object, 'skill'), manifest);
}
/** Never installs npm packages, resolves dependencies or executes package code. */
export async function acquireSkill(ctx: Context, entry: CatalogEntry): Promise<{ manifest: SkillManifest; directory: string; artifact: string }> {
  const catalog = await loadCatalog(ctx), trusted = catalog.skills.find(item => item.id === entry.id);
  if (!trusted || canonicalJson(trusted) !== canonicalJson(entry)) throw new Error('Skill release is not in the validated selected catalog');
  return acquireVerifiedEntry(ctx, trusted);
}
/** Explicit lock trust boundary: caller must validate/confirm the user-owned project lock.
 * Old exact releases remain obtainable without trusting a changed latest catalog.
 * Local paths are NEVER inherited from a lock; only the explicit active fixture can grant one.
 */
export async function acquireLockedSkill(ctx: Context, entry: CatalogEntry): Promise<{ manifest: SkillManifest; directory: string; artifact: string }> {
  const normalized = validateCatalog({ schemaVersion: 1, catalogVersion: '0.1.0-preview.2', minCliVersion: '0.1.0-preview.2', scope: ALLOWED_SCOPE, categories: [{ id: entry.category, title: entry.category }], collections: [{ id: entry.collection, title: entry.collection, description: 'Explicit project lock', skills: [entry.id] }], skills: [entry] }).skills[0]!;
  if (normalized.localArtifact !== undefined && !ctx.catalogPath) throw new Error('Project locks cannot authorize local artifacts');
  if (ctx.catalogPath) {
    const catalog = await loadCatalog(ctx), fixture = catalog.skills.find(item => item.id === entry.id);
    const { localArtifact: lockedPath, ...publicEntry } = normalized;
    const { localArtifact: fixturePath, ...publicFixture } = fixture ?? {};
    if (fixture && canonicalJson(publicFixture) === canonicalJson(publicEntry)) {
      if (lockedPath !== undefined && lockedPath !== fixturePath) throw new Error('Locked local artifact differs from explicit fixture');
      return acquireVerifiedEntry(ctx, fixture);
    }
    if (lockedPath !== undefined) throw new Error('Locked local artifact is not authorized by the explicit development catalog');
  }
  return acquireVerifiedEntry(ctx, normalized);
}
async function acquireVerifiedEntry(ctx: Context, entry: CatalogEntry): Promise<{ manifest: SkillManifest; directory: string; artifact: string }> {
  await validateHomeLocation(ctx,Object.values((await loadState(ctx)).targets));
  const home = path.resolve(ctx.home), store = path.join(home, 'store'), artifacts = path.join(home, 'artifacts');
  const object = path.join(store, entry.contentDigest);
  const artifact = path.join(artifacts, `${entry.contentDigest}-${createHash('sha256').update(entry.integrity).digest('hex').slice(0, 16)}.tgz`);
  // Check every existing parent for links before reading or creating managed data.
  await ensurePrivateHome(home);
  await ensurePrivateHome(store); await ensurePrivateHome(artifacts);
  let bytes: Buffer;
  if (await exists(artifact)) {
    bytes = await readRegularFile(artifact, LIMITS.archiveBytes);
  } else if (entry.localArtifact !== undefined) {
    if (!ctx.catalogPath) throw new Error('Local artifacts require an explicit development catalog');
    bytes = await readRegularFile(await localArtifactPath(ctx.catalogPath, entry.localArtifact), LIMITS.archiveBytes);
  } else {
    if (ctx.offline) throw new Error('Offline artifact unavailable; fetch this exact release online first');
    const release = await resolveNpmRelease(entry.packageName, entry.version);
    if (release.integrity !== entry.integrity) throw new Error('npm SRI differs from pinned catalog');
    bytes = await fetchRegistryBytes(release.tarball, LIMITS.archiveBytes);
  }
  // Includes exact file list, every byte and mode, package identity and runtime.
  const verified = verifySkillArchive(bytes, entry);
  if (!(await exists(artifact))) {
    const temporary = path.join(artifacts, `.download-${randomUUID()}.tgz`);
    let raced = false;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o444 });
      // Atomic no-replace publication; the temporary hard link exists only during
      // this operation and is removed before any verification/use of final bytes.
      try { await link(temporary, artifact); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; raced = true; }
    } finally { await rm(temporary, { force: true }); }
    if (raced) verifySkillArchive(await readRegularFile(artifact, LIMITS.archiveBytes), entry);
  }
  if (await exists(object)) {
    await checkStore(object, verified.manifest);
    return { manifest: verified.manifest, directory: path.join(object, 'skill'), artifact };
  }
  const staging = await mkdtemp(path.join(store, '.staging-'));
  try {
    await extractVerifiedSkill(bytes, entry, path.join(staging, 'skill'));
    await writeFile(path.join(staging, 'manifest.json'), canonicalJson(verified.manifest) + '\n', { flag: 'wx', mode: 0o444 });
    await verifyTree(path.join(staging, 'skill'), verified.manifest);
    await chmodTree(staging, true);
    try { await rename(staging, object); }
    catch (cause) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause;
      await checkStore(object, verified.manifest);
    }
  } finally {
    if (await exists(staging)) { await chmodTree(staging, false); await rm(staging, { recursive: true }); }
  }
  return { manifest: verified.manifest, directory: path.join(object, 'skill'), artifact };
}
