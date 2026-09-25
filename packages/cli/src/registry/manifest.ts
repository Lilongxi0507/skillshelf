import { createHash } from 'node:crypto';
import type {
  Acquisition,
  ArchiveReceipt,
  ExecutionAuthorization,
  GithubAcquisition,
  LocalAcquisition,
  NpmAcquisition,
  RuntimeDeclaration,
  SourceFileEntry,
  SourceLayout,
  SourceManifest,
  SourceMapping,
  SourceMember,
  SourceOverlay,
  SourceProvenance,
} from '../types.js';
import { ALLOWED_SCOPE, EXACT_VERSION, LIMITS, canonicalJson, safeRelativePath, validateIntegrity, validateRuntime } from '../validation.js';

const NAME_SOURCE = '[a-z0-9]+(?:-[a-z0-9]+)*';
const NAME = new RegExp(`^${NAME_SOURCE}$`, 'u');
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1_COMMIT = /^[a-f0-9]{40}$/u;
const SHA512 = /^[a-f0-9]{128}$/u;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;
const MAX_PACK_REVISION = 0x7fffffff;
const MAX_RECEIPT_BYTES = 512 * 1024 * 1024;

type Row = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(message);
}

function row(value: unknown, keys: readonly string[], label: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid ${label}`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`Invalid ${label}`);
  const result = value as Row;
  if (Object.keys(result).some((key) => !keys.includes(key))) fail(`Unknown ${label} field`);
  return result;
}

function text(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || CONTROL.test(value)) fail(`Invalid ${label}`);
  if (value.normalize('NFC') !== value) fail(`Invalid ${label} Unicode normalization`);
  return value;
}

function optionalText(value: unknown, label: string, maximum = 4096): string | undefined {
  return value === undefined ? undefined : text(value, label, maximum);
}

function integer(value: unknown, label: string, maximum: number, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`Invalid ${label}`);
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`Invalid ${label}`);
  return value;
}

function digest(value: unknown, label = 'SHA-256'): string {
  const result = text(value, label, label === 'SHA-512' ? 128 : 64);
  const expression = label === 'SHA-512' ? SHA512 : SHA256;
  if (!expression.test(result)) fail(`Invalid ${label}`);
  return result;
}

function repository(value: unknown): string {
  const result = text(value, 'repository', 200);
  if (!REPOSITORY.test(result) || result.startsWith('.') || result.endsWith('.')) fail('Invalid repository');
  return result;
}

function commit(value: unknown): string {
  const result = text(value, 'commit', 40);
  if (!SHA1_COMMIT.test(result)) fail('Commit must be a lower-case 40-character SHA');
  return result;
}

function name(value: unknown, label = 'name'): string {
  const result = text(value, label, 80);
  if (!NAME.test(result)) fail(`Invalid ${label}`);
  return result;
}

function pathValue(value: unknown, label: string): string {
  return safeRelativePath(text(value, label, 1024));
}

function uniquePathKey(value: string): string {
  return value.normalize('NFC').normalize('NFKC').toLocaleLowerCase('en-US');
}

function assertUniquePaths(paths: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of paths) {
    const key = uniquePathKey(value);
    if (seen.has(key)) fail(`Duplicate or case-colliding ${label}`);
    seen.add(key);
  }
}

function assertPathSpellings(paths: readonly string[]): void {
  const spellings = new Map<string, string>();
  for (const value of paths) {
    const parts = value.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      const folded = uniquePathKey(prefix);
      const previous = spellings.get(folded);
      if (previous !== undefined && previous !== prefix) fail('Case collision in directory spelling');
      spellings.set(folded, prefix);
    }
  }
}

function assertNoFileDirectoryCollision(paths: readonly string[]): void {
  assertPathSpellings(paths);
  const files = new Set(paths.map(uniquePathKey));
  for (const value of paths) {
    const parts = value.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      if (files.has(uniquePathKey(parts.slice(0, depth).join('/')))) fail('File/directory collision');
    }
  }
}

function assertFilesDoNotCollideWithDirectories(files: readonly string[], directories: readonly string[]): void {
  const fileKeys = files.map(uniquePathKey);
  for (const file of fileKeys) {
    for (const directory of directories.map(uniquePathKey)) {
      if (file === directory || directory.startsWith(`${file}/`)) fail('File/directory collision');
    }
  }
}

function assertCrossFileDirectoryCollision(left: readonly string[], right: readonly string[]): void {
  for (const leftPath of left) {
    for (const rightPath of right) {
      if (leftPath === rightPath) continue;
      if (pathWithin(leftPath, rightPath) || pathWithin(rightPath, leftPath)) fail('File/directory collision');
    }
  }
}

function pathWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function rootsOverlap(left: string, right: string): boolean {
  const foldedLeft = uniquePathKey(left);
  const foldedRight = uniquePathKey(right);
  return foldedLeft === foldedRight || foldedLeft.startsWith(`${foldedRight}/`) || foldedRight.startsWith(`${foldedLeft}/`);
}

function destinationOwnedByExactlyOneMapping(path: string, mappings: readonly SourceMapping[]): boolean {
  const owners = mappings.filter((mapping) => pathWithin(path, mapping.destinationPath));
  return owners.length === 1;
}

function validateGithubInventoryOwnership(files: readonly SourceFileEntry[], acquisition: GithubAcquisition): void {
  const mappings = acquisition.mappings;
  const overlays = acquisition.overlays ?? [];
  const mappingDestinations = mappings.map((mapping) => mapping.destinationPath);
  const overlayDestinations = overlays.map((overlay) => overlay.destinationPath);

  assertPathSpellings([
    ...mappings.flatMap((mapping) => [mapping.sourcePath, mapping.destinationPath]),
    ...overlayDestinations,
    ...files.map((file) => file.path),
  ]);
  assertFilesDoNotCollideWithDirectories(files.map((file) => file.path), mappingDestinations);
  assertFilesDoNotCollideWithDirectories(overlayDestinations, mappingDestinations);
  assertNoFileDirectoryCollision(overlayDestinations);
  assertCrossFileDirectoryCollision(
    overlayDestinations,
    files.map((file) => file.path).filter((path) => !overlayDestinations.includes(path)),
  );

  const overlayPaths = new Set(overlayDestinations);
  for (const file of files) {
    if (overlayPaths.has(file.path)) continue;
    if (!destinationOwnedByExactlyOneMapping(file.path, mappings)) fail('Selected file has no unique mapping ownership');
  }
}

function compareCanonical(left: unknown, right: unknown): number {
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function stringArray(value: unknown, label: string, maximum = 128): string[] {
  if (!Array.isArray(value) || value.length > maximum) fail(`Invalid ${label}`);
  const result = value.map((item) => text(item, label));
  if (new Set(result).size !== result.length) fail(`Duplicate ${label}`);
  return result;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  return value === undefined ? undefined : stringArray(value, label);
}

function validateSourceFile(value: unknown): SourceFileEntry {
  const item = row(value, ['path', 'size', 'sha256', 'mode', 'origin'], 'source file');
  const mode = item.mode;
  if (mode !== 100644 && mode !== 100755) fail('Invalid source file mode');
  const result: SourceFileEntry = {
    path: pathValue(item.path, 'source file path'),
    size: integer(item.size, 'source file size', LIMITS.fileBytes),
    sha256: digest(item.sha256),
    mode,
  };
  if (item.origin !== undefined) {
    if (!['upstream', 'authored', 'license'].includes(String(item.origin))) fail('Invalid source file origin');
    result.origin = item.origin as SourceFileEntry['origin'];
  }
  return result;
}

function validateSourceFiles(value: unknown): SourceFileEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.files) fail('Invalid source file inventory size');
  const files = value.map(validateSourceFile);
  assertUniquePaths(files.map((file) => file.path), 'source file');
  assertNoFileDirectoryCollision(files.map((file) => file.path));
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(total) || total > LIMITS.unpackedBytes) fail('Source file inventory size limit exceeded');
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function validateMapping(value: unknown, expectedRepository: string, expectedCommit: string): SourceMapping {
  const item = row(value, ['sourcePath', 'destinationPath', 'repository', 'commit'], 'source mapping');
  const result: SourceMapping = {
    sourcePath: pathValue(item.sourcePath, 'mapping source path'),
    destinationPath: pathValue(item.destinationPath, 'mapping destination path'),
  };
  if ((item.repository === undefined) !== (item.commit === undefined)) fail('Mapping repository and commit must be provided together');
  if (item.repository !== undefined) {
    result.repository = repository(item.repository);
    result.commit = commit(item.commit);
    if (result.repository !== expectedRepository || result.commit !== expectedCommit) fail('Mapping source identity does not match acquisition');
  }
  return result;
}

function validateOverlay(value: unknown, expectedRepository: string, expectedCommit: string): SourceOverlay {
  const item = row(value, ['origin', 'repository', 'commit', 'sourcePath', 'destinationPath', 'sha256', 'size', 'mode'], 'source overlay');
  if (!['upstream', 'authored', 'license'].includes(String(item.origin))) fail('Invalid overlay origin');
  const mode = item.mode;
  if (mode !== 100644 && mode !== 100755) fail('Invalid overlay mode');
  const overlayRepository = repository(item.repository);
  const overlayCommit = commit(item.commit);
  if (overlayRepository !== expectedRepository || overlayCommit !== expectedCommit) fail('Overlay source identity does not match acquisition');
  return {
    origin: item.origin as SourceOverlay['origin'],
    repository: overlayRepository,
    commit: overlayCommit,
    sourcePath: pathValue(item.sourcePath, 'overlay source path'),
    destinationPath: pathValue(item.destinationPath, 'overlay destination path'),
    sha256: digest(item.sha256),
    size: integer(item.size, 'overlay size', LIMITS.fileBytes),
    mode,
  };
}

function normalizedMappingPayload(mappings: readonly SourceMapping[], overlays: readonly SourceOverlay[] = []): { mappings: SourceMapping[]; overlays: SourceOverlay[] } {
  const normalizedMappings = mappings.map((mapping) => ({
    sourcePath: mapping.sourcePath,
    destinationPath: mapping.destinationPath,
    ...(mapping.repository === undefined ? {} : { repository: mapping.repository }),
    ...(mapping.commit === undefined ? {} : { commit: mapping.commit }),
  })).sort(compareCanonical);
  const normalizedOverlays = overlays.map((overlay) => ({
    origin: overlay.origin,
    repository: overlay.repository,
    commit: overlay.commit,
    sourcePath: overlay.sourcePath,
    destinationPath: overlay.destinationPath,
    sha256: overlay.sha256,
    size: overlay.size,
    mode: overlay.mode,
  })).sort(compareCanonical);
  return { mappings: normalizedMappings, overlays: normalizedOverlays };
}

/** Digest of the normalized source mappings and explicit overlays only. */
export function digestSourceMappings(mappings: readonly SourceMapping[], overlays: readonly SourceOverlay[] = []): string {
  return createHash('sha256').update(canonicalJson(normalizedMappingPayload(mappings, overlays))).digest('hex');
}

function validateGithubAcquisition(value: unknown): GithubAcquisition {
  const item = row(value, ['kind', 'repository', 'commit', 'mappings', 'overlays', 'manifestDigest', 'receiptPolicy'], 'github acquisition');
  if (item.kind !== 'github') fail('Invalid acquisition kind');
  const acquisitionRepository = repository(item.repository);
  const acquisitionCommit = commit(item.commit);
  if (!Array.isArray(item.mappings) || item.mappings.length === 0 || item.mappings.length > LIMITS.files) fail('GitHub acquisition requires mappings');
  const mappings = item.mappings.map((mapping) => validateMapping(mapping, acquisitionRepository, acquisitionCommit));
  assertUniquePaths(mappings.map((mapping) => mapping.destinationPath), 'mapping destination');
  assertUniquePaths(mappings.map((mapping) => mapping.sourcePath), 'mapping source');
  assertPathSpellings(mappings.map((mapping) => mapping.destinationPath));
  assertPathSpellings(mappings.map((mapping) => mapping.sourcePath));
  for (let index = 0; index < mappings.length; index += 1) {
    for (let next = index + 1; next < mappings.length; next += 1) {
      if (rootsOverlap(mappings[index]!.destinationPath, mappings[next]!.destinationPath)) fail('Overlapping mapping destinations');
      if (rootsOverlap(mappings[index]!.sourcePath, mappings[next]!.sourcePath)) fail('Overlapping mapping sources');
    }
  }
  assertNoFileDirectoryCollision(mappings.map((mapping) => mapping.sourcePath));
  assertPathSpellings(mappings.map((mapping) => mapping.destinationPath));
  const result: GithubAcquisition = {
    kind: 'github',
    repository: acquisitionRepository,
    commit: acquisitionCommit,
    mappings,
  };
  if (item.overlays !== undefined) {
    if (!Array.isArray(item.overlays) || item.overlays.length > LIMITS.files) fail('Invalid source overlays');
    const overlays = item.overlays.map((overlay) => validateOverlay(overlay, acquisitionRepository, acquisitionCommit));
    assertUniquePaths(overlays.map((overlay) => overlay.destinationPath), 'overlay destination');
    const mappingDestinations = new Set(mappings.map((mapping) => uniquePathKey(mapping.destinationPath)));
    if (overlays.some((overlay) => mappingDestinations.has(uniquePathKey(overlay.destinationPath)))) fail('Overlay collides with mapping destination');
    result.overlays = overlays;
  }
  if (item.manifestDigest !== undefined) {
    result.manifestDigest = digest(item.manifestDigest, 'manifest digest');
    if (result.manifestDigest !== digestSourceMappings(mappings, result.overlays ?? [])) fail('Mapping digest mismatch');
  }
  if (item.receiptPolicy !== undefined) {
    if (item.receiptPolicy !== 'required' && item.receiptPolicy !== 'optional') fail('Invalid archive receipt policy');
    result.receiptPolicy = item.receiptPolicy;
  }
  return result;
}

function validateNpmAcquisition(value: unknown): NpmAcquisition {
  const item = row(value, ['kind', 'packageName', 'version', 'integrity'], 'npm acquisition');
  if (item.kind !== 'npm') fail('Invalid acquisition kind');
  const packageName = text(item.packageName, 'package name', 180);
  const escapedScope = ALLOWED_SCOPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^${escapedScope}/skillshelf-(?:skill|pack)-${NAME_SOURCE}$`, 'u').test(packageName)) fail('npm package must use the fixed SkillShelf namespace');
  const version = text(item.version, 'npm version', 100);
  if (!EXACT_VERSION.test(version)) fail('npm acquisition requires an exact version');
  return { kind: 'npm', packageName, version, integrity: validateIntegrity(item.integrity) };
}

