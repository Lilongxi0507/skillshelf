import { cp, mkdir, mkdtemp, readdir, rm, writeFile, readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { CatalogEntry, Context, MutationOptions, OperationResult, Release, SkillManifest, State } from '../types.js';
import { canonicalJson, digestManifest, inventory, validateManifest, verifyTree, safeRelativePath } from '../validation.js';
import { loadCatalog } from '../catalog/catalog.js';
import { acquireSkill, acquireLockedSkill, verifySkillArchive } from '../registry/registry.js';
import { readRegularFile } from '../registry/files.js';
import { ALLOWED_SCOPE, LIMITS, EXACT_VERSION, validateCatalog } from '../validation.js';
import { exists, ensurePrivateDir, readJson, writeJson, within, canonicalPath } from '../store/fs.js';
import { getRelease, loadState, releaseKey, storePath } from '../store/state.js';
import { importTree, chmodTree } from '../store/local.js';
import { transact } from '../transactions/transaction.js';
import { withMutation } from '../transactions/operations.js';
import { fail } from '../errors.js';
import { publicEntry, projectChanges } from '../manager.js';

interface ExportSelection { id:string; name:string; version:string; integrity:string; packageName:string; contentDigest:string; pinned:boolean; entry?:CatalogEntry; manifest:SkillManifest; directory?:string; artifact?:string }
function artifactName(digest:string,integrity:string):string{return `${digest}-${createHash('sha256').update(integrity).digest('hex').slice(0,16)}.tgz`;}
function checkedEntry(s:ExportSelection):CatalogEntry|undefined{
  if(!s.entry)return undefined;const e=s.entry;
  const entry=validateCatalog({schemaVersion:1,catalogVersion:'0.1.0-preview.1',minCliVersion:'0.1.0-preview.1',scope:ALLOWED_SCOPE,categories:[{id:e.category,title:e.category}],collections:[{id:e.collection,title:e.collection,description:'Explicit import',skills:[e.id]}],skills:[e]}).skills[0]!;
  if(entry.localArtifact||entry.id!==s.id||entry.name!==s.name||entry.version!==s.version||entry.packageName!==s.packageName||entry.integrity!==s.integrity||entry.contentDigest!==s.contentDigest||canonicalJson(entry.runtime)!==canonicalJson(s.manifest.runtime))fail('INTEGRITY','导入版本快照不一致');return entry;
}
interface Portable { schemaVersion:1; format:'skillshelf-selection'|'skillshelf-bundle'; createdAt:string; skills:ExportSelection[]; agents:Array<{agent:string;label:string;mode:string}> }
export async function exportLibrary(ctx:Context,output:string,options:MutationOptions&{bundle?:boolean;ids?:string[]}={}):Promise<OperationResult>{
  const state=await loadState(ctx),scope=options.project?resolve(options.project):'global',selected=scope==='global'?state.selections:state.projects[scope]?.selections||{};
  const ids=options.ids?.length?options.ids:Object.keys(selected),destination=resolve(output);if(await exists(destination))fail('CONFLICT','导出目标必须不存在');if(within(ctx.home,destination))fail('CONFLICT','导出请使用受管目录以外的位置');
  const skills:ExportSelection[]=ids.map(id=>{const s=selected[id];if(!s)fail('USAGE','范围内未安装：'+id);const r=state.releases[s.releaseKey]!;return{id:r.id,name:r.name,version:r.version,integrity:r.integrity,packageName:r.packageName,contentDigest:r.contentDigest,pinned:s.pinned,entry:r.catalogEntry?publicEntry(r.catalogEntry):undefined,manifest:r.manifest,directory:options.bundle?'contents/'+r.contentDigest+'/skill':undefined,artifact:options.bundle&&r.catalogEntry?'artifacts/'+artifactName(r.contentDigest,r.integrity):undefined};});
  const data:Portable={schemaVersion:1,format:options.bundle?'skillshelf-bundle':'skillshelf-selection',createdAt:new Date().toISOString(),skills,agents:Object.values(state.targets).filter(t=>t.scope===scope).map(t=>({agent:t.agent,label:t.label,mode:t.mode}))};
  if(options.dryRun)return{output:destination,bundle:!!options.bundle,skills:ids,dryRun:true};
  for(const s of skills)await verifyTree(storePath(ctx,s.contentDigest),s.manifest);
  await ensurePrivateDir(dirname(destination));
  if(!options.bundle){await writeFile(destination,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});return{path:destination,skills:ids,secrets:false};}
  const staging=await mkdtemp(join(dirname(destination),'.skillshelf-export-'));
  try{
    for(const s of skills){const path=join(staging,s.directory!);await ensurePrivateDir(dirname(path));await cp(storePath(ctx,s.contentDigest),path,{recursive:true,dereference:false,errorOnExist:true,force:false});await verifyTree(path,s.manifest);
      if(s.artifact&&s.entry){const bytes=await readRegularFile(join(ctx.home,'artifacts',artifactName(s.contentDigest,s.integrity)),LIMITS.archiveBytes);const checked=await verifySkillArchive(bytes,s.entry);if(canonicalJson(checked.manifest)!==canonicalJson(s.manifest))fail('INTEGRITY','导出的原始包清单不一致');await ensurePrivateDir(join(staging,'artifacts'));await writeFile(join(staging,s.artifact),bytes,{flag:'wx',mode:0o600});}
    }
    await writeFile(join(staging,'skillshelf-export.json'),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
    await rename(staging,destination);
  }finally{if(await exists(staging)){await chmodTree(staging,false);await rm(staging,{recursive:true});}}
  return{path:destination,skills:ids,secrets:false,requiresNodeAndCLI:true};
}
function parsePortable(value:unknown):Portable{
  const p=value as Portable;if(!p||p.schemaVersion!==1||!['skillshelf-selection','skillshelf-bundle'].includes(p.format)||!Array.isArray(p.skills)||p.skills.length>2000)fail('INTEGRITY','导入格式无效');
  const seen=new Set<string>();
  for(const s of p.skills){if(!s||!s.id||seen.has(s.id)||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.id)||s.id.length>64)fail('INTEGRITY','导入技能ID无效/重复');seen.add(s.id);validateManifest(s.manifest);if(!EXACT_VERSION.test(s.version)||typeof s.pinned!=='boolean'||s.manifest.id!==s.id||s.manifest.name!==s.name||s.manifest.contentDigest!==s.contentDigest)fail('INTEGRITY','导入清单身份不一致');if(s.directory)safeRelativePath(s.directory);if(s.artifact)safeRelativePath(s.artifact);checkedEntry(s);}
  return p;
}
export async function importLibrary(ctx:Context,input:string,options:MutationOptions={}):Promise<OperationResult>{return withMutation(ctx,options,()=>importLibraryInternal(ctx,input,options));}
async function importLibraryInternal(ctx:Context,input:string,options:MutationOptions={}):Promise<OperationResult>{
  const source=resolve(input),isDirectory=await exists(join(source,'skillshelf-export.json')),data=parsePortable(await readJson(isDirectory?join(source,'skillshelf-export.json'):source));
  if(data.format==='skillshelf-bundle'&&!isDirectory)fail('INTEGRITY','完整导入需要包含内容的目录');
  const state=await loadState(ctx),next=structuredClone(state),catalog=await loadCatalog(ctx);const scope=options.project?resolve(options.project):'global';
  const selected={...(scope==='global'?next.selections:next.projects[scope]?.selections||{})};
  for(const s of data.skills)if(selected[s.id]&&state.releases[selected[s.id]!.releaseKey]!.contentDigest!==s.contentDigest)fail('CONFLICT','本机已选择不同版本，请先卸载/选择独立项目：'+s.id);
  if(options.dryRun)return{skills:data.skills.map(s=>({id:s.id,version:s.version})),scope,bundle:data.format==='skillshelf-bundle',agentPathsWillNotBeCopied:true,dryRun:true};
  const imported:string[]=[];
  for(const s of data.skills){
    // Bundle claims and their hashes are untrusted: only locally trusted catalog authority may authorize execution.
    const claimed=checkedEntry(s);
    const trusted=catalog.skills.find(e=>e.id===s.id&&e.name===s.name&&e.version===s.version&&e.packageName===s.packageName&&e.integrity===s.integrity&&e.contentDigest===s.contentDigest&&canonicalJson(e.runtime)===canonicalJson(s.manifest.runtime));
    let verifiedNpm=false;
    if(data.format==='skillshelf-bundle'){
      if(!s.directory)fail('INTEGRITY','导入技能缺少内容目录');const tree=join(source,s.directory);if(!within(source,tree)||await canonicalPath(tree)!==tree)fail('INTEGRITY','导入路径越界或包含目录链接');await importTree(ctx,tree,s.manifest);
      if(trusted&&s.artifact){if(await canonicalPath(join(source,s.artifact))!==join(source,s.artifact))fail('INTEGRITY','原始包路径包含目录链接');const bytes=await readRegularFile(join(source,s.artifact),LIMITS.archiveBytes);const verified=await verifySkillArchive(bytes,trusted);if(canonicalJson(verified.manifest)!==canonicalJson(s.manifest))fail('INTEGRITY','原始包与导入内容清单不一致');const destination=join(ctx.home,'artifacts',artifactName(s.contentDigest,s.integrity));await ensurePrivateDir(dirname(destination));if(await exists(destination))await verifySkillArchive(await readRegularFile(destination,LIMITS.archiveBytes),trusted);else await writeFile(destination,bytes,{flag:'wx',mode:0o444});verifiedNpm=true;}
    }else{if(!trusted)fail('UNAVAILABLE','选择清单所需精确版本没有完整的锁定元数据；请使用bundle：'+s.id);const acquired=await acquireLockedSkill(ctx,trusted);if(canonicalJson(acquired.manifest)!==canonicalJson(s.manifest))fail('INTEGRITY','选择清单manifest与精确包不匹配');verifiedNpm=true;}
    const key=releaseKey(s.id,s.version,s.contentDigest);next.releases[key]={key,id:s.id,name:s.name,version:s.version,packageName:verifiedNpm?trusted!.packageName:'local:'+s.id,integrity:verifiedNpm?trusted!.integrity:'',contentDigest:s.contentDigest,manifest:s.manifest,source:verifiedNpm?trusted!.source:{},installedAt:new Date().toISOString(),origin:verifiedNpm?'npm':'local',catalogEntry:verifiedNpm?publicEntry(trusted!):undefined};
    selected[s.id]={releaseKey:key,pinned:s.pinned,history:(selected[s.id]?.history||[]).filter(k=>k!==key)};imported.push(s.id);
  }
  if(scope==='global')next.selections=selected;else next.projects[scope]={...next.projects[scope],root:scope,specPath:join(scope,'skillshelf.json'),lockPath:join(scope,'skillshelf-lock.json'),selections:selected};
  await transact(ctx,state,next,await projectChanges(state,next,scope,catalog.catalogVersion));return{imported,scope,agentPathsCopied:false,next:'运行 enable 或 setup 确认本机Agent路径；本地来源不会自动执行',secretsImported:false};
}
export async function migratePanel(ctx:Context,from:string,options:MutationOptions={}):Promise<OperationResult>{return withMutation(ctx,options,()=>migratePanelInternal(ctx,from,options));}
async function migratePanelInternal(ctx:Context,from:string,options:MutationOptions={}):Promise<OperationResult>{
  const root=resolve(from),profiles=await exists(join(root,'profiles'))?(await readdir(join(root,'profiles'))).map(name=>join(root,'profiles',name)):[root];
  const state=await loadState(ctx),next=structuredClone(state),catalog=await loadCatalog(ctx),imported:Array<{id:string;version:string;files:number;modified:boolean;source:string}>=[],skipped:Array<{name:string;reason:string;source:string}>=[];
  for(const profile of profiles){const statePath=join(profile,'state.json');if(!(await exists(statePath)))continue;const legacy=await readJson<{target:string;managed:Record<string,{revision:string;hashes:Record<string,string>}>}>(statePath);if(!legacy.target||!legacy.managed)fail('INTEGRITY','旧状态格式无效');
    for(const[name,managed]of Object.entries(legacy.managed)){
      safeRelativePath(name);if(name.includes('/'))fail('INTEGRITY','旧技能名不能含目录');const tree=join(legacy.target,name),files=await inventory(tree);const hashes=Object.fromEntries(files.map(f=>[f.path,f.sha256]));const modified=canonicalJson(hashes)!==canonicalJson(managed.hashes);const digest=digestManifest(files);
      if(!files.some(f=>/^LICENSE(?:\.md|\.txt)?$/i.test(f.path))){skipped.push({name,source:tree,reason:'missing-license：保留旧内容，请安装已授权的SkillShelf新版；不会自动添加许可证'});continue;}
      const front=(await readFile(join(tree,'SKILL.md'),'utf8')).match(/^---\r?\n([\s\S]*?)\r?\n---/);if(!front)fail('INTEGRITY','旧技能没有frontmatter');const metadata=parseYaml(front[1]!)as{name?:string};if(metadata.name!==name)fail('INTEGRITY','旧状态与SKILL名称不一致');
      const trusted=catalog.skills.find(e=>e.name===name&&e.contentDigest===digest);const id=trusted?.id||name,version=trusted?.version||'0.0.0-local.'+digest.slice(0,12);
      imported.push({id,version,files:files.length,modified,source:tree});if(options.dryRun)continue;
      if(next.selections[id]&&next.releases[next.selections[id]!.releaseKey]!.contentDigest!==digest)fail('CONFLICT','新库已存在不同技能，拒绝覆盖：'+id);
      const manifest:SkillManifest={schemaVersion:1,id,name,files,contentDigest:digest,runtime:trusted?.runtime||{kind:'instructions',requiresNetwork:false}};
      await importTree(ctx,tree,manifest);const key=releaseKey(id,version,digest);next.releases[key]={key,id,name,version,packageName:'local:'+id,integrity:'',contentDigest:digest,manifest,source:{panelRevision:managed.revision},installedAt:new Date().toISOString(),origin:'panel'};next.selections[id]={releaseKey:key,pinned:true,history:[]};
    }
  }
  if(!options.dryRun)await transact(ctx,state,next,[]);
  return{imported,skipped,dryRun:!!options.dryRun,legacyChanged:false,credentialsRead:false,agentPathsChanged:false,next:'只导入本地内容；旧目标仍由旧客户端管理，未接管'};
}
