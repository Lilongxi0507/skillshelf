// v0.3 catalog generation. Expands the reviewed v0.3 source config into
// explicit per-member fixed GitHub acquisitions, classifies every reviewed
// fixture file as mapped body / declared overlay, and emits metadata-only
// catalog data. It never treats an arbitrary worktree as trusted: fixtures
// are the reviewed snapshots pinned by the catalog config, and any
// unclassified file fails the whole generation.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { json, modules, outputDirectory, readRegularFile, runtimeFor, skillRootFor, writeUnchangedOrNew } from './lib.mjs';
import { argumentsFor } from './lib.mjs';
import { packDefinitions } from './packs.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));

async function manifestApi() {
  const base = path.join(root, 'packages/cli', 'dist');
  return import(pathToFileURL(path.join(base, 'registry/manifest.js')).href);
}

function packIdFor(definition) {
  return definition.source === 'first-party'
    ? definition.name
    : ({ matt: 'matt-pocock', uiux: 'ui-ux-pro-max' }[definition.source] ?? definition.source);
}

function boundarySuffix(value, prefix) {
  if (prefix === '') return value;
  if (value === prefix) return '';
  if (value.startsWith(prefix + '/')) return value.slice(prefix.length + 1);
  return null;
}

/** The reviewed member root: a single mapping is its own root; multi-mapping
 * members share one common prefix that is one segment shorter than the
 * shallowest mapping destination. */
export function memberRootFor(mappings) {
  if (mappings.length === 1) return mappings[0].destinationPath;
  const shallowest = Math.min(...mappings.map((mapping) => mapping.destinationPath.split('/').length));
  const first = [...mappings].sort((a, b) => a.destinationPath.length - b.destinationPath.length)[0].destinationPath;
  return first.split('/').slice(0, shallowest - 1).join('/');
}

function assertPinnedTuple(value, label) {
  if (!value || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository) || !/^[a-f0-9]{40}$/u.test(value.commit)) {
    throw new Error(label + ' must retain a pinned repository and 40-character commit');
  }
  return value;
}

/** Expand the reviewed config into one explicit acquisition descriptor per member. */
export function expandSourceConfig(config) {
  if (!config?.v3 || config.v3.sourceSchema !== 3) throw new Error('catalog/sources.json must carry a v0.3 source schema');
  const firstParty = assertPinnedTuple(config.v3.firstParty, 'v0.3 first-party source commit S');
  if (!Number.isSafeInteger(config.v3.catalogRevision) || config.v3.catalogRevision < 1) throw new Error('v0.3 catalog revision must be a positive integer');
  const legalOverlays = config.v3.legalOverlays ?? {};
  const memberMappings = config.v3.memberMappings ?? {};
  const firstPartySources = config.v3.firstPartySources ?? {};
  const declaredRevisions = config.v3.packRevisions ?? {};
  const packRevisions = {};
  for (const pack of packDefinitions(config)) {
    const value = declaredRevisions[pack.id];
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Pack revision must be a positive integer: ' + pack.id);
    packRevisions[pack.id] = value;
  }
  const members = config.skills.map((definition) => {
    const tuple = definition.source === 'first-party'
      ? firstParty
      : assertPinnedTuple(config.repositories?.[definition.source], 'Member source ' + definition.name);
    let mappings;
    if (definition.source === 'first-party') {
      const declared = firstPartySources[definition.name];
      if (!declared?.sourcePath || !declared.destinationPath) throw new Error('First-party member needs a reviewed S-root mapping: ' + definition.name);
      mappings = [{ sourcePath: declared.sourcePath, destinationPath: declared.destinationPath, fixtureSubpath: '' }];
    } else if (memberMappings[definition.name]) {
      mappings = memberMappings[definition.name].map((mapping) => ({ sourcePath: mapping.sourcePath, destinationPath: mapping.destinationPath, fixtureSubpath: mapping.fixtureSubpath ?? '' }));
      if (!mappings.length) throw new Error('Member mappings must not be empty: ' + definition.name);
    } else {
      if (!definition.path || /panel/u.test(definition.path)) throw new Error('Member mapping path is missing or is a legacy panel path: ' + definition.name);
      mappings = [{ sourcePath: definition.path, destinationPath: definition.path, fixtureSubpath: '' }];
    }
    const destinationRoot = memberRootFor(mappings);
    const overlays = (legalOverlays[definition.source] ?? []).map((overlay) => {
      const tupleForOverlay = overlay.repository === 'first-party'
        ? firstParty
        : (overlay.repository ? assertPinnedTuple(config.repositories?.[overlay.repository], 'Overlay source ' + definition.name) : tuple);
      if (!overlay.sourcePath) throw new Error('Overlay needs a pinned sourcePath: ' + definition.name);
      return {
        origin: overlay.origin,
        repository: tupleForOverlay.repository,
        commit: tupleForOverlay.commit,
        sourcePath: overlay.sourcePath,
        destinationPath: `${destinationRoot}/${path.posix.basename(overlay.sourcePath)}`,
      };
    });
    return {
      name: definition.name,
      pack: packIdFor(definition),
      packRevision: packRevisions[packIdFor(definition)],
      fixtureRoot: path.join('skills', definition.snapshot || definition.name, 'skill'),
      acquisition: { kind: 'github', repository: tuple.repository, commit: tuple.commit, mappings, overlays },
    };
  });
  if (members.length !== 83) throw new Error('v0.3 config must describe all 83 members: ' + members.length);
  if (new Set(members.map((member) => member.pack)).size !== 8) throw new Error('v0.3 config must describe all 8 packs');
  const exclusions = (config.v3.exclusions ?? []).map((row) => {
    const source = assertPinnedTuple(config.repositories?.[row.source], 'Exclusion source ' + row.source);
    if (!row.sourcePath || !row.reason) throw new Error('Exclusions need a pinned source path and reviewed reason');
    return { repository: source.repository, commit: source.commit, sourcePath: row.sourcePath, reason: row.reason };
  });
  return { sourceSchema: 3, catalogRevision: config.v3.catalogRevision, firstParty, members, exclusions };
}

