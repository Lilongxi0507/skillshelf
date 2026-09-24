import path from 'node:path';
import { argumentsFor, json, modules, root, readRegularFile } from './lib.mjs';
import { packDefinitions, packContents } from './packs.mjs';
const options=argumentsFor(process.argv.slice(2),{'--catalog':true,'--development':false});
const api=await modules();
const filename=path.resolve(options['--catalog']||path.join(root,'catalog/bootstrap.json'));
const catalog=(options['--development']?api.validateCatalog:api.validatePublicCatalog)(await json(filename));
const config=await json(path.join(root,'catalog/sources.json')),packs=packDefinitions(config);
if(api.canonicalJson(catalog.skills.map(entry=>entry.id).sort())!==api.canonicalJson(packs.map(pack=>pack.id).sort()))throw new Error('Catalog must contain exactly the reviewed complete packs');
for(const pack of packs){const entry=catalog.skills.find(entry=>entry.id===pack.id),{manifest,metadata}=await packContents(config,pack,api);
  if(entry.contentDigest!==manifest.contentDigest||entry.fileCount!==manifest.files.length||entry.unpackedSize!==manifest.files.reduce((sum,file)=>sum+file.size,0))throw new Error('Pack content drift: '+pack.id);
  for(const [key,value]of Object.entries(metadata))if(api.canonicalJson(entry[key])!==api.canonicalJson(value))throw new Error('Pack metadata drift: '+pack.id+'/'+key);
  if(entry.localArtifact)api.verifySkillArchive(await readRegularFile(path.join(path.dirname(filename),entry.localArtifact)),entry);
}
console.log(`Validated ${packs.length} complete packs, ${catalog.skills.reduce((sum,entry)=>sum+entry.members.length,0)} members; metadata-only catalog. Not published.`);
