import path from 'node:path';
import { createHash } from 'node:crypto';
import { categories, curatedMetadata } from '../catalog/curation.mjs';
import { skillRootFor, sourceFor, sourceAttribution, runtimeFor, licenseFor, readRegularFile } from './lib.mjs';

export function packDefinitions(config) {
  const groups=new Map();
  for(const definition of config.skills){const id=definition.source==='first-party'?definition.name:({matt:'matt-pocock',uiux:'ui-ux-pro-max'}[definition.source]||definition.source);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(definition);}
  return [...groups].map(([id,definitions])=>({id,definitions}));
}
export function packCatalog(config,skills) {
  return {schemaVersion:2,catalogVersion:config.version,minCliVersion:config.version,scope:config.scope,categories,collections:skills.map(entry=>({id:entry.id,title:entry.title,description:entry.description,skills:[entry.id]})),skills};
}
export async function packContents(config,pack,api) {
  const contents=[],members=[];
  for(const definition of pack.definitions){
    const root=skillRootFor(definition),files=await api.inventory(root);
    api.validateSkillDocument(await readRegularFile(path.join(root,'SKILL.md')),definition.name);
    const member={id:definition.name,name:definition.name,legacyId:definition.name,path:definition.path,title:definition.title,...curatedMetadata(definition.name),tags:definition.tags,license:licenseFor(definition),source:sourceFor(config,definition),runtime:runtimeFor(definition.name)};
    members.push(member);
    for(const file of files)contents.push({path:member.path+'/'+file.path,data:await readRegularFile(path.join(root,file.path)),executable:file.executable});
  }
  const first=pack.definitions[0],license=await readRegularFile(path.join(skillRootFor(first),'LICENSE'));
  const notices=await Promise.all(pack.definitions.map(definition=>sourceAttribution(config,definition)));
  const notice=Buffer.concat(notices.flatMap(bytes=>[bytes,Buffer.from('\n')]));
  contents.push({path:'LICENSE',data:license,executable:false},{path:'NOTICE',data:notice,executable:false});
  const files=contents.map(file=>({path:file.path,size:file.data.length,sha256:createHash('sha256').update(file.data).digest('hex'),executable:file.executable}));
  const runtime=members.length===1?{...members[0].runtime,...(members[0].runtime.entrypoint?{entrypoint:members[0].path+'/'+members[0].runtime.entrypoint}:{})}:{kind:'instructions',requiresNetwork:false};
  const manifest={schemaVersion:2,id:pack.id,name:pack.id,members,files,contentDigest:'0'.repeat(64),runtime};
  manifest.contentDigest=api.digestPackManifest(manifest);
  const validatedManifest = api.validateManifest(manifest);
  const licenses=[...new Set(members.map(member=>member.license))];
  const metadata={id:pack.id,name:pack.id,kind:'pack',members,title:pack.id+' · '+members.length+' 项完整技能',description:members.map(member=>member.title).join('、')+'；保留完整资源及上游成员布局。',useWhen:'需要此来源的完整技能与共享资源时安装整个包。',examples:members.slice(0,3).flatMap(member=>member.examples),category:members[0].category,tags:[...new Set(members.flatMap(member=>member.tags))].slice(0,128),collection:pack.id,license:licenses.length===1?licenses[0]:'SEE LICENSE IN skill/NOTICE',source:sourceFor(config,first),status:'stable',runtime};
  return{manifest:validatedManifest,contents,license,notice,metadata};
}
