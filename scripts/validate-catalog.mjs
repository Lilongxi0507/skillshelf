// Catalog validation. The v3 path rebuilds the schema-3 catalog from the
// reviewed source config and compares it byte-exactly — no local skill
// tarballs required. The legacy schema-1/2 path (including --development
// local artifact verification) is preserved unchanged.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argumentsFor, json, modules, readRegularFile, root } from './lib.mjs';
import { packDefinitions, packContents } from './packs.mjs';
import { expandSourceConfig, buildSourceManifests, preparePublicCatalog } from './prepare-catalog.mjs';

/** Validate a loaded catalog against the reviewed config. Schema-3 catalogs
 * are rebuilt from the reviewed fixtures and compared; legacy catalogs keep
 * the pack-content walk. Returns a summary; throws on any drift. */
export async function validateCatalogData(config, catalogData, options = {}) {
  const development = options.development ?? false;
  const catalogDirectory = options.catalogDirectory ?? root;
  const api = options.api ?? await modules();
  if (catalogData?.schemaVersion === 3) {
    const expanded = expandSourceConfig(config);
    if (catalogData.catalogRevision !== expanded.catalogRevision) {
      throw new Error('Schema-3 catalog revision drift: the catalog does not carry the reviewed catalogRevision');
    }
    const built = await buildSourceManifests(expanded, { root });
    const prepared = await preparePublicCatalog(expanded, built, { catalogRevision: expanded.catalogRevision });
    if (api.canonicalJson(prepared.catalog) !== api.canonicalJson(catalogData)) {
      throw new Error('Schema-3 catalog drift: the catalog does not match the reviewed source config rebuild');
    }
    return { mode: 'v3', packs: prepared.catalog.packs.length, members: prepared.catalog.members.length, tarballs: 0, catalog: catalogData };
  }
  const catalog = (development ? api.validateCatalog : api.validatePublicCatalog)(catalogData);
  const packs = packDefinitions(config);
  if (api.canonicalJson(catalog.skills.map((entry) => entry.id).sort()) !== api.canonicalJson(packs.map((pack) => pack.id).sort())) {
    throw new Error('Catalog must contain exactly the reviewed complete packs');
  }
  let tarballs = 0;
  for (const pack of packs) {
    const entry = catalog.skills.find((row) => row.id === pack.id);
    const { manifest, metadata } = await packContents(config, pack, api);
    if (entry.contentDigest !== manifest.contentDigest || entry.fileCount !== manifest.files.length || entry.unpackedSize !== manifest.files.reduce((sum, file) => sum + file.size, 0)) {
      throw new Error('Pack content drift: ' + pack.id);
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (api.canonicalJson(entry[key]) !== api.canonicalJson(value)) throw new Error('Pack metadata drift: ' + pack.id + '/' + key);
    }
    if (entry.localArtifact) {
      tarballs += 1;
      api.verifySkillArchive(await readRegularFile(path.join(catalogDirectory, entry.localArtifact)), entry);
    }
  }
  return { mode: 'legacy', packs: packs.length, members: catalog.skills.reduce((sum, entry) => sum + entry.members.length, 0), tarballs, catalog };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const options = argumentsFor(process.argv.slice(2), { '--catalog': true, '--development': false });
  const filename = path.resolve(options['--catalog'] || path.join(root, 'catalog/bootstrap.json'));
  const config = await json(path.join(root, 'catalog/sources.json'));
  const result = await validateCatalogData(config, await json(filename), {
    development: options['--development'] === true,
    catalogDirectory: path.dirname(filename),
  });
  console.log(`Validated ${result.packs} complete packs, ${result.members} members (${result.mode}, ${result.tarballs} local artifact(s)); metadata-only catalog. Not published.`);
}
