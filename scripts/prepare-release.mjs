// Local preparation only: no npm process, account access, login, push or publish.
import path from 'node:path';
import { auditCliArchive } from './audit-cli-package.mjs';
import { argumentsFor, assertPublicationMetadata, assertReleaseConfig, assertWritableFile, catalogFor, modules, outputDirectory, publicationEntry, publicationPlan, readJsonFile, readRegularFile, root, runtimeFor, sourceAttribution, sourceFor, verifyCatalogArchive, writeUnchangedOrNew } from './lib.mjs';

const options = argumentsFor(process.argv.slice(2), { '--output': true, '--cli-tarball': true });
if (!options['--cli-tarball'] || !path.isAbsolute(options['--cli-tarball'])) throw new Error('--cli-tarball must name the actual npm-packed CLI tgz by absolute path (not dry-run JSON)');
const api = await modules();
const { validateCatalog, validatePublicCatalog, verifySkillArchive, canonicalJson, readTarball, parseJsonFile, inventory, digestManifest } = api;
const output = await outputDirectory(options['--output'], { existing: true });
const config = await readJsonFile(path.join(root, 'catalog/sources.json'));
assertReleaseConfig(config, api);
const catalog = validateCatalog(await readJsonFile(path.join(output, 'catalog.development.json')));
const publicCatalog = validatePublicCatalog(await readJsonFile(path.join(output, 'catalog.public.json')));
if (catalog.catalogVersion !== config.version || catalog.skills.length !== 16 || canonicalJson(catalog.skills.map(entry => entry.name).sort()) !== canonicalJson(config.skills.map(entry => entry.name).sort())) throw new Error('Pack output must contain the exact reviewed 16 skills and release version');
const stripped = { ...catalog, skills: catalog.skills.map(({ localArtifact, ...entry }) => entry) };
if (canonicalJson(stripped) !== canonicalJson(publicCatalog) || canonicalJson(catalogFor(config, stripped.skills)) !== canonicalJson(publicCatalog)) throw new Error('Public and development catalog metadata differ');

const packages = [];
for (const definition of config.skills) {
  const entry = catalog.skills.find(item => item.name === definition.name);
  const artifact = `artifacts/${definition.name}-${config.version}.tgz`;
  if (entry.localArtifact !== artifact || entry.version !== config.version) throw new Error('Use pack-skills.mjs in this output directory first; artifact identity mismatch');
  const expected = { id: definition.name, name: definition.name, title: definition.title, description: definition.description, useWhen: definition.useWhen, examples: definition.examples, category: definition.category, tags: definition.tags, collection: definition.collection, license: 'MIT', source: sourceFor(config, definition), status: definition.status, runtime: runtimeFor(definition.name) };
  for (const [key, value] of Object.entries(expected)) if (canonicalJson(entry[key] ?? null) !== canonicalJson(value)) throw new Error(`Source/catalog metadata drift: ${entry.name}/${key}`);
  const bytes = await readRegularFile(path.join(output, artifact));
  const verified = verifySkillArchive(bytes, entry), files = readTarball(bytes);
  const metadata = parseJsonFile(files.find(file => file.path === 'package/package.json'));
  assertPublicationMetadata(metadata, api);
  if (metadata.description !== definition.description || metadata.license !== entry.license || canonicalJson(metadata.files) !== canonicalJson(['skill/', 'skillshelf.manifest.json', 'LICENSE', 'NOTICE'])) throw new Error('Unexpected skill distribution metadata');
  const actualNotice = files.find(file => file.path === 'package/NOTICE');
  if (!actualNotice || !actualNotice.data.equals(await sourceAttribution(config, definition))) throw new Error('Source attribution was not preserved');
  // Source hash comparison is local only; never fetches upstream or executes skill code.
  const sourceFiles = await inventory(path.join(root, 'skills', entry.name, 'skill'));
  if (digestManifest(sourceFiles) !== entry.contentDigest || canonicalJson(sourceFiles) !== canonicalJson(verified.manifest.files)) throw new Error('Pack no longer matches the checked-in complete skill snapshot');
  if (entry.name === 'ui-ux-pro-max' && sourceFiles.length !== 74) throw new Error('UIUX snapshot must retain all 74 files');
  packages.push(publicationEntry(entry.packageName, entry.version, artifact, bytes, api));
}
const catalogArtifact = `catalog-${config.version}.tgz`, catalogBytes = await readRegularFile(path.join(output, catalogArtifact));
verifyCatalogArchive(catalogBytes, publicCatalog, api, { license: await readRegularFile(path.join(root, 'skills/skillshelf-web-search/skill/LICENSE')) });
packages.push(publicationEntry(`${api.ALLOWED_SCOPE}/skillshelf-catalog`, config.version, catalogArtifact, catalogBytes, api));
const partial = publicationPlan(packages, api);
if (canonicalJson(await readJsonFile(path.join(output, 'publication-plan.data.json'))) !== canonicalJson(partial)) throw new Error('Data publication plan does not match actual verified artifacts');

