import { lstat, mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { argumentsFor, assertPublicationMetadata, assertReleaseConfig, catalogFor, catalogNotice, integrityFor, licenseFor, makeTarball, modules, outputDirectory, publicationEntry, publicationMetadata, publicationPlan, readJsonFile, readRegularFile, root, runtimeFor, skillRootFor, sourceAttribution, sourceFor, verifyCatalogArchive, writeUnchangedOrNew } from './lib.mjs';

import { packDefinitions, packContents, packCatalog } from './packs.mjs';

const options = argumentsFor(process.argv.slice(2), { '--output': true, '--write-bootstrap': false });
const api = await modules();
const { inventory, digestManifest, canonicalJson, validateManifest, validatePublicCatalog, verifySkillArchive, readTarball, parseJsonFile, ALLOWED_SCOPE } = api;
const config = await readJsonFile(path.join(root, 'catalog/sources.json'));
assertReleaseConfig(config, api);
const output = await outputDirectory(options['--output']);
const entries = [], packages = [], packs = packDefinitions(config);
await mkdir(path.join(output, 'artifacts'), { mode: 0o700 });
for (const pack of packs) {
  const {manifest,contents,license,notice,metadata}=await packContents(config,pack,api);
  const packageName=`${ALLOWED_SCOPE}/skillshelf-pack-${pack.id}`;
  const packageMetadata={name:packageName,version:config.version,description:metadata.description,license:metadata.license,files:['skill/','skillshelf.manifest.json','LICENSE','NOTICE'],...publicationMetadata(api)};
  const bytes=makeTarball([{path:'package/package.json',data:canonicalJson(packageMetadata)+'\n'},{path:'package/skillshelf.manifest.json',data:canonicalJson(manifest)+'\n'},{path:'package/LICENSE',data:license},{path:'package/NOTICE',data:notice},...contents.map(file=>({...file,path:'package/skill/'+file.path}))]);
  const entry={...metadata,packageName,version:config.version,integrity:integrityFor(bytes),contentDigest:manifest.contentDigest,fileCount:manifest.files.length,unpackedSize:manifest.files.reduce((sum,file)=>sum+file.size,0)};
  verifySkillArchive(bytes,entry);
  const artifact=`artifacts/${pack.id}-${config.version}.tgz`;
  await writeUnchangedOrNew(path.join(output,artifact),bytes);
  await writeUnchangedOrNew(path.join(output,pack.id+'.manifest.json'),canonicalJson(manifest)+'\n');
  const onDisk=await readRegularFile(path.join(output,artifact));verifySkillArchive(onDisk,entry);
  entries.push({...entry,localArtifact:artifact});packages.push(publicationEntry(packageName,config.version,artifact,onDisk,api));
  console.log(`${pack.id}: ${manifest.members.length} members, ${manifest.files.length} files, verified complete pack`);
}
const publicCatalog = validatePublicCatalog(packCatalog(config, entries.map(({ localArtifact, ...entry }) => entry)));
const developmentCatalog = { ...publicCatalog, skills: entries };
await writeUnchangedOrNew(path.join(output, 'catalog.public.json'), canonicalJson(publicCatalog) + '\n');
await writeUnchangedOrNew(path.join(output, 'catalog.development.json'), canonicalJson(developmentCatalog) + '\n');
const catalogMetadata = { name: `${ALLOWED_SCOPE}/skillshelf-catalog`, version: config.version, description: 'SkillShelf metadata-only catalog', license: 'MIT', files: ['catalog.json', 'LICENSE', 'NOTICE'], ...publicationMetadata(api) };
const catalogLicense = await readRegularFile(path.join(root, 'skills/skillshelf-web-search/skill/LICENSE'));
const catalogBytes = makeTarball([{ path: 'package/package.json', data: canonicalJson(catalogMetadata) + '\n' }, { path: 'package/catalog.json', data: canonicalJson(publicCatalog) + '\n' }, { path: 'package/LICENSE', data: catalogLicense }, { path: 'package/NOTICE', data: catalogNotice(api) }]);
verifyCatalogArchive(catalogBytes, publicCatalog, api, { license: catalogLicense });
const catalogArtifact = `catalog-${config.version}.tgz`;
await writeUnchangedOrNew(path.join(output, catalogArtifact), catalogBytes);
const onDiskCatalog = await readRegularFile(path.join(output, catalogArtifact));
verifyCatalogArchive(onDiskCatalog, publicCatalog, api, { license: catalogLicense });
packages.push(publicationEntry(catalogMetadata.name, config.version, catalogArtifact, onDiskCatalog, api));
// A separate partial plan avoids overwriting a different file when the CLI is added.
await writeUnchangedOrNew(path.join(output, 'publication-plan.data.json'), canonicalJson(publicationPlan(packages, api, packs.length)) + '\n');
if (options['--write-bootstrap']) {
  // This flag alone authorizes replacing generated checkout metadata, never skill content.
  const filename = path.join(root, 'catalog/bootstrap.json');
  const previous = await readRegularFile(filename, 4 * 1024 * 1024), before = await lstat(filename);
  const handle = await open(filename, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.ino !== before.ino || info.dev !== before.dev || !(await handle.readFile()).equals(previous)) throw new Error('Bootstrap changed during pack');
    const bytes = Buffer.from(canonicalJson(publicCatalog) + '\n');
    let written = 0;
    while (written < bytes.length) { const result = await handle.write(bytes, written, bytes.length - written, written); if (!result.bytesWritten) throw new Error('Incomplete bootstrap write'); written += result.bytesWritten; }
    await handle.truncate(bytes.length); await handle.sync();
  } finally { await handle.close(); }
  if (canonicalJson(validatePublicCatalog(await readJsonFile(filename))) !== canonicalJson(publicCatalog)) throw new Error('Bootstrap persisted bytes differ');
}
console.log(`Prepared and verified ${packs.length} data-only packages plus catalog in ${output}. No publication or account access performed. Next: copy-catalog, actual npm pack --ignore-scripts for CLI, then prepare-release --output <same directory> --cli-tarball <absolute tgz>.`);
