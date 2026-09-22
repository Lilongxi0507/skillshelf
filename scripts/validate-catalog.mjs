import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { argumentsFor, json, modules, root, runtimeFor } from './lib.mjs';
const options = argumentsFor(process.argv.slice(2), { '--catalog': true, '--development': false });
const { validatePublicCatalog, validateCatalog, verifySkillArchive, inventory, digestManifest, canonicalJson, validateSkillDocument } = await modules();
const catalogPath = path.resolve(options['--catalog'] || path.join(root, 'catalog/bootstrap.json'));
const catalog = (options['--development'] ? validateCatalog : validatePublicCatalog)(await json(catalogPath));
const config = await json(path.join(root, 'catalog/sources.json'));
if (catalog.skills.length !== 16 || canonicalJson(catalog.skills.map(item => item.id).sort()) !== canonicalJson(config.skills.map(item => item.name).sort())) throw new Error('Initial catalog must contain exact reviewed 16 names');
for (const entry of catalog.skills) {
  const files = await inventory(path.join(root, 'skills', entry.name, 'skill'));
  validateSkillDocument(await readFile(path.join(root,'skills',entry.name,'skill','SKILL.md')),entry.name);
  if (digestManifest(files) !== entry.contentDigest || files.length !== entry.fileCount || files.reduce((sum, file) => sum + file.size, 0) !== entry.unpackedSize || canonicalJson(entry.runtime) !== canonicalJson(runtimeFor(entry.name))) throw new Error(`Catalog content/runtime drift: ${entry.name}`);
  if (entry.name === 'ui-ux-pro-max' && files.length !== 74) throw new Error('UIUX snapshot lost resources');
  if (entry.localArtifact) {
    if (!options['--development']) throw new Error('Local artifact requires explicit development validation');
    const filename = path.join(path.dirname(catalogPath), entry.localArtifact);
    verifySkillArchive(await readFile(filename), entry);
  }
}
console.log(`Validated ${catalog.skills.length} complete snapshots and ${options['--development'] ? 'development artifacts' : 'public metadata-only bootstrap'}. Publication status: not published.`);