function validateLocalAcquisition(value: unknown): LocalAcquisition {
  const item = row(value, ['kind', 'purpose', 'path'], 'local acquisition');
  if (item.kind !== 'local' || (item.purpose !== 'fixture' && item.purpose !== 'import')) fail('Local acquisition must be fixture or import only');
  const result: LocalAcquisition = { kind: 'local', purpose: item.purpose };
  if (item.path !== undefined) result.path = pathValue(item.path, 'local acquisition path');
  return result;
}

function validateAcquisition(value: unknown): Acquisition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid acquisition');
  switch ((value as Row).kind) {
    case 'github': return validateGithubAcquisition(value);
    case 'npm': return validateNpmAcquisition(value);
    case 'local': return validateLocalAcquisition(value);
    default: return fail('Unsupported acquisition kind');
  }
}

function validateProvenance(value: unknown): SourceProvenance {
  const item = row(value, ['upstream', 'repository', 'commit', 'path', 'authors', 'license', 'notice', 'modified', 'notes'], 'provenance');
  const result: SourceProvenance = {};
  if (item.upstream !== undefined) result.upstream = text(item.upstream, 'provenance upstream', 200);
  if (item.repository !== undefined) result.repository = repository(item.repository);
  if (item.commit !== undefined) result.commit = commit(item.commit);
  if (item.path !== undefined) result.path = pathValue(item.path, 'provenance path');
  if (item.authors !== undefined) result.authors = stringArray(item.authors, 'provenance authors', 64);
  if (item.license !== undefined) result.license = text(item.license, 'provenance license', 200);
  if (item.notice !== undefined) result.notice = text(item.notice, 'provenance notice', 200);
  if (item.modified !== undefined) result.modified = boolean(item.modified, 'provenance modified');
  if (item.notes !== undefined) result.notes = text(item.notes, 'provenance notes');
  return result;
}

