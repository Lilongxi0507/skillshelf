import { readFile, readdir, cp, mkdir, lstat, rm, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { chmodTree } from './store/local.js';
import type { AgentId, AgentTarget, Catalog, CatalogEntry, Context, MutationOptions, OperationResult, ProjectLock, ProjectRecord, ProjectSpec, Release, Selection, State } from './types.js';
import { loadCatalog, refreshCatalog, searchCatalog, fetchLatestCatalog } from './catalog/catalog.js';
import { acquireSkill, acquireLockedSkill } from './registry/registry.js';
import { detectAgents, resolveAgentTarget, agentHints } from './agents/agents.js';
import { validateHomeLocation } from './agents/storage-boundary.js';
import { verifyTree, safeRelativePath, inventory, canonicalJson, EXACT_VERSION } from './validation.js';
import { z } from 'zod';
import { exists, fingerprint, canonicalPath, atomicWrite, writeJson, readJson, keyFor, within } from './store/fs.js';
import { getRelease, loadState, releaseKey, storePath } from './store/state.js';
import { projectionChange, projectionKey, validateTargetPath, checkProjection, desiredMode } from './store/projections.js';
import { transact, targetWorkRoot, pendingTransactions, type Change } from './transactions/transaction.js';
import { fail, errorMessage } from './errors.js';
import { withMutation } from './transactions/operations.js';
import { runtimeDoctor } from './runtime/runtime.js';

export function publicEntry(entry:CatalogEntry):CatalogEntry { const {localArtifact:_,...clean}=entry;return clean; }
const agentIds: AgentId[]=['claude-code','codex','opencode','dsh','cursor','hermes','universal','custom'];
function scopeOf(options:MutationOptions):string{return options.project?resolve(options.project):'global';}
function selections(state:State,scope:string):Record<string,Selection>{return scope==='global'?state.selections:state.projects[scope]?.selections||{};}
function setSelections(state:State,scope:string,value:Record<string,Selection>):void{
  if(scope==='global'){state.selections=value;return;}
  state.projects[scope]={...state.projects[scope],root:scope,specPath:join(scope,'skillshelf.json'),lockPath:join(scope,'skillshelf-lock.json'),selections:value};
}
function activeTargets(state:State,scope:string):AgentTarget[]{return Object.values(state.targets).filter(t=>t.scope===scope);}
function chooseEntries(catalog:Catalog,ids:string[],collection?:string):CatalogEntry[]{
  const names=[...ids]; if(collection){const group=catalog.collections.find(g=>g.id===collection);if(!group)fail('USAGE','精选组合不存在：'+collection);names.push(...group.skills);}
  if(!names.length)fail('USAGE','请指定技能或精选组合');
  return [...new Set(names)].map(id=>{const entry=catalog.skills.find(x=>x.id===id||x.name===id);if(!entry)fail('USAGE','精选目录没有此技能：'+id);return entry;});
}
async function resolveTargets(state:State,scope:string,requested?:string[],mode?:'auto'|'link'|'copy'):Promise<AgentTarget[]>{
  if(requested&&requested.length===0)return [];
  if(!requested){const targets=activeTargets(state,scope).map(t=>mode?{...t,mode}:t);for(const target of targets){await validateTargetPath(target);state.targets[target.id]=target;}return targets;}
  const result:AgentTarget[]=[];
  for(const id of requested){
    let target=state.targets[id];
    if(target&&target.scope!==scope)fail('USAGE','Agent目标不属于当前范围：'+id);
    if(!target){if(!agentIds.includes(id as AgentId)||id==='custom')fail('USAGE','未知Agent目标，请先 agents add：'+id);target=await resolveAgentTarget(id as AgentId,{project:scope==='global'?undefined:scope,mode});}
    if(mode)target={...target,mode};state.targets[target.id]=target;result.push(target);
  }
  for(const t of result)await validateTargetPath(t);
  return result;
}
export async function projectChanges(state:State,next:State,scope:string,catalogVersion:string):Promise<Change[]>{
  if(scope==='global')return[];
  if(!next.projects[scope])setSelections(next,scope,{});
  const selected=selections(next,scope),targets=activeTargets(next,scope);
  const agents:ProjectSpec['agents']=targets.map(t=>{const rel=relative(scope,t.path);if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\'))fail('CONFLICT','项目Agent目标必须位于项目内：'+t.path);return{agent:t.agent,relativePath:rel.split('\\').join('/'),mode:t.mode,skills:Object.values(next.projections).filter(p=>p.targetIds.includes(t.id)).map(p=>next.releases[p.releaseKey]!.id).sort()};});
  const spec:ProjectSpec={schemaVersion:1,skills:Object.fromEntries(Object.entries(selected).map(([id,s])=>[id,{version:next.releases[s.releaseKey]!.version,pinned:s.pinned}])),agents};
  const lock:ProjectLock={schemaVersion:1,catalogVersion,skills:Object.values(selected).map(s=>{const r=next.releases[s.releaseKey]!;return{id:r.id,name:r.name,packageName:r.packageName,version:r.version,integrity:r.integrity,contentDigest:r.contentDigest,entry:r.catalogEntry?publicEntry(r.catalogEntry):undefined};}),agents};
  const result:Change[]=[];
  for(const [name,data]of [['skillshelf.json',spec],['skillshelf-lock.json',lock]]as const){
    const path=join(scope,name);const expected=await fingerprint(path);
    const hashField=name==='skillshelf.json'?'specHash':'lockHash';
    const prior=state.projects[scope]?.[hashField];
    if(expected&&!prior)fail('CONFLICT','项目文件尚未登记，请先 sync --frozen 显式导入：'+path);
    if(prior&&prior!==expected)fail('CONFLICT','项目文件有本地修改，请确认后使用 sync --frozen：'+path);
    const bytes=JSON.stringify(data,null,2)+'\n';next.projects[scope]![hashField]='file:'+createHash('sha256').update(bytes).digest('hex');if(expected&&await readFile(path,'utf8')===bytes)continue;
    result.push({path,expected,workRoot:join(scope,'.skillshelf-work'),prepare:async stage=>{await writeFile(stage,bytes,{flag:'wx',mode:0o600});}});
  }
  return result;
}
async function reconcile(ctx:Context,state:State,next:State,scope:string,ids:Set<string>,attach:AgentTarget[]=[],detachIds:Set<string>=new Set(),attachIds?:Map<string,Set<string>>):Promise<Change[]>{
  const desired=new Map<string,{release:Release;targets:AgentTarget[]}>();
  for(const projection of Object.values(state.projections)){
    const old=state.releases[projection.releaseKey]!;let refs=projection.targetIds.map(id=>next.targets[id]).filter((t):t is AgentTarget=>!!t&&!detachIds.has(t.id));
    for(const target of refs){
      let release=old;
      if(target.scope===scope&&ids.has(old.id)){const s=selections(next,scope)[old.id];if(!s)continue;release=next.releases[s.releaseKey]!;}
      const current=desired.get(projection.path);if(current&&current.release.key!==release.key)fail('CONFLICT','共享物理目标被要求安装不同版本：'+projection.path);
      desired.set(projection.path,{release,targets:[...(current?.targets||[]),target]});
    }
  }
  for(const target of attach){
    await validateTargetPath(target);
    for(const id of attachIds?.get(target.id)||ids){const choice=selections(next,scope)[id];if(!choice)continue;const release=next.releases[choice.releaseKey]!;const path=join(target.path,release.name);const current=desired.get(path);
      if(current&&current.release.key!==release.key)fail('CONFLICT','同一目标存在不同版本：'+path);
      desired.set(path,{release,targets:[...(current?.targets||[]),target]});
    }
  }
  const paths=new Set([...Object.values(state.projections).map(p=>p.path),...desired.keys()]);const changes:Change[]=[];
  for(const path of paths){const item=desired.get(path);const old=state.projections[projectionKey(path)];
    // Unaffected paths need not re-verify, but all paths participating in the operation do.
    const mode=item?desiredMode(item.targets):undefined;
    if(old&&item&&old.releaseKey===item.release.key&&(mode==='auto'||mode===old.mode)&&JSON.stringify([...old.targetIds].sort())===JSON.stringify([...new Set(item.targets.map(t=>t.id))].sort()))continue;
    const change=await projectionChange(ctx,state,next,path,item?.release||null,item?.targets||[]);if(change)changes.push(change);
  }
  return changes;
}
export async function listSkills(ctx:Context,query='',filters:{category?:string;collection?:string;installed?:boolean}={}):Promise<OperationResult>{
  const[catalog,state]=await Promise.all([loadCatalog(ctx),loadState(ctx)]);
  return{catalogVersion:catalog.catalogVersion,source:ctx.catalogPath?'local-catalog':'local-snapshot',skills:searchCatalog(catalog,query,{category:filters.category,collection:filters.collection,installed:filters.installed?Object.keys(state.selections):undefined}).map(entry=>({...entry,installed:state.selections[entry.id]?{version:state.releases[state.selections[entry.id]!.releaseKey]!.version,pinned:state.selections[entry.id]!.pinned}:null}))};
}
export async function installSkills(ctx:Context,ids:string[],options:MutationOptions&{collection?:string}={}):Promise<OperationResult>{return withMutation(ctx,options,()=>installSkillsInternal(ctx,ids,options));}
async function installSkillsInternal(ctx:Context,ids:string[],options:MutationOptions&{collection?:string}={}):Promise<OperationResult>{
  const catalog=await loadCatalog(ctx),state=await loadState(ctx),next=structuredClone(state),scope=scopeOf(options);
  const entries=chooseEntries(catalog,ids,options.collection);const targets=await resolveTargets(next,scope,options.agents,options.mode);
  await validateHomeLocation(ctx,Object.values(next.targets),{projects:scope==='global'?[]:[scope]});
  const preview={scope,skills:entries.map(e=>({id:e.id,version:e.version,files:e.fileCount,bytes:e.unpackedSize})),targets:targets.map(t=>({id:t.id,path:t.path,mode:t.mode,hints:agentHints(t)})),downloadOnly:targets.length===0};
  // Preview catches pins and unmanaged collisions before acquiring packages.
  for(const entry of entries){const existing=selections(state,scope)[entry.id];if(existing?.pinned&&existing.releaseKey!==releaseKey(entry.id,entry.version,entry.contentDigest))fail('CONFLICT','技能已固定，请先 unpin 再更换版本：'+entry.id);}
  for(const t of targets)for(const e of entries){const path=join(t.path,e.name),old=state.projections[projectionKey(path)];if(!old&&await exists(path))fail('CONFLICT','已有同名非受管技能：'+path);if(old)await checkProjection(ctx,old,state.releases[old.releaseKey]!);}
  if(options.dryRun)return{...preview,dryRun:true};
  const selected={...selections(next,scope)};
  for(const entry of entries){
    const acquired=await acquireSkill(ctx,entry);const key=releaseKey(entry.id,entry.version,entry.contentDigest);
    const release:Release={key,id:entry.id,name:entry.name,version:entry.version,packageName:entry.packageName,integrity:entry.integrity,contentDigest:entry.contentDigest,manifest:acquired.manifest,source:entry.source,installedAt:new Date().toISOString(),origin:'npm',catalogEntry:publicEntry(entry)};
    next.releases[key]=release;const old=selected[entry.id];
    if(old?.pinned&&old.releaseKey!==key)fail('CONFLICT','技能已固定，请先 unpin 再更换版本：'+entry.id);
    selected[entry.id]={releaseKey:key,pinned:old?.pinned||false,history:[...new Set([...(old?.history||[]),...(old&&old.releaseKey!==key?[old.releaseKey]:[])])].filter(k=>k!==key)};
  }
  setSelections(next,scope,selected);
  const changes=await reconcile(ctx,state,next,scope,new Set(entries.map(e=>e.id)),targets);
  changes.push(...await projectChanges(state,next,scope,catalog.catalogVersion));await transact(ctx,state,next,changes);
  return{...preview,installed:entries.map(e=>({id:e.id,path:storePath(ctx,e.contentDigest),version:e.version,files:e.fileCount})),projections:Object.values(next.projections).filter(p=>entries.some(e=>e.id===next.releases[p.releaseKey]?.id)),discovery:'unverified'};
}
export async function addAgent(ctx:Context,agent:AgentId,options:MutationOptions&{path?:string;label?:string}={}):Promise<OperationResult>{
  const target=await resolveAgentTarget(agent,{project:options.project,path:options.path,label:options.label,mode:options.mode});await validateTargetPath(target);
  const state=await loadState(ctx),next=structuredClone(state);await validateHomeLocation(ctx,[...Object.values(next.targets),target]);if(options.dryRun)return{target,hints:agentHints(target),dryRun:true};
  next.targets[target.id]=target;const changes=await reconcile(ctx,state,next,target.scope,new Set());if(target.scope!=='global')changes.push(...await projectChanges(state,next,target.scope,(await loadCatalog(ctx)).catalogVersion));await transact(ctx,state,next,changes);return{target,hints:agentHints(target)};
}
export async function listAgents(ctx:Context,detect=false):Promise<OperationResult>{return{registered:Object.values((await loadState(ctx)).targets),detected:detect?await detectAgents():undefined};}
export async function removeAgent(ctx:Context,id:string,options:MutationOptions={}):Promise<OperationResult>{
  const state=await loadState(ctx),next=structuredClone(state),target=state.targets[id];if(!target)fail('USAGE','未注册此Agent目标');
  const preview={target,affected:Object.values(state.projections).filter(p=>p.targetIds.includes(id)).map(p=>p.path)};if(options.dryRun)return{...preview,dryRun:true};
  delete next.targets[id];const changes=await reconcile(ctx,state,next,target.scope,new Set(),[],new Set([id]));
  if(target.scope!=='global')changes.push(...await projectChanges(state,next,target.scope,(await loadCatalog(ctx)).catalogVersion));await transact(ctx,state,next,changes);return preview;
}
export async function toggleSkills(ctx:Context,ids:string[],enable:boolean,options:MutationOptions={}):Promise<OperationResult>{
  const state=await loadState(ctx),next=structuredClone(state),scope=scopeOf(options);for(const id of ids)getRelease(state,id,options.project);
  const targets=await resolveTargets(next,scope,options.agents,options.mode);if(!targets.length)fail('USAGE','请指定或注册Agent目标');
  if(options.dryRun)return{scope,ids,enable,targets,dryRun:true};
  const changes:Change[]=[];
  if(enable)changes.push(...await reconcile(ctx,state,next,scope,new Set(ids),targets));
  else{
    const selectedTargets=new Set(targets.map(t=>t.id));
    for(const p of Object.values(state.projections))if(ids.includes(state.releases[p.releaseKey]!.id)&&p.targetIds.some(id=>selectedTargets.has(id))){
      const remaining=p.targetIds.filter(id=>!selectedTargets.has(id)).map(id=>state.targets[id]!);const change=await projectionChange(ctx,state,next,p.path,remaining.length?state.releases[p.releaseKey]!:null,remaining);if(change)changes.push(change);
    }
  }
  if(scope!=='global')changes.push(...await projectChanges(state,next,scope,(await loadCatalog(ctx)).catalogVersion));
  await transact(ctx,state,next,changes);return{scope,ids,enable,targets:targets.map(t=>t.id),discovery:'unverified'};
}
export async function removeSkills(ctx:Context,ids:string[],options:MutationOptions={}):Promise<OperationResult>{
  if(options.agents?.length)return toggleSkills(ctx,ids,false,options);
  const state=await loadState(ctx),next=structuredClone(state),scope=scopeOf(options),selected={...selections(next,scope)};
  for(const id of ids){getRelease(state,id,options.project);delete selected[id];}if(options.dryRun)return{remove:ids,scope,keepDownloaded:true,dryRun:true};
  setSelections(next,scope,selected);const changes=await reconcile(ctx,state,next,scope,new Set(ids));changes.push(...await projectChanges(state,next,scope,(await loadCatalog(ctx)).catalogVersion));await transact(ctx,state,next,changes);
  return{removed:ids,scope,keepDownloaded:true};
}
export async function pinSkills(ctx:Context,ids:string[],pinned:boolean,options:MutationOptions={}):Promise<OperationResult>{
  const state=await loadState(ctx),next=structuredClone(state),scope=scopeOf(options),selected={...selections(next,scope)};
  for(const id of ids){getRelease(state,id,options.project);selected[id]={...selected[id]!,pinned};}if(options.dryRun)return{ids,pinned,scope,dryRun:true};
  setSelections(next,scope,selected);await transact(ctx,state,next,await projectChanges(state,next,scope,(await loadCatalog(ctx)).catalogVersion));return{ids,pinned,scope};
}
export async function rollbackSkill(ctx:Context,id:string,version:string|undefined,options:MutationOptions={}):Promise<OperationResult>{
  const state=await loadState(ctx),next=structuredClone(state),scope=scopeOf(options),selected={...selections(next,scope)},old=selected[id];if(!old)fail('USAGE','技能未安装');
  const candidates=old.history.map(key=>state.releases[key]).filter((r):r is Release=>!!r);const release=version?candidates.find(r=>r.version===version):candidates.at(-1);if(!release)fail('OFFLINE','没有保留的对应历史版本');await verifyTree(storePath(ctx,release.contentDigest),release.manifest);
  if(options.dryRun)return{id,from:state.releases[old.releaseKey]!.version,to:release.version,scope,dryRun:true};
  selected[id]={releaseKey:release.key,pinned:old.pinned,history:[...old.history.filter(k=>k!==release.key),old.releaseKey]};setSelections(next,scope,selected);
  const changes=await reconcile(ctx,state,next,scope,new Set([id]));changes.push(...await projectChanges(state,next,scope,(await loadCatalog(ctx)).catalogVersion));await transact(ctx,state,next,changes);return{id,version:release.version,scope};
}
export async function checkUpdates(ctx:Context,options:MutationOptions={}):Promise<OperationResult>{
  const catalog=ctx.offline?await loadCatalog(ctx):await fetchLatestCatalog(ctx);const state=await loadState(ctx),scope=scopeOf(options);
  return{catalogVersion:catalog.catalogVersion,scope,offline:ctx.offline,updates:Object.entries(selections(state,scope)).flatMap(([id,s])=>{const old=state.releases[s.releaseKey]!,latest=catalog.skills.find(e=>e.id===id);return latest&&latest.contentDigest!==old.contentDigest?[{id,from:old.version,to:latest.version,pinned:s.pinned,files:latest.fileCount}]:[]})};
}
export async function updateSkills(ctx:Context,ids:string[],options:MutationOptions={}):Promise<OperationResult>{
  if(options.dryRun)return checkUpdates(ctx,options);
  if(!ctx.offline&&!ctx.catalogPath)await refreshCatalog(ctx);
  const catalog=await loadCatalog(ctx),state=await loadState(ctx),selected=selections(state,scopeOf(options));
  for(const id of ids)if(!selected[id])fail('USAGE','此范围未安装：'+id);
  const wanted=(ids.length?ids:Object.keys(selected)).filter(id=>!selected[id]!.pinned&&catalog.skills.some(e=>e.id===id&&e.contentDigest!==state.releases[selected[id]!.releaseKey]!.contentDigest));
  if(!wanted.length)return{updated:[],message:'没有需要更新的未固定技能'};
  return installSkills(ctx,wanted,{...options,agents:[]});
}
export async function readSkill(ctx:Context,id:string,path='SKILL.md',project?:string):Promise<OperationResult>{
  const release=getRelease(await loadState(ctx),id,project);safeRelativePath(path);const file=release.manifest.files.find(f=>f.path===path);if(!file)fail('USAGE','技能不包含此文件：'+path);await verifyTree(storePath(ctx,release.contentDigest),release.manifest);
  const absolute=join(storePath(ctx,release.contentDigest),path),bytes=await readFile(absolute);const text=bytes.includes(0)?undefined:bytes.toString('utf8');return{id,version:release.version,path:absolute,size:bytes.length,encoding:text===undefined?'base64':'utf8',content:text??bytes.toString('base64'),files:release.manifest.files};
}
export async function localStatus(ctx:Context):Promise<OperationResult>{const state=await loadState(ctx);return{home:ctx.home,generation:state.generation,installed:Object.entries(state.selections).map(([id,s])=>({id,...s,version:state.releases[s.releaseKey]!.version,path:storePath(ctx,state.releases[s.releaseKey]!.contentDigest)})),targets:Object.values(state.targets),projections:Object.values(state.projections),projects:Object.values(state.projects),pendingRecovery:await pendingTransactions(ctx)};}
export async function verifyInstalled(ctx:Context):Promise<OperationResult>{
  const state=await loadState(ctx);const results:Array<{id:string;version:string;ok:boolean;error?:string}>=[];
  for(const r of Object.values(state.releases)){try{await verifyTree(storePath(ctx,r.contentDigest),r.manifest);results.push({id:r.id,version:r.version,ok:true});}catch(e){results.push({id:r.id,version:r.version,ok:false,error:errorMessage(e)});}}
  const projections=[];for(const p of Object.values(state.projections)){try{await checkProjection(ctx,p,state.releases[p.releaseKey]!);projections.push({path:p.path,ok:true});}catch(e){projections.push({path:p.path,ok:false,error:errorMessage(e)});}}
  return{ok:results.every(x=>x.ok)&&projections.every(x=>x.ok),releases:results,projections};
}
export async function doctor(ctx:Context):Promise<OperationResult>{const state=await loadState(ctx),verified=await verifyInstalled(ctx),pending=await pendingTransactions(ctx),runtime=await runtimeDoctor(ctx,Object.values(state.releases));return{...verified,ok:verified.ok&&pending.length===0&&runtime.node.ok&&runtime.permissions.ok&&runtime.configuration.ok&&!runtime.releases.some(r=>r.status==='missing'),pendingRecovery:pending,runtime,agents:Object.values(state.targets).map(t=>({id:t.id,path:t.path,discovery:t.discovery,hints:agentHints(t)})),network:'未请求面板或服务商；原生加载需单独验证'};}
export async function forkSkill(ctx:Context,id:string,output:string,project?:string):Promise<OperationResult>{
  const state=await loadState(ctx),r=getRelease(state,id,project),destination=resolve(output);if(await exists(destination))fail('CONFLICT','fork输出必须是新目录');if(within(ctx.home,destination))fail('CONFLICT','定制副本不能写入SkillShelf受管数据目录');await verifyTree(storePath(ctx,r.contentDigest),r.manifest);await mkdir(dirname(destination),{recursive:true,mode:0o700});await cp(storePath(ctx,r.contentDigest),destination,{recursive:true,force:false,errorOnExist:true});
  await chmodTree(destination,false);return{id,path:destination,managed:false,sourceVersion:r.version};
}
const projectAgentSchema=z.object({agent:z.enum(['claude-code','codex','opencode','dsh','cursor','hermes','universal','custom']),relativePath:z.string().optional(),mode:z.enum(['auto','link','copy']).optional(),skills:z.array(z.string()).optional()}).strict();
const projectSpecSchema=z.object({schemaVersion:z.literal(1),skills:z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),z.object({version:z.string().regex(EXACT_VERSION).optional(),pinned:z.boolean().optional()}).strict()),agents:z.array(projectAgentSchema).max(128)}).strict();
const projectLockSchema=z.object({schemaVersion:z.literal(1),catalogVersion:z.string().regex(EXACT_VERSION),skills:z.array(z.object({id:z.string(),name:z.string(),packageName:z.string(),version:z.string().regex(EXACT_VERSION),integrity:z.string(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/),entry:z.unknown().optional()}).strict()).max(1000),agents:z.array(projectAgentSchema).max(128)}).strict();
export async function syncFrozen(ctx:Context,options:MutationOptions):Promise<OperationResult>{return withMutation(ctx,options,()=>syncFrozenInternal(ctx,options));}
async function syncFrozenInternal(ctx:Context,options:MutationOptions):Promise<OperationResult>{
  if(!options.project)fail('USAGE','sync --frozen 需要 --project <目录>');const root=resolve(options.project);
  const guards=[{path:join(root,'skillshelf-lock.json'),expected:await fingerprint(join(root,'skillshelf-lock.json'))},{path:join(root,'skillshelf.json'),expected:await fingerprint(join(root,'skillshelf.json'))}];
  const lock=await readJson<ProjectLock>(join(root,'skillshelf-lock.json')),spec=await readJson<ProjectSpec>(join(root,'skillshelf.json'));
  if(!projectLockSchema.safeParse(lock).success||!projectSpecSchema.safeParse(spec).success)fail('INTEGRITY','项目锁/声明格式无效');
  if(canonicalJson(spec.agents)!==canonicalJson(lock.agents))fail('CONFLICT','项目Agent声明和锁不一致');
  if(new Set(lock.skills.map(s=>s.id)).size!==lock.skills.length)fail('INTEGRITY','项目锁技能ID重复');
  if(JSON.stringify(Object.keys(spec.skills).sort())!==JSON.stringify(lock.skills.map(s=>s.id).sort()))fail('CONFLICT','项目声明和锁文件不一致');
  const catalog=await loadCatalog(ctx);const entries:CatalogEntry[]=lock.skills.map(item=>{const base=item.entry||catalog.skills.find(x=>x.id===item.id);if(!base)fail('UNAVAILABLE','锁文件缺少完整的版本元数据：'+item.id);if(spec.skills[item.id]?.version&&spec.skills[item.id]!.version!==item.version)fail('CONFLICT','项目声明版本和锁不一致：'+item.id);const entry={...base,id:item.id,name:item.name,packageName:item.packageName,version:item.version,integrity:item.integrity,contentDigest:item.contentDigest};if(item.entry&&(item.entry.id!==item.id||item.entry.name!==item.name||item.entry.version!==item.version||item.entry.integrity!==item.integrity||item.entry.contentDigest!==item.contentDigest||item.entry.packageName!==item.packageName))fail('INTEGRITY','锁定版本快照与顶层字段不一致');return entry;});
  const state=await loadState(ctx),next=structuredClone(state),targets:AgentTarget[]=[],attachIds=new Map<string,Set<string>>(),detached=new Set(activeTargets(state,root).map(t=>t.id));
  for(const id of detached)delete next.targets[id];
  for(const t of lock.agents){const path=t.relativePath?resolve(root,safeRelativePath(t.relativePath)):undefined;if(path&&!within(root,path))fail('INTEGRITY','项目目标越界');const target=await resolveAgentTarget(t.agent,{project:root,path,mode:t.mode});if(targets.some(x=>x.id===target.id))fail('INTEGRITY','项目目标重复');if(t.skills&&(new Set(t.skills).size!==t.skills.length||t.skills.some(id=>!lock.skills.some(s=>s.id===id))))fail('INTEGRITY','目标技能选择无效');next.targets[target.id]=target;targets.push(target);attachIds.set(target.id,new Set(t.skills||lock.skills.map(s=>s.id)));}
  await validateHomeLocation(ctx,Object.values(next.targets),{projects:[root]});
  if(options.dryRun)return{scope:root,skills:entries.map(e=>({id:e.id,version:e.version})),targets,dryRun:true,frozen:true};
  const selected:Record<string,Selection>={};
  for(const entry of entries){const a=await acquireLockedSkill(ctx,entry),key=releaseKey(entry.id,entry.version,entry.contentDigest);next.releases[key]={key,id:entry.id,name:entry.name,version:entry.version,packageName:entry.packageName,integrity:entry.integrity,contentDigest:entry.contentDigest,manifest:a.manifest,source:entry.source,installedAt:new Date().toISOString(),origin:'npm',catalogEntry:publicEntry(entry)};selected[entry.id]={releaseKey:key,pinned:spec.skills[entry.id]?.pinned||false,history:[]};}
  setSelections(next,root,selected);next.projects[root]!.specHash=guards[1]!.expected||undefined;next.projects[root]!.lockHash=guards[0]!.expected||undefined;
  const changes=await reconcile(ctx,state,next,root,new Set([...Object.keys(selections(state,root)),...Object.keys(selected)]),targets,detached,attachIds);
  // Frozen restore never rewrites the declaration or lock and guards their read snapshots.
  await transact(ctx,state,next,changes,{guards});return{scope:root,restored:Object.keys(selected),frozen:true,discovery:'unverified'};
}
