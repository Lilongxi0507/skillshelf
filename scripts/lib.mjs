import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Header, Pax } from 'tar';

export const root = fileURLToPath(new URL('../', import.meta.url));
export async function modules() {
  // Maintenance loads only compiled CLI data verifiers, never skill code.
  const base = path.join(root, 'packages/cli', 'dist');
  const validation = await import(pathToFileURL(path.join(base, 'validation.js')).href);
  const tar = await import(pathToFileURL(path.join(base, 'registry/tar.js')).href);
  const release = await import(pathToFileURL(path.join(base, 'release.js')).href);
  return { ...validation, ...tar, ...release };
}
export async function json(filename) { return JSON.parse(await readFile(filename, 'utf8')); }
export function argumentsFor(argv, allowed) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!Object.hasOwn(allowed, key) || Object.hasOwn(values, key)) throw new Error('Unknown or duplicate argument: ' + key);
    if (allowed[key]) { const value = argv[++index]; if (!value || value.startsWith('--')) throw new Error('Argument requires value: ' + key); values[key] = value; }
    else values[key] = true;
  }
  return values;
}
function inside(parent, candidate, paths = path) {
  const relative = paths.relative(parent, candidate);
  return !relative || (relative !== '..' && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative));
}
function absolutePath(value, paths = path) {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/u.test(value) || value !== value.normalize('NFC') || !paths.isAbsolute(value)) throw new Error('Output/input must explicitly name an absolute canonical path');
  // Drive-relative, UNC and device paths are not portable local maintenance paths.
  if (paths.sep === '\\' ? !/^[A-Za-z]:[\\/]/u.test(value) : value.startsWith('//') || value.includes('\\')) throw new Error('Ambiguous absolute path');
  const parsed = paths.parse(value), segments = value.slice(parsed.root.length).split(paths.sep === '\\' ? /[\\/]/u : '/');
  if (segments.some(segment => segment === '.' || segment === '..' || (segment && (/^[ ]|[. ]$|[<>:"|?*]/u.test(segment) || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(segment))))) throw new Error('Unsafe or platform-aliased path');
  const resolved = paths.resolve(value);
  if (resolved === paths.parse(resolved).root) throw new Error('Filesystem root is not an output/input path');
  return resolved;
}
/** Pure policy check. paths/sourceRoot are injectable for platform-policy tests only. */
export function validateOutputPath(value, { sourceRoot = root, paths = path } = {}) {
  const resolved = absolutePath(value, paths), source = paths.resolve(sourceRoot);
  if (inside(source, resolved, paths) || inside(resolved, source, paths)) throw new Error('Output must not overlap the source checkout');
  const protectedRoots = ['/data/panel', '/data/browser', '/data/caddy', '/data/docker', '/data/containerd', '/data/deepseek-harness', '/srv/panel', '/srv/workspaces', '/var/lib/docker', '/var/lib/containerd'];
  for (const protectedRoot of protectedRoots) {
    const boundary = paths.sep === '\\' ? paths.join(paths.parse(resolved).root, protectedRoot) : protectedRoot;
    if (inside(boundary, resolved, paths) || inside(resolved, boundary, paths)) throw new Error('Output must not overlap checkout or protected data');
  }
  if (paths.sep === '/' && inside('/srv/panel', source, paths)) {
    const runBase = '/data/panel-agent-tmp', relative = paths.relative(runBase, resolved).split('/');
    if (!inside(runBase, resolved, paths) || relative.length < 2 || !/^run-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(relative[0])) throw new Error('This server requires an output subdirectory of /data/panel-agent-tmp/run-*');
  }
  return resolved;
}
async function statOrMissing(filename) {
  try { return await lstat(filename); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
/** Check EVERY existing ancestor before creating anything; never follow directory links. */
async function directoryPath(directory, { create = false, rejectCheckout = false } = {}) {
  const resolved = path.resolve(directory), base = path.parse(resolved).root;
  let current = base;
  const missing = [];
  for (const part of resolved.slice(base.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await statOrMissing(current);
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Path must not contain links/special files');
      if (rejectCheckout && await statOrMissing(path.join(current, '.git'))) throw new Error('Output must not be inside any Git checkout');
    } else missing.push(current);
  }
  if (missing.length && !create) throw new Error('Required directory does not exist');
  for (const directory of missing) await mkdir(directory, { mode: 0o700 });
  // A second walk catches link substitution during directory creation.
  current = base;
  for (const part of resolved.slice(base.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Path changed or contains a link');
    if (rejectCheckout && await statOrMissing(path.join(current, '.git'))) throw new Error('Output must not be inside any Git checkout');
  }
  const canonical = await realpath(resolved);
  if (path.relative(resolved, canonical) !== '') throw new Error('Path canonicalization mismatch');
  return resolved;
}
/** New/empty output is the default. Only prepare-release reopens verified pack output. */
export async function outputDirectory(value, { existing = false, sourceRoot = root } = {}) {
  const source = await realpath(sourceRoot);
  const resolved = validateOutputPath(value, { sourceRoot: source });
  await directoryPath(resolved, { create: !existing, rejectCheckout: true });
  if (!existing && (await readdir(resolved)).length) throw new Error('Output directory must be new or empty');
  return resolved;
}
/** Bounded regular-file read, including ancestor/link/hardlink and mutation checks. */
export async function readRegularFile(filename, maximum = 20 * 1024 * 1024) {
  const resolved = absolutePath(filename);
  await directoryPath(path.dirname(resolved));
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) throw new Error('Expected bounded regular file without links');
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.dev !== info.dev || before.ino !== info.ino || before.size > maximum) throw new Error('File changed before read');
    const chunks = []; let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maximum) throw new Error('File exceeds size limit');
      chunks.push(chunk);
    }
    const after = await handle.stat(), named = await lstat(resolved);
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || !named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.dev !== before.dev || named.ino !== before.ino) throw new Error('File changed during read');
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}
export async function readJsonFile(filename, maximum = 4 * 1024 * 1024) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readRegularFile(filename, maximum)));
}
/** Safe idempotent preparation: identical files stay untouched, different files fail closed. */
export async function assertWritableFile(filename, data) {
  const resolved = absolutePath(filename), bytes = Buffer.from(data);
  await directoryPath(path.dirname(resolved));
  if (!await statOrMissing(resolved)) return;
  const existing = await readRegularFile(resolved, Math.max(bytes.length, 1));
  if (!existing.equals(bytes)) throw new Error('Refusing to overwrite different existing file: ' + resolved);
}
export async function writeUnchangedOrNew(filename, data) {
  const resolved = absolutePath(filename), bytes = Buffer.from(data);
  await assertWritableFile(resolved, bytes);
  let handle;
  try { handle = await open(resolved, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; await assertWritableFile(resolved, bytes); return; }
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (!(await readRegularFile(resolved, Math.max(bytes.length, 1))).equals(bytes)) throw new Error('Written file verification failed');
}
export function integrityFor(bytes) { return 'sha512-' + createHash('sha512').update(bytes).digest('base64'); }
export function publicationMetadata(api) {
  return { repository: { type: 'git', url: api.REPOSITORY_URL }, homepage: api.PROJECT_URL + '#readme', bugs: { url: api.PROJECT_URL + '/issues' }, publishConfig: { access: 'public', tag: api.RELEASE_CHANNEL } };
}
export function assertPublicationMetadata(metadata, api, { repositoryDirectory } = {}) {
  const expected = publicationMetadata(api);
  if (repositoryDirectory) expected.repository.directory = repositoryDirectory;
  for (const [key, value] of Object.entries(expected)) {
    if (api.canonicalJson(metadata[key] ?? null) !== api.canonicalJson(value)) throw new Error('Unreviewed publication metadata: ' + key);
  }
  if (metadata.private === true) throw new Error('Release package must not be private');
}
export function publicationEntry(name, version, file, bytes, api) {
  api.safeRelativePath(file);
  if (version !== api.CLI_VERSION || !name.startsWith(api.ALLOWED_SCOPE + '/') || !/^skillshelf(?:-catalog|-skill-[a-z0-9]+(?:-[a-z0-9]+)*)?$/u.test(name.slice(api.ALLOWED_SCOPE.length + 1)) || !file.endsWith('.tgz')) throw new Error('Unreviewed release identity');
  return { name, version, file, integrity: integrityFor(bytes), tag: api.RELEASE_CHANNEL, access: 'public', repository: api.REPOSITORY_URL };
}
export function publicationPlan(packages, api, complete = false) {
  if (packages.length !== (complete ? 18 : 17) || new Set(packages.map(row => row.name)).size !== packages.length || new Set(packages.map(row => row.file.toLowerCase())).size !== packages.length) throw new Error('Publication plan requires exact unique reviewed package count');
  for (const row of packages) {
    const expected = publicationEntry(row.name, row.version, row.file, Buffer.alloc(0), api);
    api.validateIntegrity(row.integrity);
    if (api.canonicalJson({ ...expected, integrity: row.integrity }) !== api.canonicalJson(row)) throw new Error('Unreviewed publication plan entry');
  }
  if (packages.filter(row => row.name.startsWith(`${api.ALLOWED_SCOPE}/skillshelf-skill-`)).length !== 16 || !packages.some(row => row.name === `${api.ALLOWED_SCOPE}/skillshelf-catalog`) || packages.some(row => row.name === `${api.ALLOWED_SCOPE}/skillshelf`) !== complete) throw new Error('Plan requires 16 skills, catalog and the actual CLI only when complete');
  return { schemaVersion: 1, published: false, complete, scope: api.ALLOWED_SCOPE, version: api.CLI_VERSION, tag: api.RELEASE_CHANNEL, access: 'public', repository: api.REPOSITORY_URL, packages };
}
export function assertReleaseConfig(config, api) {
  if (config.scope !== api.ALLOWED_SCOPE || config.version !== api.CLI_VERSION || config.skills?.length !== 16) throw new Error('Reviewed scope/version and exact initial 16 skills required');
  if (new Set(config.skills.map(row => row.name)).size !== 16) throw new Error('Duplicate configured skill');
  for (const row of config.skills) {
    if (typeof row.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.name)) throw new Error('Unsafe configured skill name');
    api.safeRelativePath(row.path);
    if (row.source !== 'first-party') {
      const source = config.repositories?.[row.source];
      if (!source || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source.repository) || !/^[a-f0-9]{40}$/u.test(source.commit)) throw new Error('Source must retain a pinned upstream repository and commit');
    }
  }
}
export function catalogNotice(api) {
  return `SkillShelf metadata-only catalog, distributed as ${api.ALLOWED_SCOPE}/skillshelf-catalog.\nDistribution repository: ${api.PROJECT_URL}\nSource repositories, pinned commits and paths are preserved in catalog.json. Original licenses and attribution remain with each complete skill package.\n`;
}
/** Verify the real catalog package, exact metadata-only file list and public bytes. */
export function verifyCatalogArchive(bytes, publicCatalog, api, { license } = {}) {
  const files = api.readTarball(bytes), expected = ['package/LICENSE', 'package/NOTICE', 'package/catalog.json', 'package/package.json'];
  if (api.canonicalJson(files.map(row => row.path).sort()) !== api.canonicalJson(expected.sort()) || files.some(row => row.executable)) throw new Error('Catalog must contain only reviewed metadata files');
  const metadata = api.parseJsonFile(files.find(row => row.path === 'package/package.json'));
  api.validateDataPackage(metadata, `${api.ALLOWED_SCOPE}/skillshelf-catalog`, api.CLI_VERSION);
  assertPublicationMetadata(metadata, api);
  if (metadata.license !== 'MIT' || metadata.description !== 'SkillShelf metadata-only catalog' || api.canonicalJson(metadata.files) !== api.canonicalJson(['catalog.json', 'LICENSE', 'NOTICE'])) throw new Error('Unexpected catalog distribution metadata');
  const actual = api.validatePublicCatalog(api.parseJsonFile(files.find(row => row.path === 'package/catalog.json'))), actualLicense = files.find(row => row.path === 'package/LICENSE').data;
  if (api.canonicalJson(actual) !== api.canonicalJson(publicCatalog) || !actualLicense.length || !files.find(row => row.path === 'package/NOTICE').data.equals(Buffer.from(catalogNotice(api))) || (license && !actualLicense.equals(license))) throw new Error('Catalog package contents differ from verified public metadata or attribution');
  return metadata;
}
/** Deterministic npm-compatible USTAR data archive; npm publish <tgz> can use it.
 * No npm lifecycle hooks, packlists, ignores or dependency resolution exist here.
 */
