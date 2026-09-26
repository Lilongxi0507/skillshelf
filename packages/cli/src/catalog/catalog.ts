import { randomUUID } from 'node:crypto';
import { guardCatalog, forbidCoreRefresh } from '../transactions/core-guard.js';
import { lstat, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_VERSION, RELEASE_CHANNEL } from '../release.js';
import { ensurePrivateDirectory as ensurePrivateHome } from '../runtime/privacy.js';
import type { Catalog, CatalogEntry, Context, SourceManifest } from '../types.js';
import { ALLOWED_SCOPE, canonicalJson, EXACT_VERSION, LIMITS, validateCatalog, validatePublicCatalog } from '../validation.js';
import { readRegularFile } from '../registry/files.js';
import { validateSourceManifest } from '../registry/manifest.js';

import { validateStoredHomeLocation } from '../store/state.js';
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

/** Validate a schema-3 fixed-source catalog and bridge it into the internal
 * catalog shape. Every member's source manifest is deep-validated (Task 1
 * contract); the internal entry carries the self-contained identity plus a
 * deterministic non-SemVer display version encoding catalog and pack
 * revisions, so npm identity fields stay empty and nothing pretends a
 * GitHub release has an npm version. */
export function convertSourceCatalog(value: unknown): Catalog {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (row.schemaVersion !== 3 || row.scope !== ALLOWED_SCOPE) throw new Error('Untrusted source catalog schema or namespace');
  if (!Number.isSafeInteger(row.catalogRevision) || (row.catalogRevision as number) < 1) throw new Error('Source catalog revision must be a positive integer');
  const minimum = typeof row.minCliVersion === 'string' && EXACT_VERSION.test(row.minCliVersion) ? row.minCliVersion : '';
  if (!minimum) throw new Error('Source catalog requires an exact minCliVersion');
  const packs = Array.isArray(row.packs) ? row.packs as Array<Record<string, unknown>> : [];
  const members = Array.isArray(row.members) ? row.members as Array<Record<string, unknown>> : [];
  if (!packs.length || !members.length || members.length > 1000) throw new Error('Invalid source catalog lists');
  const packById = new Map<string, { id: string; packRevision: number; members: string[]; title: string; description: string }>();
  for (const pack of packs) {
    const id = typeof pack.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(pack.id) ? pack.id : '';
    if (!id || packById.has(id) || !Number.isSafeInteger(pack.packRevision) || (pack.packRevision as number) < 1 || !Array.isArray(pack.members)) throw new Error('Invalid source catalog pack');
    packById.set(id, { id, packRevision: pack.packRevision as number, members: pack.members as string[], title: typeof pack.title === 'string' && pack.title ? pack.title : id, description: typeof pack.description === 'string' && pack.description ? pack.description : id });
  }
  const skills: CatalogEntry[] = [];
  const categories: Catalog['categories'] = [];
  const seenCategories = new Set<string>();
  const seenMembers = new Set<string>();
  for (const member of members) {
    const name = typeof member.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(member.name) ? member.name : '';
    if (!name || seenMembers.has(name)) throw new Error('Invalid or duplicate source catalog member');
    seenMembers.add(name);
    const pack = typeof member.pack === 'string' ? packById.get(member.pack) : undefined;
    if (!pack) throw new Error('Source catalog member references an unknown pack: ' + name);
    let manifest: SourceManifest;
    try { manifest = validateSourceManifest(member.sourceManifest); } catch { throw new Error('Source catalog member manifest rejected: ' + name); }
    if (manifest.id !== name || manifest.name !== name) throw new Error('Source catalog member identity mismatch: ' + name);
    if (member.treeDigest !== manifest.treeDigest || member.releaseDigest !== manifest.releaseDigest) throw new Error('Source catalog member digest mismatch: ' + name);
    if (manifest.acquisition.kind !== 'github') throw new Error('Source catalog member is not a fixed GitHub acquisition: ' + name);
    const fileCount = manifest.files.length;
    const unpackedSize = manifest.files.reduce((sum, file) => sum + file.size, 0);
    if (member.fileCount !== fileCount || member.unpackedSize !== unpackedSize) throw new Error('Source catalog member inventory mismatch: ' + name);
    if (!Number.isSafeInteger(member.packRevision) || member.packRevision !== pack.packRevision) throw new Error('Source catalog member pack revision mismatch: ' + name);
    const curation = (field: string, max = 4096): string => {
      const value = member[field];
      if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('Invalid member ' + field + ': ' + name);
      return value;
    };
    const examples = Array.isArray(member.examples) ? member.examples.map(item => { if (typeof item !== 'string' || !item.trim() || item.length > 4096) throw new Error('Invalid member examples: ' + name); return item; }) : [];
    const tags = Array.isArray(member.tags) ? member.tags.map(item => { if (typeof item !== 'string' || !item.trim() || item.length > 120) throw new Error('Invalid member tags: ' + name); return item; }) : [];
    const category = curation('category', 80);
    if (!seenCategories.has(category)) { seenCategories.add(category); categories.push({ id: category, title: category }); }
    skills.push({
      id: name, name, title: curation('title', 200), description: curation('description'), useWhen: curation('useWhen'), examples, category, tags,
      collection: pack.id, license: curation('license', 200), source: { repository: manifest.acquisition.repository, commit: manifest.acquisition.commit },
      status: 'stable', runtime: manifest.runtime, packageName: `github:${name}`, version: `${minimum}+r${row.catalogRevision}p${pack.packRevision}`,
      integrity: '', contentDigest: manifest.releaseDigest, fileCount, unpackedSize,
      acquisition: manifest.acquisition, sourceManifest: manifest, packRevision: pack.packRevision,
    });
  }
  const collections: Catalog['collections'] = [...packById.values()].map(pack => ({
    id: pack.id, title: pack.title, description: pack.description,
    skills: [...pack.members].filter(id => seenMembers.has(id)),
  })).filter(collection => collection.skills.length);
  return { schemaVersion: 3, catalogVersion: minimum, minCliVersion: minimum, scope: ALLOWED_SCOPE, catalogRevision: String(row.catalogRevision), categories, collections, skills };
}