const cliBytes = await readRegularFile(options['--cli-tarball']);
const cli = await auditCliArchive(cliBytes, { api, expectedCatalog: publicCatalog });
const cliArtifact = `${api.ALLOWED_SCOPE.slice(1)}-skillshelf-${config.version}.tgz`;
packages.push(publicationEntry(cli.name, cli.version, cliArtifact, cliBytes, api));
const plan = publicationPlan(packages, api, true);
const review = `# SkillShelf release preparation\n\nStatus: **PREPARED LOCALLY / NOT PUBLISHED BY THIS TOOL**. The reviewed public distribution is \`${api.ALLOWED_SCOPE}\`, version \`${config.version}\`, tag \`${api.RELEASE_CHANNEL}\`, access \`public\`. Repository: ${api.REPOSITORY_URL}. Publication authorization does not make a local preparation a registry release.\n\nAll 18 actual archives (16 skills, catalog and CLI) were read and validated before generating publication-plan.json. This tool never logs in, checks account credentials, calls a registry, or publishes. Existing files with different bytes are never overwritten.\n\n- [ ] Parent completes isolated compiler/tests, adversarial archive tests, cross-platform/offline flows and an installed CLI-bin smoke check.\n- [ ] Review all 16 full snapshots, upstream source commits/paths, licenses and original NOTICE files. Packaging does not redact skill bodies.\n- [ ] Review exact public CLI files; no source maps, secrets, local artifacts or skill bodies belong in that package.\n- [ ] Use only the 18 exact files named by publication-plan.json; keep catalog.development.json, per-skill manifests and this local review out of npm packages.\n- [ ] Rebuild from a fresh empty output directory if any source or CLI bootstrap changes.\n- [ ] Parent handles the separately authorized remote release, retaining tag next and public access. Consumers must not be directed to latest for this preview.\n- [ ] Verify registry-downloaded bytes against each recorded SHA-512 SRI after release.\n\nRequired build order: packSkills -> copyCatalog -> npmPackCLI (actual tgz, --ignore-scripts) -> prepare. The CLI bootstrap was compared with the exact catalog accompanying these skill tarballs.\n`;
const writes = [
  [path.join(output, cliArtifact), cliBytes],
  [path.join(output, 'RELEASE-REVIEW.md'), review],
  [path.join(output, 'publication-plan.json'), canonicalJson(plan) + '\n'],
];
// Preflight every destination before writing any release output; final plan is written last.
for (const [filename, data] of writes) await assertWritableFile(filename, data);
for (const [filename, data] of writes) await writeUnchangedOrNew(filename, data);
console.log(`Prepared publication-plan.json with ${plan.packages.length} actual verified packages (${api.ALLOWED_SCOPE}, ${config.version}, next/public). No publication or account access performed.`);