export function makeTarball(files) {
  const blocks = [];
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const header = Buffer.alloc(512), data = Buffer.from(file.data);
    const metadata = { path: file.path, mode: file.executable ? 0o755 : 0o644, uid: 0, gid: 0, size: data.length, mtime: new Date(0), type: 'File', linkpath: '', uname: '', gname: '' };
    const needsPax = new Header(metadata).encode(header);
    if (needsPax) blocks.push(new Pax({ path: file.path }).encode());
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}
export function sourceFor(config, definition) {
  return definition.source === 'first-party' ? { path: definition.path, panelRevision: 'owner-authorized-local-snapshot; see packaged NOTICE original file hashes' } : { ...config.repositories[definition.source], path: definition.path };
}
export async function sourceAttribution(config, definition) {
  return definition.source === 'first-party' ? readRegularFile(path.join(root, 'skills', definition.name, 'skill/NOTICE')) : Buffer.from(`Source: https://github.com/${config.repositories[definition.source].repository}\nCommit: ${config.repositories[definition.source].commit}\nPath: ${definition.path}\nComplete selected skill snapshot, with root upstream LICENSE. Distributed by SkillShelf; upstream attribution and licenses remain unchanged.\n`);
}
export function runtimeFor(name) {
  if (name === 'skillshelf-web-search' || name === 'skillshelf-media-generation') return { kind: 'python', entrypoint: 'scripts/run.py', minimumVersion: '3.10', requiresNetwork: true, providers: name === 'skillshelf-web-search' ? ['search'] : ['image', 'video'], dependencies: [] };
  return { kind: 'instructions', requiresNetwork: false };
}
export function catalogFor(config, skills) {
  return { schemaVersion: 1, catalogVersion: config.version, minCliVersion: config.version, scope: config.scope,
    categories: [{ id: 'design', title: '视觉与界面设计' }, { id: 'engineering', title: '工程与代码' }, { id: 'research', title: '搜索与研究' }, { id: 'media', title: '图片与视频' }],
    collections: [{ id: 'taste', title: 'Taste 精选', description: '固定上游提交的 13 项完整技能。', skills: config.skills.filter(row => row.collection === 'taste').map(row => row.name) }, { id: 'uiux', title: 'UI/UX Pro Max', description: '完整资源、检索脚本与数据快照。', skills: ['ui-ux-pro-max'] }, { id: 'local-tools', title: '本地执行工具', description: '第一方标准库脚本，服务配置和成品留在本机。', skills: ['skillshelf-web-search', 'skillshelf-media-generation'] }], skills };
}
