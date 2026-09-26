// Local preparation only: no npm process, account access, login, push or publish.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCliArchive } from './audit-cli-package.mjs';
import { argumentsFor, assertPublicationMetadata, assertWritableFile, catalogNotice, makeTarball, modules, outputDirectory, publicationEntry, publicationPlan, publicationPlanV3, readJsonFile, readRegularFile, root, verifyCatalogArchive, writeUnchangedOrNew, assertReleaseConfig } from './lib.mjs';
import { packDefinitions, packContents, packCatalog } from './packs.mjs';
import { validateCatalogData } from './validate-catalog.mjs';

/** Compose the v0.3 two-package release from a verified schema-3 catalog and
 * the actual CLI archive bytes. The metadata-only catalog archive is built,
 * verified by round-trip, and paired with the CLI in a schema-3 publication
 * plan. No npm process, account access, or publication happens here. */
export async function buildV3ReleaseArtifacts(config, { catalogData, cliBytes, catalogLicense }) {
  if (!Buffer.isBuffer(cliBytes) || !cliBytes.length) throw new Error('v0.3 release requires the actual CLI archive bytes');
  const validation = await validateCatalogData(config, catalogData);
  if (validation.mode !== 'v3') throw new Error('v0.3 release requires a schema-3 catalog');
  const api = await modules();
  const catalog = validation.catalog;
  const catalogPackage = {
    name: `${api.ALLOWED_SCOPE}/skillshelf-catalog`,
    version: api.CLI_VERSION,
    description: 'SkillShelf metadata-only catalog',
    license: 'MIT',
    files: ['catalog.json', 'LICENSE', 'NOTICE'],
    ...publicationMetadata(api),
  };
  const catalogFiles = [
    { path: 'package/package.json', data: JSON.stringify(catalogPackage) },
    { path: 'package/catalog.json', data: api.canonicalJson(catalog) + '\n' },
    { path: 'package/LICENSE', data: catalogLicense },
    { path: 'package/NOTICE', data: catalogNotice(api) },
  ];
  if (!Buffer.isBuffer(catalogLicense) || !catalogLicense.length) throw new Error('v0.3 catalog archive needs the reviewed license bytes');
  const catalogBytes = makeTarball(catalogFiles);
  const verified = api.readTarball(catalogBytes);
  if (api.canonicalJson(verified.map((file) => file.path).sort()) !== api.canonicalJson(['package/LICENSE', 'package/NOTICE', 'package/catalog.json', 'package/package.json'])) {
    throw new Error('Catalog archive must contain only reviewed metadata files');
  }
  assertPublicationMetadata(api.parseJsonFile(verified.find((file) => file.path === 'package/package.json')), api);
  if (api.canonicalJson(api.parseJsonFile(verified.find((file) => file.path === 'package/catalog.json'))) !== api.canonicalJson(catalog)) {
    throw new Error('Catalog archive bytes do not round-trip the verified catalog');
  }
  const catalogEntry = publicationEntry(catalogPackage.name, api.CLI_VERSION, `catalog-${api.CLI_VERSION}.tgz`, catalogBytes, api);
  const cliEntry = publicationEntry(`${api.ALLOWED_SCOPE}/skillshelf`, api.CLI_VERSION, `skillshelf-${api.CLI_VERSION}.tgz`, cliBytes, api);
  const plan = publicationPlanV3([catalogEntry, cliEntry], api, { catalogRevision: catalog.catalogRevision });
  const review = `# SkillShelf v0.3 release preparation\n\nStatus: **PREPARED LOCALLY / NOT PUBLISHED BY THIS TOOL**. The reviewed public distribution is exactly two packages: \`${api.ALLOWED_SCOPE}/skillshelf-catalog@${api.CLI_VERSION}\` and \`${api.ALLOWED_SCOPE}/skillshelf@${api.CLI_VERSION}\` (catalog revision ${catalog.catalogRevision}), tag \`${api.RELEASE_CHANNEL}\`, access \`public\`. Repository: ${api.REPOSITORY_URL}. Skill packs are acquired from pinned GitHub sources and are never published to npm in this model.\n\nThe catalog was rebuilt from the reviewed source config and compared byte-exactly before packaging. This tool never logs in, checks account credentials, calls a registry, or publishes.\n\n- [ ] Complete isolated compiler/tests, adversarial archive tests, cross-platform/offline flows and an installed CLI smoke.\n- [ ] Verify the CLI archive against its bundled catalog and the fixed-source flows before release.\n- [ ] Use only the two exact files named by publication-plan.json.\n- [ ] The separately authorized remote release uses the reviewed channel and public access.\n- [ ] Verify registry-downloaded bytes against each recorded SHA-512 SRI after release.\n`;
  return { plan, catalogBytes, catalogFiles, review };
}

