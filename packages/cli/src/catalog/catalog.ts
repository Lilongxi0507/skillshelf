import { randomUUID } from 'node:crypto';
import { lstat, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_VERSION, RELEASE_CHANNEL } from '../release.js';
import { ensurePrivateDirectory as ensurePrivateHome } from '../runtime/privacy.js';
import type { Catalog, CatalogEntry, Context } from '../types.js';
import { canonicalJson, EXACT_VERSION, LIMITS, validateCatalog, validatePublicCatalog } from '../validation.js';
import { readRegularFile } from '../registry/files.js';
import { loadState } from '../store/state.js';
import { validateHomeLocation } from '../agents/storage-boundary.js';
import { CATALOG_PACKAGE, fetchRegistryBytes, resolveNpmRelease } from '../registry/http.js';
import { parseJsonFile, readTarball, validateDataPackage } from '../registry/tar.js';

interface CatalogReceipt { packageName: string; version: string; integrity: string; archive: string }
const cliVersion = CLI_VERSION;
function compareVersion(a: string, b: string): number {
  const split = (value: string) => { const [core, ...pre] = value.split('+')[0]!.split('-'); return { core: core!.split('.').map(Number), pre: pre.join('-').split('.').filter(Boolean) }; };
  const left = split(a), right = split(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i]! < right.core[i]! ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i]; if (x === y) continue; if (x === undefined) return -1; if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
function compatible(catalog: Catalog): Catalog {
  if (!EXACT_VERSION.test(cliVersion) || compareVersion(cliVersion, catalog.minCliVersion) < 0) throw new Error(`Catalog requires SkillShelf CLI ${catalog.minCliVersion} or newer`);
  return catalog;
}
function unpack(receipt: CatalogReceipt): Catalog {
  if (!receipt || receipt.packageName !== CATALOG_PACKAGE || !EXACT_VERSION.test(receipt.version) || typeof receipt.archive !== 'string' || receipt.archive.length > LIMITS.catalogBytes * 2) throw new Error('Invalid catalog receipt');
  const bytes = Buffer.from(receipt.archive, 'base64');
  if (bytes.toString('base64') !== receipt.archive) throw new Error('Invalid catalog artifact encoding');
  const files = readTarball(bytes, receipt.integrity);
  if (files.some(file => !['package/package.json', 'package/catalog.json', 'package/LICENSE', 'package/NOTICE', 'package/README.md'].includes(file.path))) throw new Error('Unexpected catalog package file (skill bodies forbidden)');
  validateDataPackage(parseJsonFile(files.find(file => file.path === 'package/package.json')), CATALOG_PACKAGE, receipt.version);
  if (!files.some(file => file.path === 'package/LICENSE')) throw new Error('Catalog package LICENSE required');
  const catalog = validatePublicCatalog(parseJsonFile(files.find(file => file.path === 'package/catalog.json')));
  if (catalog.catalogVersion !== receipt.version) throw new Error('Catalog package/version mismatch');
  return compatible(catalog);
}
async function cacheFile(ctx: Context): Promise<string | undefined> {
  const directory = path.join(path.resolve(ctx.home), 'catalogs'), filename = path.join(directory, 'cache.json');
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Catalog cache directory is not a real directory');
    await lstat(filename); return filename;
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause; }
}
export async function loadCatalog(ctx: Context): Promise<Catalog> {
  if (ctx.catalogPath) return compatible(validateCatalog(JSON.parse((await readRegularFile(path.resolve(ctx.catalogPath), LIMITS.catalogBytes)).toString('utf8'))));
  const cached = await cacheFile(ctx);
  if (cached) return unpack(JSON.parse((await readRegularFile(cached, LIMITS.catalogBytes * 3)).toString('utf8')) as CatalogReceipt);
  // Build copies only metadata here, never skill bodies or localArtifact paths.
  const bootstrap = fileURLToPath(new URL('./bootstrap.json', import.meta.url));
  return compatible(validatePublicCatalog(JSON.parse((await readRegularFile(bootstrap, LIMITS.catalogBytes)).toString('utf8'))));
}
async function downloadCatalog(): Promise<{ catalog: Catalog; receipt: CatalogReceipt }> {
  const release = await resolveNpmRelease(CATALOG_PACKAGE, RELEASE_CHANNEL, true);
  const bytes = await fetchRegistryBytes(release.tarball, LIMITS.catalogBytes);
  const receipt = { packageName: release.name, version: release.version, integrity: release.integrity, archive: bytes.toString('base64') };
  return { catalog: unpack(receipt), receipt };
}
/** For check: no cache, home, temp, state, or other filesystem writes. */
export async function fetchLatestCatalog(ctx: Context): Promise<Catalog> {
  if (ctx.offline || ctx.catalogPath) return loadCatalog(ctx);
  return (await downloadCatalog()).catalog;
}
export async function refreshCatalog(ctx: Context): Promise<Catalog> {
  if (ctx.offline) throw new Error('Cannot refresh the npm catalog in offline mode');
  if (ctx.catalogPath) return loadCatalog(ctx);
  await validateHomeLocation(ctx,Object.values((await loadState(ctx)).targets));
  const { catalog, receipt } = await downloadCatalog();
  const directory = path.join(path.resolve(ctx.home), 'catalogs');
  await ensurePrivateHome(path.resolve(ctx.home));
  await ensurePrivateHome(directory);
  const temporary = path.join(directory, `.cache-${randomUUID()}.json`);
  try {
    await writeFile(temporary, canonicalJson(receipt) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path.join(directory, 'cache.json'));
  } finally { await rm(temporary, { force: true }); }
  return catalog;
}
export function searchCatalog(catalog: Catalog, query = '', filters: { category?: string; collection?: string; installed?: string[] } = {}): CatalogEntry[] {
  const terms = query.normalize('NFKC').toLocaleLowerCase('en-US').trim().split(/\s+/u).filter(Boolean);
  const installed = filters.installed ? new Set(filters.installed) : undefined;
  const collection = filters.collection ? catalog.collections.find(item => item.id === filters.collection) : undefined;
  return catalog.skills.filter(entry => {
    if (filters.category && entry.category !== filters.category) return false;
    if (filters.collection && !collection?.skills.includes(entry.id)) return false;
    if (installed && !installed.has(entry.id) && !installed.has(entry.name)) return false;
    const haystack = [entry.id, entry.name, entry.title, entry.description, entry.useWhen, ...entry.tags, ...entry.examples, entry.category, entry.collection].join('\n').normalize('NFKC').toLocaleLowerCase('en-US');
    return terms.every(term => haystack.includes(term));
  });
}