function validateMember(value: unknown): SourceMember {
  const item = row(value, ['id', 'name', 'path', 'files', 'runtime'], 'source member');
  const result: SourceMember = { id: name(item.id, 'member id'), path: pathValue(item.path, 'member path') };
  if (item.name !== undefined) result.name = text(item.name, 'member name', 120);
  if (item.files !== undefined) result.files = stringArray(item.files, 'member files', LIMITS.files).map((file) => pathValue(file, 'member file'));
  if (item.runtime !== undefined) result.runtime = validateRuntime(item.runtime);
  return result;
}

function validateMembers(value: unknown): SourceMember[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.files) fail('Invalid source members');
  const members = value.map(validateMember);
  assertUniquePaths(members.map((member) => member.id), 'member id');
  assertUniquePaths(members.map((member) => member.path), 'member path');
  return members;
}

function validateLayout(value: unknown): SourceLayout[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > LIMITS.files) fail('Invalid source layout');
  const layout = value.map((entry) => {
    const item = row(entry, ['memberId', 'path'], 'source layout');
    return { memberId: name(item.memberId, 'layout member id'), path: pathValue(item.path, 'layout path') };
  });
  assertUniquePaths(layout.map((entry) => entry.memberId), 'layout member');
  assertUniquePaths(layout.map((entry) => entry.path), 'layout path');
  return layout;
}

