import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Header, Parser, Pax } from 'tar';
import type { CatalogEntry, SkillManifest } from '../types.js';
import { canonicalJson, LIMITS, safeRelativePath, validateIntegrity, validateManifest, validateSkillDocument } from '../validation.js';
import { ensurePrivateDirectory } from './files.js';
import { PROJECT_URL, RELEASE_CHANNEL, REPOSITORY_URL } from '../release.js';

export interface TarFile { path: string; data: Buffer; executable: boolean }
export interface VerifiedSkillArchive { manifest: SkillManifest; files: TarFile[] }
const decoder = new TextDecoder('utf-8', { fatal: true });
function error(message: string): never { throw new Error(`Unsafe package: ${message}`); }
export function assertIntegrity(bytes: Uint8Array, integrity: string): void {
  validateIntegrity(integrity);
  const expected = Buffer.from(integrity.slice(7), 'base64'), actual = createHash('sha512').update(bytes).digest();
  if (!timingSafeEqual(actual, expected)) error('tarball SHA-512 integrity mismatch');
}
/** A policy pre-pass using the maintained tar Header/Pax decoders. It forbids
 * ignored metadata, ambiguous encodings and trailing second archives before the
 * library Parser consumes bodies. It is not an alternate extraction/parser.
 */
function preflight(tar: Buffer): void {
  let offset = 0, count = 0, pending: Pax | undefined, ended = false;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512), header = new Header(block);
    offset += 512;
    if (header.nullBlock) {
      if (pending || offset + 512 > tar.length || tar.subarray(offset).some(byte => byte !== 0)) error('invalid terminator/trailing archive');
      ended = true; break;
    }
    if (!header.cksumValid || !header.path || ++count > LIMITS.files * 3 + 32) error('invalid header or entry limit');
    // Check UTF-8/name bytes before tar's platform normalization/replacement.
    for (const field of [block.subarray(0, 100), block.subarray(345, 500)]) {
      const zero = field.indexOf(0);
      if (zero >= 0 && field.subarray(zero).some(byte => byte !== 0)) error('ambiguous tar name encoding');
      decoder.decode(zero < 0 ? field : field.subarray(0, zero));
    }
    if (!['File', 'OldFile', 'Directory', 'ExtendedHeader'].includes(header.type) || header.linkpath || ((header.mode ?? 0) & 0o7000)) error('links/special entries or permissions');
    const rawSize = header.size ?? 0;
    if (!Number.isSafeInteger(rawSize) || rawSize < 0 || rawSize > LIMITS.fileBytes) error('entry size limit');
    const size = header.type !== 'ExtendedHeader' && pending?.size !== undefined ? pending.size : rawSize;
    if (size !== rawSize) error('ambiguous PAX/header size');
    if (offset + Math.ceil(size / 512) * 512 > tar.length) error('truncated body');
    const data = tar.subarray(offset, offset + size);
    if (tar.subarray(offset + size, offset + Math.ceil(size / 512) * 512).some(byte => byte !== 0)) error('nonzero tar padding');
    offset += Math.ceil(size / 512) * 512;
    if (header.type === 'ExtendedHeader') {
      if (pending || !size || size > 65536) error('oversized/repeated PAX metadata');
      safeRelativePath(header.path);
      const text = decoder.decode(data), keys = new Set<string>();
      if (!text.endsWith('\n')) error('incomplete PAX metadata');
      for (const line of text.slice(0, -1).split('\n')) {
        const match = /^([1-9]\d*) ([A-Za-z.]+)=([^\x00\r\n]*)$/.exec(line);
        if (!match || Number(match[1]) !== Buffer.byteLength(line) + 1 || !['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment'].includes(match[2]!) || keys.has(match[2]!)) error('unsupported, duplicate or malformed PAX field');
        keys.add(match[2]!);
      }
      pending = Pax.parse(text);
      if (pending.path) safeRelativePath(pending.path);
    } else {
      const resolved = pending?.path ?? header.path;
      safeRelativePath(header.type === 'Directory' && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved);
      pending = undefined;
    }
  }
  if (!ended) error('missing tar terminator');
}
/** Full bounded parse before any filesystem write. Links, devices, sparse files and concatenated archives fail closed. */
export function readTarball(bytes: Uint8Array, integrity?: string): TarFile[] {
  if (bytes.byteLength > LIMITS.archiveBytes) error('compressed byte limit exceeded');
  if (integrity !== undefined) assertIntegrity(bytes, integrity);
  const compressed = Buffer.from(bytes);
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) error('expected gzip tarball');
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: LIMITS.tarBytes }); } catch { return error('invalid or oversized gzip stream'); }
  if (tar.length % 512 !== 0) error('unaligned tar stream');
  preflight(tar);
  const files: TarFile[] = [], seen = new Map<string, { path: string; directory: boolean }>();
  let total = 0, count = 0, ended = false;
  function register(name: string, directory: boolean): void {
    const folded = name.toLowerCase(), existing = seen.get(folded);
    if (existing) error('duplicate/case-colliding tar path');
    const segments = name.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const prefix = segments.slice(0, depth).join('/'), parent = seen.get(prefix.toLowerCase());
      if (parent && (!parent.directory || parent.path !== prefix)) error('tar path ancestor collision');
    }
    for (const item of seen.values()) {
      if (item.path.toLowerCase().startsWith(folded + '/') && (!directory || !item.path.startsWith(name + '/'))) error('tar file/directory collision');
    }
    seen.set(folded, { path: name, directory });
  }
  const parser = new Parser({ strict: true, maxMetaEntrySize: 65536, onReadEntry(entry) {
    if (++count > LIMITS.files * 2 + 32 || !['File', 'OldFile', 'Directory'].includes(entry.type) || entry.linkpath || entry.nlink !== undefined || entry.globalExtended || entry.invalid) error('unsupported tar entry');
    const directory = entry.type === 'Directory';
    const name = safeRelativePath(directory && entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path);
    if (name !== 'package' && !name.startsWith('package/')) error('entry outside npm package root');
    register(name, directory);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > LIMITS.fileBytes || ((entry.mode ?? 0) & 0o7000)) error('size or mode limit');
    if (directory) { if (entry.size !== 0) error('nonempty directory'); entry.resume(); return; }
    total += entry.size;
    if (total > LIMITS.unpackedBytes + 2 * 1024 * 1024 || files.length >= LIMITS.files + 8) error('unpacked package limit exceeded');
    const chunks: Buffer[] = []; let size = 0;
    entry.on('data', (chunk: Buffer) => { size += chunk.length; if (size > entry.size) error('entry size mismatch'); chunks.push(Buffer.from(chunk)); });
    entry.on('end', () => { if (entry.invalid || size !== entry.size) error('truncated entry'); files.push({ path: name, data: Buffer.concat(chunks), executable: ((entry.mode ?? 0) & 0o111) !== 0 }); });
    entry.resume();
  } });
  parser.on('error', () => error('tar parser rejected archive'));
  parser.on('warn', () => error('tar parser warning rejected'));
  parser.on('ignoredEntry', () => error('ignored tar entry rejected'));
  parser.on('end', () => { ended = true; });
  // An uncompressed Buffer and drained entry streams are parsed synchronously by
  // node-tar. Fail closed if a future library changes this contract.
  parser.end(tar);
  if (!ended || !files.length) error('incomplete synchronous parse or empty archive');
  return files;
}
export function parseJsonFile(file: TarFile | undefined): unknown {
  if (!file || file.data.length > LIMITS.catalogBytes) error('missing/oversized metadata');
  try { return JSON.parse(decoder.decode(file.data)); } catch { return error('invalid UTF-8 JSON metadata'); }
}
export function validateDataPackage(value: unknown, packageName: string, version: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) error('invalid package.json');
  const row = value as Record<string, unknown>;
  if (row.name !== packageName || row.version !== version) error('package identity/version mismatch');
  const allowed = ['name', 'version', 'description', 'license', 'files', 'private', 'publishConfig', 'repository', 'homepage', 'bugs'];
  if (Object.keys(row).some(key => !allowed.includes(key))) error('package is not data-only (unknown field, lifecycle/bin/dependency metadata)');
  if (row.private !== undefined && typeof row.private !== 'boolean') error('invalid private metadata');
  if (typeof row.license !== 'string' || !row.license || !Array.isArray(row.files) || row.files.some(item => typeof item !== 'string')) error('missing package license/files');
  if (row.publishConfig !== undefined && ![canonicalJson({access:'public'}), canonicalJson({access:'public',tag:RELEASE_CHANNEL})].includes(canonicalJson(row.publishConfig))) error('untrusted publish configuration');
  if (row.repository !== undefined && canonicalJson(row.repository) !== canonicalJson({type:'git',url:REPOSITORY_URL})) error('untrusted repository metadata');
  if (row.homepage !== undefined && row.homepage !== PROJECT_URL+'#readme') error('untrusted homepage metadata');
  if (row.bugs !== undefined && canonicalJson(row.bugs) !== canonicalJson({url:PROJECT_URL+'/issues'})) error('untrusted issues metadata');
}
export function verifySkillArchive(bytes: Uint8Array, entry: CatalogEntry): VerifiedSkillArchive {
  const files = readTarball(bytes, entry.integrity);
  const manifest = validateManifest(parseJsonFile(files.find(file => file.path === 'package/skillshelf.manifest.json')));
  const packageMetadata = parseJsonFile(files.find(file => file.path === 'package/package.json')) as Record<string, unknown>;
  validateDataPackage(packageMetadata, entry.packageName, entry.version);
  if (packageMetadata.license !== entry.license) error('catalog/package license mismatch');
  if (manifest.id !== entry.id || manifest.name !== entry.name || manifest.contentDigest !== entry.contentDigest || canonicalJson(manifest.runtime) !== canonicalJson(entry.runtime)) error('catalog/manifest mismatch');
  if (manifest.files.length !== entry.fileCount || manifest.files.reduce((sum, file) => sum + file.size, 0) !== entry.unpackedSize) error('catalog inventory mismatch');
  const permitted = new Set(['package/package.json', 'package/skillshelf.manifest.json', 'package/LICENSE', 'package/NOTICE', ...manifest.files.map(file => 'package/skill/' + file.path)]);
  if (files.some(file => !permitted.has(file.path))) error('undeclared archive file');
  const skillFiles = files.filter(file => file.path.startsWith('package/skill/'));
  if (skillFiles.length !== manifest.files.length) error('missing/extra skill files');
  for (const expected of manifest.files) {
    const actual = skillFiles.find(file => file.path === 'package/skill/' + expected.path);
    if (!actual || actual.data.length !== expected.size || createHash('sha256').update(actual.data).digest('hex') !== expected.sha256 || actual.executable !== expected.executable) error('skill file hash/size/mode mismatch');
  }
  if (manifest.schemaVersion === 2) {
    if (entry.kind !== 'pack' || canonicalJson(manifest.members) !== canonicalJson(entry.members)) error('Pack member metadata differs from catalog');
    for (const member of manifest.members!) validateSkillDocument(skillFiles.find(file => file.path === `package/skill/${member.path}/SKILL.md`)!.data, member.name);
  } else validateSkillDocument(skillFiles.find(file=>file.path==='package/skill/SKILL.md')!.data,manifest.name);
  const rootLicense = files.find(file => file.path === 'package/LICENSE'), skillLicense = skillFiles.find(file => /^package\/skill\/LICENSE(?:\.md|\.txt)?$/i.test(file.path));
  if (!rootLicense || !skillLicense || !rootLicense.data.equals(skillLicense.data)) error('root LICENSE missing or inconsistent');
  return { manifest, files: skillFiles.map(file => ({ ...file, path: file.path.slice('package/skill/'.length) })) };
}
/** Destination must not exist; validation finishes before its creation. */
export async function extractVerifiedSkill(bytes: Uint8Array, entry: CatalogEntry, destination: string): Promise<SkillManifest> {
  const verified = verifySkillArchive(bytes, entry);
  try { await lstat(destination); error('extraction destination already exists'); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
  await ensurePrivateDirectory(path.dirname(path.resolve(destination)));
  await mkdir(destination, { mode: 0o700 });
  for (const file of verified.files) {
    const target = path.join(destination, file.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.data, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
    await chmod(target, file.executable ? 0o555 : 0o444);
  }
  return verified.manifest;
}
