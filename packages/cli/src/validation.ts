import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Catalog, CatalogEntry, FileEntry, RuntimeDeclaration, SkillManifest, PackMember } from './types.js';
import { parseDocument } from 'yaml';
import { NPM_SCOPE } from './release.js';

export const LIMITS = Object.freeze({ files: 2000, fileBytes: 16 * 1024 * 1024, unpackedBytes: 64 * 1024 * 1024, archiveBytes: 20 * 1024 * 1024, tarBytes: 80 * 1024 * 1024, catalogBytes: 4 * 1024 * 1024 });
export const ALLOWED_SCOPE = NPM_SCOPE;
export const EXACT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX = /^[a-f0-9]{64}$/;
const fail = (message: string): never => { throw new Error(message); };
function unicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('Invalid Unicode surrogate');
    } else if (code >= 0xdc00 && code <= 0xdfff) fail('Invalid Unicode surrogate');
  }
}
export function safeRelativePath(value: string): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || value !== value.normalize('NFC') || /[\\\x00-\x1f\x7f<>:"|?*]/u.test(value)) fail('Unsafe relative path');
  unicode(value);
  const parts = value.split('/');
  if (parts.length > 16 || parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || /[. ]$|^ /u.test(part) || Buffer.byteLength(part) > 240 || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part))) fail('Unsafe or platform-reserved path');
  return value;
}
/** RFC 8785 / JCS: JSON primitive serialization and UTF-16 object-key order. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  function visit(item: unknown): string {
    if (item === null) return 'null';
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'string') { unicode(item); return JSON.stringify(item); }
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('Non-finite JSON number'); return JSON.stringify(item); }
    if (typeof item !== 'object') return fail('Value is not JSON data');
    if (active.has(item)) fail('Cyclic JSON data');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail('Non-JSON object');
    if (Object.getOwnPropertySymbols(item).length) fail('Symbol keys are not JSON');
    active.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) fail('Sparse or extended JSON array');
      result = '[' + Array.from({ length: item.length }, (_, index) => visit(Object.getOwnPropertyDescriptor(item, String(index))?.value)).join(',') + ']';
    } else {
      result = '{' + Object.keys(item).sort().map(key => {
        unicode(key);
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in descriptor)) fail('JSON accessors are forbidden');
        return JSON.stringify(key) + ':' + visit(descriptor.value);
      }).join(',') + '}';
    }
    active.delete(item);
    return result;
  }
  return visit(value);
}
function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail(`Invalid ${label}`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !keys.includes(key))) fail(`Unknown ${label} field`);
  return object;
}
function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(`Invalid ${label}`);
  unicode(value as string); return value as string;
}
function integer(value: unknown, maximum: number, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`Invalid ${label}`);
  return value as number;
}
function name(value: unknown): string { const result = text(value, 'name', 80); if (!NAME.test(result)) fail('Invalid name'); return result; }
function digest(value: unknown): string { const result = text(value, 'SHA-256', 64); if (!HEX.test(result)) fail('Invalid SHA-256'); return result; }
function strings(value: unknown, label: string): string[] { if (!Array.isArray(value) || value.length > 128) fail(`Invalid ${label}`); return (value as unknown[]).map(item => text(item, label)); }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') fail('Expected boolean'); return value as boolean; }
export function validateIntegrity(value: unknown): string {
  const result = text(value, 'integrity', 100);
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(result) || Buffer.from(result.slice(7), 'base64').toString('base64') !== result.slice(7)) fail('A single canonical SHA-512 SRI is required');
  return result;
}
export function validateRuntime(value: unknown): RuntimeDeclaration {
  const row = record(value, ['kind', 'entrypoint', 'minimumVersion', 'requiresNetwork', 'providers', 'dependencies'], 'runtime');
  if (!['instructions', 'python', 'node'].includes(String(row.kind))) fail('Unsupported runtime');
  const result: RuntimeDeclaration = { kind: row.kind as RuntimeDeclaration['kind'], requiresNetwork: bool(row.requiresNetwork) };
  if (row.entrypoint !== undefined) result.entrypoint = safeRelativePath(text(row.entrypoint, 'entrypoint'));
  if (result.kind === 'instructions' && result.entrypoint !== undefined) fail('Instructions cannot declare an entrypoint');
  if (result.kind !== 'instructions' && !result.entrypoint) fail('Runtime entrypoint required');
  if (row.minimumVersion !== undefined) { result.minimumVersion = text(row.minimumVersion, 'minimum version', 40); if (!/^\d+\.\d+(?:\.\d+)?$/.test(result.minimumVersion)) fail('Invalid runtime version'); }
  if (row.providers !== undefined) { const values = strings(row.providers, 'providers'); if (values.some(item => !['search', 'image', 'video'].includes(item)) || new Set(values).size !== values.length) fail('Invalid providers'); result.providers = values as NonNullable<RuntimeDeclaration['providers']>; }
  if (row.dependencies !== undefined) result.dependencies = strings(row.dependencies, 'dependencies');
  return result;
}
function validateFiles(value: unknown): FileEntry[] {
  if (!Array.isArray(value) || !value.length || value.length > LIMITS.files) fail('Invalid file inventory size');
  const seen = new Set<string>(); let total = 0;
  const files = (value as unknown[]).map(item => {
    const row = record(item, ['path', 'size', 'sha256', 'executable'], 'file');
    const file = { path: safeRelativePath(text(row.path, 'file path')), size: integer(row.size, LIMITS.fileBytes, 'file size'), sha256: digest(row.sha256), executable: bool(row.executable) };
    const folded = file.path.toLowerCase();
    if (seen.has(folded)) fail('Duplicate or case-colliding file'); seen.add(folded);
    total += file.size; if (total > LIMITS.unpackedBytes) fail('Unpacked size limit exceeded');
    return file;
  });
  const spellings = new Map<string, string>();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/'), folded = prefix.toLowerCase(), previous = spellings.get(folded);
      if (previous !== undefined && previous !== prefix) fail('Case-colliding directory spelling');
      spellings.set(folded, prefix);
      if (depth < parts.length && seen.has(folded)) fail('File/directory collision');
    }
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function digestManifest(files: FileEntry[]): string {
  return createHash('sha256').update(canonicalJson(validateFiles(files))).digest('hex');
}
export function digestPackManifest(manifest: Pick<SkillManifest,'schemaVersion'|'id'|'name'|'files'|'runtime'|'members'>): string {
  if (manifest.schemaVersion !== 2) return digestManifest(manifest.files);
  return createHash('sha256').update(canonicalJson({schemaVersion:2,id:manifest.id,name:manifest.name,files:validateFiles(manifest.files),runtime:manifest.runtime,members:validateMembers(manifest.members)})).digest('hex');
}
export function validateMembers(value: unknown): PackMember[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) fail('Pack requires members');
  const members = (value as unknown[]).map(value => {
    const row = record(value, ['id', 'name', 'path', 'legacyId', 'title', 'description', 'useWhen', 'examples', 'category', 'subcategory', 'tags', 'purpose', 'stack', 'dependencies', 'license', 'source', 'runtime'], 'pack member');
    const source = record(row.source, ['repository', 'commit', 'path', 'panelRevision', 'url'], 'source');
    for (const field of Object.keys(source)) text(source[field], 'source field');
    if (source.path !== undefined) safeRelativePath(String(source.path));
    if (source.repository !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(source.repository))) fail('Invalid source repository');
    if (source.commit !== undefined && !/^[a-f0-9]{40}$/.test(String(source.commit))) fail('Source commit must be pinned');
    if (source.url !== undefined) { const url=new URL(String(source.url));if(url.protocol!=='https:'||url.username||url.password)fail('Invalid source URL'); }
    const member: PackMember = { id: name(row.id), name: name(row.name), legacyId: name(row.legacyId), path: safeRelativePath(text(row.path, 'member path')), title: text(row.title, 'title'), description: text(row.description, 'description'), useWhen: text(row.useWhen, 'useWhen'), examples: strings(row.examples, 'examples'), category: name(row.category), subcategory: name(row.subcategory), tags: strings(row.tags, 'tags'), purpose: text(row.purpose, 'purpose'), stack: strings(row.stack, 'stack'), dependencies: strings(row.dependencies, 'dependencies'), license: text(row.license, 'license'), source, runtime: validateRuntime(row.runtime) };
    if (member.id !== member.name) fail('Member id/name mismatch');
    return member;
  });
  for (const field of ['id', 'legacyId', 'path'] as const) if (new Set(members.map(member => member[field].toLowerCase())).size !== members.length) fail('Duplicate pack member identity');
  for (const member of members) if (members.some(other => other !== member && member.path.startsWith(other.path + '/'))) fail('Overlapping member roots');
  return members;
}
export function validateManifest(value: unknown): SkillManifest {
  const row = record(value, ['schemaVersion', 'id', 'name', 'files', 'contentDigest', 'runtime', 'members'], 'manifest');
  if (row.schemaVersion !== 1 && row.schemaVersion !== 2) fail('Unsupported manifest schema');
  const result: SkillManifest = { schemaVersion: row.schemaVersion as 1 | 2, id: name(row.id), name: name(row.name), files: validateFiles(row.files), contentDigest: digest(row.contentDigest), runtime: validateRuntime(row.runtime) };
  if (result.id !== result.name) fail('Skill id/name mismatch');
  if (row.schemaVersion === 2) {
    result.members = validateMembers(row.members);
    for (const member of result.members) {
      if (!result.files.some(file => file.path === member.path + '/SKILL.md') || !result.files.some(file => file.path === member.path + '/LICENSE')) fail('Every member requires SKILL.md and LICENSE');
      if (member.runtime.entrypoint && !result.files.some(file => file.path === member.path + '/' + member.runtime.entrypoint)) fail('Missing member entrypoint');
    }
  } else if (row.members !== undefined || !result.files.some(file => file.path === 'SKILL.md')) fail('Legacy skill requires SKILL.md without pack members');
  if (!result.files.some(file => /^LICENSE(?:\.md|\.txt)?$/i.test(file.path))) fail('Skill requires LICENSE');
  if (result.runtime.entrypoint && !result.files.some(file => file.path === result.runtime.entrypoint)) fail('Missing declared runtime entrypoint');
  if ((result.schemaVersion === 2 ? digestPackManifest(result) : digestManifest(result.files)) !== result.contentDigest) fail('Manifest content digest mismatch');
  return result;
}
export function validateCatalog(value: unknown): Catalog {
  const row = record(value, ['schemaVersion', 'catalogVersion', 'minCliVersion', 'scope', 'categories', 'collections', 'skills'], 'catalog');
  if (![1, 2].includes(Number(row.schemaVersion)) || row.scope !== ALLOWED_SCOPE) fail('Untrusted catalog schema or namespace');
  const version = text(row.catalogVersion, 'catalog version', 100), minimum = text(row.minCliVersion, 'minimum CLI version', 100);
  if (!EXACT_VERSION.test(version) || !EXACT_VERSION.test(minimum)) fail('Catalog requires exact versions');
  if (!Array.isArray(row.categories) || !Array.isArray(row.collections) || !Array.isArray(row.skills) || row.skills.length > 1000) fail('Invalid catalog lists');
  const categories = (row.categories as unknown[]).map(value => { const item = record(value, ['id', 'title', 'children'], 'category'); const category: Catalog['categories'][number] = { id: name(item.id), title: text(item.title, 'title') }; if (item.children !== undefined) { if (!Array.isArray(item.children)) fail('Invalid subcategories'); category.children = (item.children as unknown[]).map(value => { const child = record(value, ['id', 'title'], 'subcategory'); return { id: name(child.id), title: text(child.title, 'title') }; }); } return category; });
  const collections = (row.collections as unknown[]).map(value => { const item = record(value, ['id', 'title', 'description', 'skills'], 'collection'); return { id: name(item.id), title: text(item.title, 'title'), description: text(item.description, 'description'), skills: strings(item.skills, 'skills').map(name) }; });
  const skills: CatalogEntry[] = (row.skills as unknown[]).map(value => {
    const item = record(value, ['id', 'name', 'title', 'description', 'useWhen', 'examples', 'category', 'tags', 'collection', 'license', 'source', 'status', 'runtime', 'packageName', 'version', 'integrity', 'contentDigest', 'fileCount', 'unpackedSize', 'localArtifact', 'kind', 'members'], 'catalog entry');
    const source = record(item.source, ['repository', 'commit', 'path', 'panelRevision', 'url'], 'source');
    for (const field of Object.keys(source)) text(source[field], 'source field');
    if (source.repository !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(source.repository))) fail('Invalid source repository');
    if (source.commit !== undefined && !/^[a-f0-9]{40}$/.test(String(source.commit))) fail('Source commit must be pinned');
    if (source.path !== undefined) safeRelativePath(String(source.path));
    if (source.url !== undefined) { const url = new URL(String(source.url)); if (url.protocol !== 'https:' || url.username || url.password) fail('Invalid source URL'); }
    const result: CatalogEntry = { id: name(item.id), name: name(item.name), title: text(item.title, 'title'), description: text(item.description, 'description'), useWhen: text(item.useWhen, 'useWhen'), examples: strings(item.examples, 'examples'), category: name(item.category), tags: strings(item.tags, 'tags'), collection: name(item.collection), license: text(item.license, 'license'), source, status: item.status as CatalogEntry['status'], runtime: validateRuntime(item.runtime), packageName: text(item.packageName, 'package name', 180), version: text(item.version, 'version', 100), integrity: validateIntegrity(item.integrity), contentDigest: digest(item.contentDigest), fileCount: integer(item.fileCount, LIMITS.files, 'file count', 1), unpackedSize: integer(item.unpackedSize, LIMITS.unpackedBytes, 'unpacked size', 1) };
    if (item.kind !== undefined || item.members !== undefined) { if (row.schemaVersion !== 2 || item.kind !== 'pack') fail('Pack requires schema 2'); result.kind = 'pack'; result.members = validateMembers(item.members); }
    if (result.id !== result.name || result.packageName !== `${ALLOWED_SCOPE}/skillshelf-${result.kind === 'pack' ? 'pack' : 'skill'}-${result.name}` || !EXACT_VERSION.test(result.version) || !['recommended', 'stable', 'legacy', 'experimental'].includes(result.status)) fail('Invalid catalog identity/version/status');
    if (item.localArtifact !== undefined) result.localArtifact = safeRelativePath(text(item.localArtifact, 'local artifact'));
    return result;
  });
  for (const values of [categories, collections, skills]) if (new Set(values.map(item => item.id)).size !== values.length) fail('Duplicate catalog ID');
  for (const entry of skills) { if (!categories.some(item => item.id === entry.category) || !collections.some(item => item.id === entry.collection && item.skills.includes(entry.id))) fail('Unknown category or collection membership'); }
  for (const group of collections) if (new Set(group.skills).size !== group.skills.length || group.skills.some(id => !skills.some(skill => skill.id === id))) fail('Invalid collection members');
  return { schemaVersion: row.schemaVersion as 1 | 2, catalogVersion: version, minCliVersion: minimum, scope: ALLOWED_SCOPE, categories, collections, skills };
}
export function validatePublicCatalog(value: unknown): Catalog {
  const result = validateCatalog(value);
  if (result.skills.some(item => item.localArtifact !== undefined)) fail('Public catalog must not contain localArtifact');
  return result;
}
export function validateSkillDocument(bytes:Uint8Array,expectedName:string):void{
  if(bytes.byteLength>1024*1024)fail('SKILL.md exceeds metadata document limit');
  let body:string;try{body=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('SKILL.md requires UTF-8');}
  const match=body!.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);if(!match)fail('SKILL.md requires YAML frontmatter');
  const document=parseDocument(match![1]!,{uniqueKeys:true,customTags:[]});if(document.errors.length)fail('Invalid SKILL.md YAML');
  let row:{name?:unknown;description?:unknown};try{row=document.toJS({maxAliasCount:0}) as typeof row;}catch{fail('SKILL.md aliases are forbidden');}
  if(!row!||typeof row!=='object'||Array.isArray(row)||row.name!==expectedName||typeof row.description!=='string'||!row.description.trim())fail('SKILL.md name/description mismatch');
}
/** Hash every regular file, including hidden/binary files. Never follow links. */
export async function inventory(root: string): Promise<FileEntry[]> {
  const initial = await lstat(root);
  if (!initial.isDirectory() || initial.isSymbolicLink()) fail('Inventory root must be a real directory');
  const files: FileEntry[] = []; let total = 0; let directories = 0;
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const relative = safeRelativePath(prefix + entry.name), absolute = path.join(directory, entry.name), info = await lstat(absolute);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) fail(`Links/special files forbidden: ${relative}`);
      if (info.isDirectory()) { if (++directories > LIMITS.files * 16) fail('Directory count limit exceeded'); await walk(absolute, relative + '/'); continue; }
      total += info.size;
      if (info.nlink !== 1 || info.size > LIMITS.fileBytes || total > LIMITS.unpackedBytes) fail('Hard link or file limit exceeded');
      if (files.length >= LIMITS.files) fail('File count limit exceeded');
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev || before.nlink !== 1) fail('File changed during inventory');
        const hash = createHash('sha256'); let size = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) { size += chunk.length; if (size > LIMITS.fileBytes) fail('File limit exceeded'); hash.update(chunk); }
        const after = await handle.stat();
        if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('File changed during inventory');
        files.push({ path: relative, size, sha256: hash.digest('hex'), executable: (before.mode & 0o111) !== 0 });
      } finally { await handle.close(); }
    }
  }
  await walk(root, '');
  return validateFiles(files);
}
export async function verifyTree(root: string, value: SkillManifest): Promise<void> {
  const manifest = validateManifest(value), actual = await inventory(root);
  if (process.platform === 'win32') for (const file of actual) file.executable = manifest.files.find(item => item.path === file.path)?.executable ?? file.executable;
  if (canonicalJson(actual) !== canonicalJson(manifest.files)) fail('Tree does not match exact manifest files/hash/size/mode');
}