function validateArchiveReceipt(value: unknown): ArchiveReceipt {
  const item = row(value, ['compressedSha512', 'compressedBytes'], 'archive receipt');
  return {
    compressedSha512: digest(item.compressedSha512, 'SHA-512'),
    compressedBytes: integer(item.compressedBytes, 'compressed archive bytes', MAX_RECEIPT_BYTES, 1),
  };
}

function validateAuthorization(value: unknown, manifest: SourceManifest): ExecutionAuthorization {
  const item = row(value, ['kind', 'issuer', 'tool', 'skillId', 'memberId', 'repository', 'commit', 'mappingDigest', 'treeDigest', 'releaseDigest', 'entrypoint', 'runtime', 'minimumVersion', 'dependencies', 'providers', 'requiresNetwork'], 'execution authorization');
  if (item.kind !== 'first-party') fail('Invalid execution authorization kind');
  if (manifest.acquisition.kind !== 'github') fail('Only a fixed GitHub acquisition can carry first-party authorization');
  const result: ExecutionAuthorization = {
    kind: 'first-party',
    issuer: text(item.issuer, 'authorization issuer', 200),
    repository: repository(item.repository),
    commit: commit(item.commit),
    treeDigest: digest(item.treeDigest, 'authorization tree digest'),
    releaseDigest: digest(item.releaseDigest, 'authorization release digest'),
    entrypoint: pathValue(item.entrypoint, 'authorization entrypoint'),
  };
  if (item.tool !== undefined) result.tool = name(item.tool, 'authorization tool');
  if (item.skillId !== undefined) result.skillId = name(item.skillId, 'authorization skill id');
  if (item.memberId !== undefined) result.memberId = name(item.memberId, 'authorization member id');
  if (item.mappingDigest !== undefined) result.mappingDigest = digest(item.mappingDigest, 'authorization mapping digest');
  if (item.runtime !== undefined) result.runtime = validateRuntime(item.runtime);
  if (item.minimumVersion !== undefined) result.minimumVersion = text(item.minimumVersion, 'authorization minimum version', 40);
  if (item.dependencies !== undefined) result.dependencies = stringArray(item.dependencies, 'authorization dependencies');
  if (item.providers !== undefined) {
    const providers = stringArray(item.providers, 'authorization providers');
    if (providers.some((provider) => !['search', 'image', 'video'].includes(provider))) fail('Invalid authorization providers');
    result.providers = providers as NonNullable<ExecutionAuthorization['providers']>;
  }
  if (item.requiresNetwork !== undefined) result.requiresNetwork = boolean(item.requiresNetwork, 'authorization network declaration');

  const acquisition = manifest.acquisition;
  if (result.repository !== acquisition.repository || result.commit !== acquisition.commit) fail('Authorization source identity does not match acquisition');
  if (result.treeDigest !== manifest.treeDigest || result.releaseDigest !== manifest.releaseDigest) fail('Authorization digest does not match manifest');
  if (result.mappingDigest !== undefined && (acquisition.manifestDigest === undefined || result.mappingDigest !== acquisition.manifestDigest)) fail('Authorization mapping digest does not match acquisition');

  const member = manifest.members === undefined
    ? undefined
    : result.memberId === undefined
      ? fail('Authorization member id is required for a member manifest')
      : manifest.members.find((candidate) => candidate.id === result.memberId);
  if (manifest.members !== undefined && member === undefined) fail('Authorization member identity does not match manifest');
  if (manifest.members === undefined && result.memberId !== undefined) fail('Authorization member identity does not match manifest');
  const identity = member?.id ?? manifest.id;
  if (result.tool !== undefined && result.tool !== identity) fail('Authorization tool identity does not match manifest');
  if (result.skillId !== undefined && result.skillId !== identity) fail('Authorization skill identity does not match manifest');

  const runtime = member?.runtime ?? manifest.runtime;
  const entrypoint = member?.runtime?.entrypoint === undefined
    ? runtime.entrypoint
    : `${member.path}/${member.runtime.entrypoint}`;
  if (entrypoint === undefined || result.entrypoint !== entrypoint) fail('Authorization entrypoint does not match manifest');
  if (result.runtime !== undefined && canonicalJson(result.runtime) !== canonicalJson(runtime)) fail('Authorization runtime does not match manifest');
  if (result.minimumVersion !== undefined && result.minimumVersion !== runtime.minimumVersion) fail('Authorization minimum version does not match manifest');
  if (result.dependencies !== undefined && canonicalJson(result.dependencies) !== canonicalJson(runtime.dependencies ?? [])) fail('Authorization dependencies do not match manifest');
  if (result.providers !== undefined && canonicalJson(result.providers) !== canonicalJson(runtime.providers ?? [])) fail('Authorization providers do not match manifest');
  if (result.requiresNetwork !== undefined && result.requiresNetwork !== runtime.requiresNetwork) fail('Authorization network declaration does not match manifest');
  return result;
}