/** Classify every fixture file and build schema-3 source manifests for all members. */
export async function buildSourceManifests(expanded, options = {}) {
  const base = options.root ?? root;
  const api = options.api ?? await modules();
  const manifest = options.manifest ?? await manifestApi();
  const digests = {};
  const manifests = [];
  const unclassified = [];
  let totalFiles = 0;
  for (const member of expanded.members) {
    const fixture = path.join(base, member.fixtureRoot);
    const entries = await api.inventory(fixture);
    const destinationRoot = memberRootFor(member.acquisition.mappings);
    const overlayByBasename = new Map(member.acquisition.overlays.map((overlay) => [path.posix.basename(overlay.sourcePath), overlay]));
    const files = [];
    const manifestOverlays = [];
    for (const entry of entries) {
      const mode = entry.executable ? 100755 : 100644;
      const overlay = overlayByBasename.get(entry.path);
      if (overlay !== undefined && boundarySuffix(overlay.destinationPath, destinationRoot) === entry.path) {
        files.push({ path: overlay.destinationPath, size: entry.size, sha256: entry.sha256, mode, origin: overlay.origin });
        manifestOverlays.push({
          origin: overlay.origin,
          repository: overlay.repository,
          commit: overlay.commit,
          sourcePath: overlay.sourcePath,
          destinationPath: overlay.destinationPath,
          sha256: entry.sha256,
          size: entry.size,
          mode,
        });
        continue;
      }
      const mapping = member.acquisition.mappings.find((candidate) => boundarySuffix(entry.path, candidate.fixtureSubpath || '') !== null);
      if (!mapping) {
        unclassified.push({ member: member.name, path: entry.path });
        continue;
      }
      const suffix = boundarySuffix(entry.path, mapping.fixtureSubpath || '');
      files.push({ path: suffix ? `${mapping.destinationPath}/${suffix}` : mapping.destinationPath, size: entry.size, sha256: entry.sha256, mode });
    }
    if (unclassified.length) throw new Error('Unclassified fixture files: ' + JSON.stringify(unclassified.slice(0, 10)));
    if (manifestOverlays.length !== member.acquisition.overlays.length) {
      throw new Error('Every declared overlay must match exactly one fixture file: ' + member.name);
    }
    const runtime = runtimeFor(member.name);
    const memberRuntime = runtime.entrypoint ? { ...runtime, entrypoint: `${destinationRoot}/${runtime.entrypoint}` } : runtime;
    const payload = {
      schemaVersion: 3,
      id: member.name,
      name: member.name,
      packRevision: member.packRevision,
      acquisition: {
        kind: 'github',
        repository: member.acquisition.repository,
        commit: member.acquisition.commit,
        mappings: member.acquisition.mappings.map(({ sourcePath, destinationPath }) => ({ sourcePath, destinationPath })),
        overlays: manifestOverlays,
      },
      provenance: { repository: member.acquisition.repository, commit: member.acquisition.commit },
      files,
      runtime: memberRuntime,
    };
    payload.treeDigest = manifest.digestSourceTree(files);
    payload.acquisition.manifestDigest = manifest.digestSourceMappings(payload.acquisition.mappings, payload.acquisition.overlays);
    payload.releaseDigest = manifest.digestSourceRelease(payload);
    const validated = manifest.validateSourceManifest(payload);
    totalFiles += validated.files.length;
    digests[member.name] = validated.releaseDigest;
    manifests.push(validated);
  }
  if (totalFiles !== 623) throw new Error('Reviewed fixture file count drift: ' + totalFiles);
  return { manifests, report: { totalFiles, digests, unclassified } };
}

