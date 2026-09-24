import { after } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { root, modules, json, skillRootFor, runtimeFor, licenseFor, sourceFor, makeTarball, integrityFor, catalogFor } from '../scripts/lib.mjs';

export async function legacyCatalogFixture(filename) {
  if(!filename)return undefined;
  const selected=await json(filename);if(selected.schemaVersion===1)return filename;
  const directory=await mkdtemp(path.join(process.env.SKILLSHELF_TEST_TMP||tmpdir(),'skillshelf-v1-compatibility-'));
  after(()=>rm(directory,{recursive:true,force:true}));
  const api=await modules(),config=await json(path.join(root,'catalog/sources.json')),entries=[];
  for(const definition of config.skills){
    const source=skillRootFor(definition),files=await api.inventory(source),runtime=runtimeFor(definition.name),manifest={schemaVersion:1,id:definition.name,name:definition.name,files,contentDigest:api.digestManifest(files),runtime};
    const packageName=`${config.scope}/skillshelf-skill-${definition.name}`,license=await readFile(path.join(source,'LICENSE'));
    const bytes=makeTarball([{path:'package/package.json',data:JSON.stringify({name:packageName,version:config.version,license:licenseFor(definition),files:['skill/','skillshelf.manifest.json','LICENSE']})},{path:'package/skillshelf.manifest.json',data:JSON.stringify(manifest)},{path:'package/LICENSE',data:license},...await Promise.all(files.map(async file=>({path:'package/skill/'+file.path,data:await readFile(path.join(source,file.path)),executable:file.executable})))]);
    const artifact=definition.name+'.tgz';await writeFile(path.join(directory,artifact),bytes);
    entries.push({id:definition.name,name:definition.name,title:definition.title,description:definition.description,useWhen:definition.useWhen,examples:definition.examples,category:definition.category,tags:definition.tags,collection:definition.collection,license:licenseFor(definition),source:sourceFor(config,definition),status:definition.status,runtime,packageName,version:config.version,integrity:integrityFor(bytes),contentDigest:manifest.contentDigest,fileCount:files.length,unpackedSize:files.reduce((sum,file)=>sum+file.size,0),localArtifact:artifact});
  }
  const catalog=api.validateCatalog(catalogFor(config,entries)),output=path.join(directory,'catalog-v1.json');await writeFile(output,JSON.stringify(catalog));return output;
}