function sourceTreePayload(files: readonly SourceFileEntry[]): SourceFileEntry[] {
  return files.map((file) => ({ ...file })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/** Digest of the selected file tree. Archive/gzip bytes and receipt metadata are not included. */
export function digestSourceTree(files: readonly SourceFileEntry[]): string {
  return createHash('sha256').update(canonicalJson(sourceTreePayload(files))).digest('hex');
}

function releasePayload(value: Pick<SourceManifest, 'schemaVersion' | 'id' | 'name' | 'packRevision' | 'acquisition' | 'provenance' | 'files' | 'treeDigest' | 'runtime' | 'members' | 'layout'>): unknown {
  return {
    schemaVersion: value.schemaVersion,
    id: value.id,
    name: value.name,
    packRevision: value.packRevision,
    acquisition: value.acquisition,
    provenance: value.provenance,
    files: sourceTreePayload(value.files),
    treeDigest: value.treeDigest,
    runtime: value.runtime,
    ...(value.members === undefined ? {} : { members: value.members }),
    ...(value.layout === undefined ? {} : { layout: value.layout }),
  };
}

/** Digest of the reviewed release identity. Transport and authorization receipts are excluded. */
export function digestSourceRelease(value: Pick<SourceManifest, 'schemaVersion' | 'id' | 'name' | 'packRevision' | 'acquisition' | 'provenance' | 'files' | 'treeDigest' | 'runtime' | 'members' | 'layout'> & Partial<Pick<SourceManifest, 'archiveReceipt' | 'authorization' | 'releaseDigest'>>): string {
  return createHash('sha256').update(canonicalJson(releasePayload(value))).digest('hex');
}

export function validateSourceManifest(value: unknown): SourceManifest {
  const item = row(value, ['schemaVersion', 'id', 'name', 'packRevision', 'acquisition', 'provenance', 'files', 'treeDigest', 'releaseDigest', 'runtime', 'members', 'layout', 'archiveReceipt', 'authorization'], 'source manifest');
  if (item.schemaVersion !== 3) fail('Unsupported source manifest schema');
  const files = validateSourceFiles(item.files);
  const result: SourceManifest = {
    schemaVersion: 3,
    id: name(item.id, 'manifest id'),
    name: name(item.name, 'manifest name'),
    packRevision: integer(item.packRevision, 'pack revision', MAX_PACK_REVISION, 1),
    acquisition: validateAcquisition(item.acquisition),
    provenance: validateProvenance(item.provenance),
    files,
    treeDigest: digest(item.treeDigest, 'tree digest'),
    releaseDigest: digest(item.releaseDigest, 'release digest'),
    runtime: validateRuntime(item.runtime),
  };
  if (result.id !== result.name) fail('Source manifest id/name mismatch');
  if (result.treeDigest !== digestSourceTree(files)) fail('Tree digest mismatch');
  if (item.members !== undefined) result.members = validateMembers(item.members);
  if (item.layout !== undefined) {
    result.layout = validateLayout(item.layout);
    if (result.members && result.layout.some((entry) => !result.members!.some((member) => member.id === entry.memberId))) fail('Layout references unknown member');
  }
  if (item.archiveReceipt !== undefined) result.archiveReceipt = validateArchiveReceipt(item.archiveReceipt);
  if (result.acquisition.kind === 'github') {
    validateGithubInventoryOwnership(result.files, result.acquisition);
    if (result.acquisition.overlays) {
      const filesByPath = new Map(result.files.map((file) => [file.path, file]));
      for (const overlay of result.acquisition.overlays) {
        const file = filesByPath.get(overlay.destinationPath);
        if (!file || file.sha256 !== overlay.sha256 || file.size !== overlay.size || file.mode !== overlay.mode) fail('Overlay does not match selected file inventory');
      }
    }
  }
  const expectedRelease = digestSourceRelease(result);
  if (result.releaseDigest !== expectedRelease) fail('Release digest mismatch');
  if (item.authorization !== undefined) result.authorization = validateAuthorization(item.authorization, result);
  if (result.runtime.entrypoint && !result.files.some((file) => file.path === result.runtime.entrypoint)) fail('Missing declared runtime entrypoint');
  return result;
}