function publicationMetadata(api) {
  return { repository: { type: 'git', url: api.REPOSITORY_URL }, homepage: api.PROJECT_URL + '#readme', bugs: { url: api.PROJECT_URL + '/issues' }, publishConfig: { access: 'public', tag: api.RELEASE_CHANNEL } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const options = argumentsFor(process.argv.slice(2), { '--output': true, '--cli-tarball': true, '--catalog': true, '--v3': false });
  if (!options['--cli-tarball'] || !path.isAbsolute(options['--cli-tarball'])) throw new Error('--cli-tarball must name the actual npm-packed CLI tgz by absolute path (not dry-run JSON)');
  const api = await modules();
  const { canonicalJson, readTarball, parseJsonFile, validateCatalog, validatePublicCatalog, validateManifest, verifySkillArchive } = api;
  const output = await outputDirectory(options['--output'], { existing: true });
  const config = await readJsonFile(path.join(root, 'catalog/sources.json'));
  const cliBytes = await readRegularFile(options['--cli-tarball']);

  if (options['--v3']) {
    const catalogFile = options['--catalog'] ? path.resolve(options['--catalog']) : path.join(output, 'catalog.public.json');
    const catalogData = await readJsonFile(catalogFile);
    const cli = await auditCliArchive(cliBytes, { api, expectedCatalog: await readJsonFile(path.join(root, 'catalog/bootstrap.json')) });
    const { plan, catalogBytes, review } = await buildV3ReleaseArtifacts(config, {
      catalogData,
      cliBytes,
      catalogLicense: await readRegularFile(path.join(root, 'skills/skillshelf-web-search/skill/LICENSE')),
    });
    const cliArtifact = `skillshelf-${api.CLI_VERSION}.tgz`;
    const catalogArtifact = `catalog-${api.CLI_VERSION}.tgz`;
    const writes = [
      [path.join(output, catalogArtifact), catalogBytes],
      [path.join(output, cliArtifact), cliBytes],
      [path.join(output, 'RELEASE-REVIEW.md'), review],
      [path.join(output, 'publication-plan.json'), canonicalJson(plan) + '\n'],
    ];
    for (const [filename, data] of writes) await assertWritableFile(filename, data);
    for (const [filename, data] of writes) await writeUnchangedOrNew(filename, data);
    console.log(`Prepared v0.3 two-package publication-plan.json (${api.ALLOWED_SCOPE}, ${api.CLI_VERSION}, catalog revision ${plan.catalogRevision}, ${api.RELEASE_CHANNEL}/public). No publication or account access performed.`);
    process.exit(0);
  }

  assertReleaseConfig(config, api);
  const packs = packDefinitions(config);
  const catalog = validateCatalog(await readJsonFile(path.join(output, 'catalog.development.json')));
  const publicCatalog = validatePublicCatalog(await readJsonFile(path.join(output, 'catalog.public.json')));
  if (catalog.catalogVersion !== config.version || catalog.skills.length !== packs.length || canonicalJson(catalog.skills.map(entry => entry.name).sort()) !== canonicalJson(packs.map(pack => pack.id).sort())) throw new Error('Pack output must contain the exact reviewed skills and release version');
  const stripped = { ...catalog, skills: catalog.skills.map(({ localArtifact, ...entry }) => entry) };
  if (canonicalJson(stripped) !== canonicalJson(publicCatalog) || canonicalJson(packCatalog(config, stripped.skills)) !== canonicalJson(publicCatalog)) throw new Error('Public and development catalog metadata differ');

  const packages = [];
  for (const pack of packs) {
    const entry = catalog.skills.find(entry => entry.id === pack.id), artifact = `artifacts/${pack.id}-${config.version}.tgz`;
    if (entry.localArtifact !== artifact || entry.version !== config.version) throw new Error('Pack identity mismatch');
    const expected = await packContents(config, pack, api);
    for (const [key, value] of Object.entries(expected.metadata)) if (canonicalJson(entry[key]) !== canonicalJson(value)) throw new Error('Pack metadata drift: ' + pack.id + '/' + key);
    const bytes = await readRegularFile(path.join(output, artifact)), verified = verifySkillArchive(bytes, entry), files = readTarball(bytes);
    if (canonicalJson(verified.manifest) !== canonicalJson(validateManifest(expected.manifest))) throw new Error('Pack differs from complete source inventory');
    const metadata = parseJsonFile(files.find(file => file.path === 'package/package.json')); assertPublicationMetadata(metadata, api);
    if (metadata.description !== entry.description || metadata.license !== entry.license || canonicalJson(metadata.files) !== canonicalJson(['skill/', 'skillshelf.manifest.json', 'LICENSE', 'NOTICE'])) throw new Error('Unexpected pack distribution metadata');
    if (!files.find(file => file.path === 'package/NOTICE')?.data.equals(expected.notice)) throw new Error('Source attribution changed');
    packages.push(publicationEntry(entry.packageName, entry.version, artifact, bytes, api));
  }
  const catalogArtifact = `catalog-${config.version}.tgz`, catalogBytes = await readRegularFile(path.join(output, catalogArtifact));
  verifyCatalogArchive(catalogBytes, publicCatalog, api, { license: await readRegularFile(path.join(root, 'skills/skillshelf-web-search/skill/LICENSE')) });
  packages.push(publicationEntry(`${api.ALLOWED_SCOPE}/skillshelf-catalog`, config.version, catalogArtifact, catalogBytes, api));
  const partial = publicationPlan(packages, api, packs.length);
  if (canonicalJson(await readJsonFile(path.join(output, 'publication-plan.data.json'))) !== canonicalJson(partial)) throw new Error('Data publication plan does not match actual verified artifacts');

  const cli = await auditCliArchive(cliBytes, { api, expectedCatalog: publicCatalog });
  const cliArtifact = `${api.ALLOWED_SCOPE.slice(1)}-skillshelf-${config.version}.tgz`;
  packages.push(publicationEntry(cli.name, cli.version, cliArtifact, cliBytes, api));
  const plan = publicationPlan(packages, api, packs.length, true);
  const review = `# SkillShelf release preparation\n\nStatus: **PREPARED LOCALLY / NOT PUBLISHED BY THIS TOOL**. The reviewed public distribution is \`${api.ALLOWED_SCOPE}\`, version \`${config.version}\`, tag \`${api.RELEASE_CHANNEL}\`, access \`public\`. Repository: ${api.REPOSITORY_URL}. Publication authorization does not make a local preparation a registry release.\n\nAll ${plan.packages.length} actual archives (${packs.length} skills, catalog and CLI) were read and validated before generating publication-plan.json. This tool never logs in, checks account credentials, calls a registry, or publishes. Existing files with different bytes are never overwritten.\n\n- [ ] Parent completes isolated compiler/tests, adversarial archive tests, cross-platform/offline flows and an installed CLI-bin smoke check.\n- [ ] Review all ${packs.length} full snapshots, upstream source commits/paths, licenses and original NOTICE files. Packaging does not redact skill bodies.\n- [ ] Review exact public CLI files; no source maps, secrets, local artifacts or skill bodies belong in that package.\n- [ ] Use only the ${plan.packages.length} exact files named by publication-plan.json; keep catalog.development.json, per-skill manifests and this local review out of npm packages.\n- [ ] Rebuild from a fresh empty output directory if any source or CLI bootstrap changes.\n- [ ] Parent handles the separately authorized remote release, using the reviewed release channel and public access.\n- [ ] Verify registry-downloaded bytes against each recorded SHA-512 SRI after release.\n\nRequired build order: packSkills -> copyCatalog -> npmPackCLI (actual tgz, --ignore-scripts) -> prepare. The CLI bootstrap was compared with the exact catalog accompanying these skill tarballs.\n`;
  const writes = [
    [path.join(output, cliArtifact), cliBytes],
    [path.join(output, 'RELEASE-REVIEW.md'), review],
    [path.join(output, 'publication-plan.json'), canonicalJson(plan) + '\n'],
  ];
  // Preflight every destination before writing any release output; final plan is written last.
  for (const [filename, data] of writes) await assertWritableFile(filename, data);
  for (const [filename, data] of writes) await writeUnchangedOrNew(filename, data);
  console.log(`Prepared publication-plan.json with ${plan.packages.length} actual verified packages (${api.ALLOWED_SCOPE}, ${config.version}, ${api.RELEASE_CHANNEL}/public). No publication or account access performed.`);
}