/** Assemble the metadata-only public catalog (schema 3) from verified manifests. */
export async function preparePublicCatalog(expanded, built, { catalogRevision } = {}) {
  if (!Number.isSafeInteger(catalogRevision) || catalogRevision < 1) throw new Error('catalogRevision must be a positive integer');
  const api = await modules();
  const manifest = await manifestApi();
  const memberByName = new Map(expanded.members.map((member) => [member.name, member]));
  const grouped = new Map();
  const members = [];
  for (const entry of built.manifests) {
    const member = memberByName.get(entry.id);
    if (!member) throw new Error('Manifest without config member: ' + entry.id);
    if (!grouped.has(member.pack)) grouped.set(member.pack, []);
    grouped.get(member.pack).push(entry);
    members.push({
      name: entry.id,
      pack: member.pack,
      packRevision: entry.packRevision,
      acquisition: entry.acquisition,
      sourceManifest: entry,
      treeDigest: entry.treeDigest,
      releaseDigest: entry.releaseDigest,
      fileCount: entry.files.length,
      unpackedSize: entry.files.reduce((sum, file) => sum + file.size, 0),
      runtime: entry.runtime,
    });
  }
  const packs = [];
  for (const [id, manifestList] of grouped) {
    const files = manifestList.flatMap((entry) => entry.files);
    const repositories = [];
    for (const entry of manifestList) {
      for (const tuple of [entry.acquisition, ...(entry.acquisition.overlays ?? [])]) {
        if (!repositories.some((row) => row.repository === tuple.repository && row.commit === tuple.commit)) {
          repositories.push({ repository: tuple.repository, commit: tuple.commit });
        }
      }
    }
    packs.push({
      id,
      packRevision: manifestList[0].packRevision,
      treeDigest: manifest.digestSourceTree(files),
      fileCount: files.length,
      unpackedSize: files.reduce((sum, file) => sum + file.size, 0),
      members: manifestList.map((entry) => entry.id),
      repositories,
    });
  }
  const catalog = {
    schemaVersion: 3,
    catalogRevision,
    scope: api.ALLOWED_SCOPE,
    minCliVersion: api.CLI_VERSION,
    packs: packs.sort((a, b) => (a.id < b.id ? -1 : 1)),
    members: members.sort((a, b) => (a.name < b.name ? -1 : 1)),
    exclusions: expanded.exclusions,
  };
  return { catalog };
}

// CLI entry: generate into an explicitly named new output directory.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const options = argumentsFor(process.argv.slice(2), { '--output': true });
  if (!options['--output'] || !path.isAbsolute(options['--output'])) throw new Error('--output must name an absolute new directory');
  const output = await outputDirectory(options['--output']);
  const config = await json(path.join(root, 'catalog/sources.json'));
  const expanded = expandSourceConfig(config);
  const built = await buildSourceManifests(expanded);
  const prepared = await preparePublicCatalog(expanded, built, { catalogRevision: expanded.catalogRevision });
  await writeUnchangedOrNew(path.join(output, 'catalog.public.json'), JSON.stringify(prepared.catalog, null, 2) + '\n');
  await writeUnchangedOrNew(path.join(output, 'source-manifest-report.json'), JSON.stringify({
    catalogRevision: expanded.catalogRevision,
    totalFiles: built.report.totalFiles,
    members: built.manifests.map((entry) => ({
      id: entry.id,
      packRevision: entry.packRevision,
      releaseDigest: entry.releaseDigest,
      fileCount: entry.files.length,
      mappings: entry.acquisition.mappings,
      overlays: entry.acquisition.overlays ?? [],
    })),
    exclusions: expanded.exclusions,
    unclassified: built.report.unclassified,
  }, null, 2) + '\n');
  console.log(`Generated metadata-only v0.3 catalog: ${prepared.catalog.members.length} members, ${prepared.catalog.packs.length} packs, ${built.report.totalFiles} reviewed files. No publication performed.`);
}
