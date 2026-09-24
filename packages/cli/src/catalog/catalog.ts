import { randomUUID } from 'node:crypto';
import { guardCatalog, forbidCoreRefresh } from '../transactions/core-guard.js';
import { lstat, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_VERSION, RELEASE_CHANNEL } from '../release.js';
import { ensurePrivateDirectory as ensurePrivateHome } from '../runtime/privacy.js';
import type { Catalog, CatalogEntry, Context } from '../types.js';
import { canonicalJson, EXACT_VERSION, LIMITS, validateCatalog, validatePublicCatalog } from '../validation.js';
import { readRegularFile } from '../registry/files.js';
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
  if (ctx.catalogPath) return guardCatalog(compatible(validateCatalog(JSON.parse((await readRegularFile(path.resolve(ctx.catalogPath), LIMITS.catalogBytes)).toString('utf8')))));
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