function normalizeLoadedCatalog(value: unknown, strictPublic: boolean): Catalog {
  if ((value && typeof value === 'object' ? (value as { schemaVersion?: unknown }).schemaVersion : undefined) === 3) return compatible(convertSourceCatalog(value));
  return compatible(strictPublic ? validatePublicCatalog(value) : validateCatalog(value));
}
function unpack(receipt: CatalogReceipt): Catalog {
  if (!receipt || receipt.packageName !== CATALOG_PACKAGE || !EXACT_VERSION.test(receipt.version) || typeof receipt.archive !== 'string' || receipt.archive.length > LIMITS.catalogBytes * 2) throw new Error('Invalid catalog receipt');
  const bytes = Buffer.from(receipt.archive, 'base64');
  if (bytes.toString('base64') !== receipt.archive) throw new Error('Invalid catalog artifact encoding');
  const files = readTarball(bytes, receipt.integrity);
  if (files.some(file => !['package/package.json', 'package/catalog.json', 'package/LICENSE', 'package/NOTICE', 'package/README.md'].includes(file.path))) throw new Error('Unexpected catalog package file (skill bodies forbidden)');
  validateDataPackage(parseJsonFile(files.find(file => file.path === 'package/package.json')), CATALOG_PACKAGE, receipt.version);
  if (!files.some(file => file.path === 'package/LICENSE')) throw new Error('Catalog package LICENSE required');
  const catalog = normalizeLoadedCatalog(parseJsonFile(files.find(file => file.path === 'package/catalog.json')), true);
  if (catalog.schemaVersion !== 3 && catalog.catalogVersion !== receipt.version) throw new Error('Catalog package/version mismatch');
  return catalog;
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
  if (ctx.catalogPath) return guardCatalog(normalizeLoadedCatalog(JSON.parse((await readRegularFile(path.resolve(ctx.catalogPath), LIMITS.catalogBytes)).toString('utf8')), false));
  const bootstrap = fileURLToPath(new URL('./bootstrap.json', import.meta.url));
  const packaged=compatible(validatePublicCatalog(JSON.parse((await readRegularFile(bootstrap, LIMITS.catalogBytes)).toString('utf8'))));
  const cached=await cacheFile(ctx);
  if(!cached)return guardCatalog(packaged);
  const previous=unpack(JSON.parse((await readRegularFile(cached,LIMITS.catalogBytes*3)).toString('utf8')) as CatalogReceipt);
  return guardCatalog(packaged.schemaVersion>previous.schemaVersion||compareVersion(packaged.catalogVersion,previous.catalogVersion)>0?packaged:previous);
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
  forbidCoreRefresh();
  if (ctx.offline) throw new Error('Cannot refresh the npm catalog in offline mode');
  if (ctx.catalogPath) return loadCatalog(ctx);
  await validateStoredHomeLocation(ctx);
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
  const synonyms = [['前端','frontend','web','网页'],['后端','backend','服务'],['测试','test','testing','tdd'],['调试','debug','debugging','故障'],['设计','design','界面','ui','ux'],['图片','image','图像'],['视频','video'],['搜索','search','检索'],['审查','review'],['架构','architecture','模块'],['安全','security','taint'],['计划','plan','planning'],['全栈','full-stack','端到端']];
  const expanded=terms.map(term=>synonyms.find(group=>group.includes(term))||[term]);
  const results:CatalogEntry[]=[];
  for (const entry of catalog.skills) {
    if (filters.category && entry.category !== filters.category && !entry.members?.some(member=>member.category===filters.category||member.subcategory===filters.category)) continue;
    if (filters.collection && !collection?.skills.includes(entry.id)) continue;
    if (installed && !installed.has(entry.id) && !installed.has(entry.name)) continue;
    const haystack = [entry.id, entry.name, entry.title, entry.description, entry.useWhen, ...entry.tags, ...entry.examples, entry.category, entry.collection].join('\n').normalize('NFKC').toLocaleLowerCase('en-US');
    const matchedMembers=(entry.members||[]).flatMap(member=>{if(filters.category&&member.category!==filters.category&&member.subcategory!==filters.category)return[];const fields={name:member.id,title:member.title,description:member.description,useWhen:member.useWhen,examples:member.examples.join(' '),tags:member.tags.join(' '),purpose:member.purpose,stack:member.stack.join(' '),dependencies:member.dependencies.join(' '),category:member.category+' '+member.subcategory};const normalized=Object.entries(fields).map(([field,text])=>[field,text.normalize('NFKC').toLocaleLowerCase('en-US')] as const);if(!expanded.every(group=>group.some(term=>normalized.some(([,text])=>text.includes(term)))))return[];return[{id:member.id,reasons:normalized.filter(([,text])=>!terms.length||expanded.some(group=>group.some(term=>text.includes(term)))).map(([field])=>field)}];});
    if (matchedMembers.length || expanded.every(group=>group.some(term=>haystack.includes(term)))) results.push({...entry,...(entry.members?{matchedMembers}:{})});
  }
  return results;
}
