import { readFile, readdir, cp, mkdir, lstat, rm, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { chmodTree } from './store/local.js';
import type { AgentId, AgentTarget, Catalog, CatalogEntry, Context, MutationOptions, OperationResult, ProjectLock, ProjectRecord, ProjectSpec, Release, Selection, State, PackMember, SkillManifest } from './types.js';
import { loadCatalog, refreshCatalog, searchCatalog, fetchLatestCatalog } from './catalog/catalog.js';
import { acquireSkill, acquireLockedSkill } from './registry/registry.js';
import { detectAgents, resolveAgentTarget, agentHints, canonicalProjectPath } from './agents/agents.js';
import { validateHomeLocation } from './agents/storage-boundary.js';
import { verifyTree, safeRelativePath, inventory, canonicalJson, EXACT_VERSION, validateManifest } from './validation.js';
import { z } from 'zod';
import { exists, fingerprint, canonicalPath, atomicWrite, writeJson, readJson, keyFor, within } from './store/fs.js';
import { getRelease, loadState, releaseKey, storePath } from './store/state.js';
import { projectionChange, projectionKey, validateTargetPath, checkProjection, desiredMode } from './store/projections.js';
import { transact, targetWorkRoot, pendingTransactions, type Change } from './transactions/transaction.js';
import { fail, errorMessage } from './errors.js';
import { fixedProjectOptions, preflightProjectHome, withMutation } from './transactions/operations.js';
import { runtimeDoctor } from './runtime/runtime.js';

export function publicEntry(entry:CatalogEntry):CatalogEntry { const {localArtifact:_,...clean}=entry;return clean; }
const agentIds: AgentId[]=['claude-code','codex','opencode','dsh','cursor','hermes','universal','custom'];
async function scopeOf(options:MutationOptions):Promise<string>{return options.project?canonicalProjectPath(options.project):'global';}
function selections(state:State,scope:string):Record<string,Selection>{return scope==='global'?state.selections:state.projects[scope]?.selections||{};}
function setSelections(state:State,scope:string,value:Record<string,Selection>):void{
  state.schemaVersion=2;
  if(scope==='global'){state.selections=value;return;}
  state.projects[scope]={...state.projects[scope],root:scope,specPath:join(scope,'skillshelf.json'),lockPath:join(scope,'skillshelf-lock.json'),selections:value};
}
function activeTargets(state:State,scope:string):AgentTarget[]{return Object.values(state.targets).filter(t=>t.scope===scope);}
function exposureFor(state:State,target:AgentTarget,release:Release):{all:boolean;enabled:Set<string>;disabled:Set<string>} {
  const row=state.exposures?.[target.id]?.[release.id];
  return {all:row?.all??true,enabled:new Set(row?.enabled||[]),disabled:new Set(row?.disabled||[])};
}
function exposedMembers(state:State,target:AgentTarget,release:Release):PackMember[]|[undefined] {
  const members=release.manifest.members;if(!members)return [undefined];const exposure=exposureFor(state,target,release);if(exposure.all)return members.filter(member=>!exposure.disabled.has(member.id));return members.filter(member=>exposure.enabled.has(member.id)&&!exposure.disabled.has(member.id));
}
function setExposure(state:State,targetId:string,packId:string,exposure:{all:boolean;enabled?:Iterable<string>;disabled?:Iterable<string>}):void {
  state.exposures??={};state.exposures[targetId]??={};state.exposures[targetId]![packId]={all:exposure.all,enabled:[...new Set(exposure.enabled||[])].sort(),disabled:[...new Set(exposure.disabled||[])].sort()};
}
function chooseEntries(catalog:Catalog,ids:string[],collection?:string):CatalogEntry[]{
  const names=[...ids]; if(collection){const group=catalog.collections.find(g=>g.id===collection);if(!group)fail('USAGE','精选组合不存在：'+collection);names.push(...group.skills);}
  if(!names.length)fail('USAGE','请指定技能或精选组合');
  return [...new Set(names)].map(id=>{const entry=catalog.skills.find(x=>x.id===id||x.name===id);if(!entry){const parents=catalog.skills.filter(entry=>entry.members?.some(member=>member.legacyId===id||member.id===id||`${entry.id}/${member.id}`===id));if(parents.length)fail('USAGE',`此 ID 是包内成员；请显式安装完整包 ${parents.map(entry=>entry.id).join(', ')}，旧安装保留，迁移需显式选择父包：${id}`);fail('USAGE','精选目录没有此技能：'+id);}return entry;});
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
  const agents:ProjectSpec['agents']=targets.map(t=>{const rel=relative(scope,t.path);if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')||rel.startsWith('..\\'))fail('CONFLICT','项目Agent目标必须位于项目内：'+t.path);const exposures=Object.fromEntries(Object.entries(next.exposures?.[t.id]||{}).map(([id,value])=>[id,value]));return{agent:t.agent,relativePath:rel.split('\\').join('/'),mode:t.mode,skills:Object.values(next.projections).filter(p=>p.targetIds.includes(t.id)).map(p=>next.releases[p.releaseKey]!.id+(p.memberId?'/'+p.memberId:'')).sort(),exposures};});
  const spec:ProjectSpec={schemaVersion:2,skills:Object.fromEntries(Object.entries(selected).map(([id,s])=>[id,{version:next.releases[s.releaseKey]!.version,pinned:s.pinned}])),agents};
  const lock:ProjectLock={schemaVersion:2,catalogVersion,skills:Object.values(selected).map(s=>{const r=next.releases[s.releaseKey]!;return{id:r.id,name:r.name,packageName:r.packageName,version:r.version,integrity:r.integrity,contentDigest:r.contentDigest,entry:r.catalogEntry?publicEntry(r.catalogEntry):undefined,manifest:r.manifest,source:r.source,origin:r.origin};}),agents};
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
  const desired=new Map<string,{release:Release;targets:AgentTarget[];member?:PackMember}>();
  for(const projection of Object.values(state.projections)){
    const old=state.releases[projection.releaseKey]!;let refs=projection.targetIds.map(id=>next.targets[id]).filter((t):t is AgentTarget=>!!t&&!detachIds.has(t.id));
    for(const target of refs){
      let release=old;
      if(target.scope===scope&&ids.has(old.id)){const s=selections(next,scope)[old.id];if(!s)continue;release=next.releases[s.releaseKey]!;}
      const exposure=next.exposures?.[target.id]?.[release.id];if(release.manifest.members&&exposure&&((exposure.all&&exposure.disabled.includes(projection.memberId||''))||(!exposure.all&&!exposure.enabled.includes(projection.memberId||''))))continue;
      const member=release.manifest.members?.find(member=>member.id===projection.memberId);if(release.manifest.members&&!member)continue;
      const current=desired.get(projection.path);if(current&&(current.release.key!==release.key||current.member?.id!==member?.id))fail('CONFLICT','共享物理目标被要求安装不同版本：'+projection.path);
      desired.set(projection.path,{release,member,targets:[...(current?.targets||[]),target]});
    }
  }
  for(const target of attach){
    await validateTargetPath(target);
    for(const requested of attachIds?.get(target.id)||ids){const [id,memberId]=requested.split('/');const choice=selections(next,scope)[id!];if(!choice)continue;const release=next.releases[choice.releaseKey]!;
      for(const member of exposedMembers(next,target,release)){if(memberId&&member?.id!==memberId)continue;const path=join(target.path,member?.name||release.name);const current=desired.get(path);
      if(current&&(current.release.key!==release.key||current.member?.id!==member?.id))fail('CONFLICT','同一目标存在不同版本：'+path);
      desired.set(path,{release,member,targets:[...(current?.targets||[]),target]});}
    }
  }
  const paths=new Set([...Object.values(state.projections).map(p=>p.path),...desired.keys()]);const changes:Change[]=[];
  for(const path of paths){const item=desired.get(path);const old=state.projections[projectionKey(path)];
    // Unaffected paths need not re-verify, but all paths participating in the operation do.
    const mode=item?desiredMode(item.targets):undefined;
    if(old&&item&&old.releaseKey===item.release.key&&old.memberId===item.member?.id&&(mode==='auto'?old.mode==='link':mode===old.mode)&&JSON.stringify([...old.targetIds].sort())===JSON.stringify([...new Set(item.targets.map(t=>t.id))].sort()))continue;
    const change=await projectionChange(ctx,state,next,path,item?.release||null,item?.targets||[],item?.member);if(change)changes.push(change);
  }
  return changes;
}
export async function listSkills(ctx:Context,query='',filters:{category?:string;collection?:string;installed?:boolean}={}):Promise<OperationResult>{
  const[catalog,state]=await Promise.all([loadCatalog(ctx),loadState(ctx)]);
  return{catalogVersion:catalog.catalogVersion,source:ctx.catalogPath?'local-catalog':'local-snapshot',skills:searchCatalog(catalog,query,{category:filters.category,collection:filters.collection,installed:filters.installed?Object.keys(state.selections):undefined}).map(entry=>({...entry,installed:state.selections[entry.id]?{version:state.releases[state.selections[entry.id]!.releaseKey]!.version,pinned:state.selections[entry.id]!.pinned}:null}))};
}
export async function installSkills(ctx:Context,ids:string[],options:MutationOptions&{collection?:string}={}):Promise<OperationResult>{const fixed=await fixedProjectOptions(options);return withMutation(ctx,fixed,()=>installSkillsInternal(ctx,ids,fixed));}
async function installSkillsInternal(ctx:Context,ids:string[],options:MutationOptions&{collection?:string}={}):Promise<OperationResult>{
  const catalog=await loadCatalog(ctx),state=await loadState(ctx),next=structuredClone(state),scope=await scopeOf(options);
  const entries=chooseEntries(catalog,ids,options.collection);const targets=await resolveTargets(next,scope,options.agents,options.mode);
  await validateHomeLocation(ctx,Object.values(next.targets),{projects:scope==='global'?[]:[scope]});
  const preview={scope,skills:entries.map(e=>({id:e.id,version:e.version,files:e.fileCount,bytes:e.unpackedSize})),targets:targets.map(t=>({id:t.id,path:t.path,mode:t.mode,hints:agentHints(t)})),downloadOnly:targets.length===0};
  // Preview catches pins and unmanaged collisions before acquiring packages.
  for(const entry of entries){const existing=selections(state,scope)[entry.id];
    const legacySingleton=entry.kind==='pack'&&entry.members?.length===1&&existing&&state.releases[existing.releaseKey]?.manifest.schemaVersion===1;
    if(legacySingleton)fail('CONFLICT',`检测到旧成员安装：包 ${entry.id} 的成员此前以独立技能安装。请先 remove 旧成员技能后重新 install 完整包，或使用 SkillShelf core API 的 previewLegacyMigration/applyLegacyMigration 显式迁移以保留现有投影`);
    if(existing?.pinned&&existing.releaseKey!==releaseKey(entry.id,entry.version,entry.contentDigest,entry.kind==='pack'?entry.integrity:''))fail('CONFLICT','技能已固定，请先 unpin 再更换版本：'+entry.id);
  }
  for(const t of targets)for(const e of entries)for(const member of e.members||[{name:e.name}]){const path=join(t.path,member.name),old=state.projections[projectionKey(path)];if(!old&&await exists(path))fail('CONFLICT','已有同名非受管技能：'+path);if(old)await checkProjection(ctx,old,state.releases[old.releaseKey]!);}
  if(options.dryRun)return{...preview,dryRun:true};
  const selected={...selections(next,scope)};
  for(const entry of entries){
    const acquired=await acquireSkill(ctx,entry);const key=releaseKey(entry.id,entry.version,entry.contentDigest,acquired.manifest.schemaVersion===2?entry.integrity:'');
    const github=entry.sourceManifest?.acquisition.kind==='github';
    const release:Release={key,id:entry.id,name:entry.name,version:entry.version,packageName:entry.packageName,integrity:entry.integrity,contentDigest:entry.contentDigest,manifest:acquired.manifest,source:entry.source,installedAt:new Date().toISOString(),origin:github?'github':'npm',catalogEntry:publicEntry(entry),...(github?{acquisition:entry.acquisition,sourceManifest:entry.sourceManifest,packRevision:entry.packRevision}:{})};
    next.releases[key]=release;const old=selected[entry.id];
    if(old?.pinned&&old.releaseKey!==key)fail('CONFLICT','技能已固定，请先 unpin 再更换版本：'+entry.id);
    selected[entry.id]={releaseKey:key,pinned:old?.pinned||false,history:[...new Set([...(old?.history||[]),...(old&&old.releaseKey!==key?[old.releaseKey]:[])])].filter(k=>k!==key)};
    for(const target of targets)if(entry.kind==='pack')setExposure(next,target.id,entry.id,{all:true,disabled:state.exposures?.[target.id]?.[entry.id]?.disabled||[]});
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
  const state=await loadState(ctx),next=structuredClone(state),scope=await scopeOf(options);const resolved=await Promise.all(ids.map(id=>resolveInstalledMember(state,id,scope==='global'?undefined:scope)));ids=resolved.map(({release,member})=>release.id+(member?'/'+member.id:''));
  const targets=await resolveTargets(next,scope,options.agents,options.mode);if(!targets.length)fail('USAGE','请指定或注册Agent目标');
  for(const {release,member} of resolved)if(release.manifest.members){for(const target of targets){const prior=exposureFor(next,target,release);const enabled=new Set(prior.enabled),disabled=new Set(prior.disabled);if(enable){if(member)enabled.add(member.id);else release.manifest.members.forEach(item=>enabled.add(item.id));if(member)disabled.delete(member.id);else disabled.clear();}else{if(member){enabled.delete(member.id);disabled.add(member.id);}else{enabled.clear();release.manifest.members.forEach(item=>disabled.add(item.id));}}setExposure(next,target.id,release.id,{all:member?prior.all:enable,enabled,disabled});}}
  if(options.dryRun)return{scope,ids,enable,targets,dryRun:true};
  const changes:Change[]=[];
  if(enable)changes.push(...await reconcile(ctx,state,next,scope,new Set(ids),targets));
  else{
    const selectedTargets=new Set(targets.map(t=>t.id));
    for(const p of Object.values(state.projections))if(ids.some(id=>id===state.releases[p.releaseKey]!.id||id===state.releases[p.releaseKey]!.id+'/'+p.memberId)&&p.targetIds.some(id=>selectedTargets.has(id))){
      const release=state.releases[p.releaseKey]!;const remaining=p.targetIds.filter(id=>!selectedTargets.has(id)).map(id=>state.targets[id]!);const change=await projectionChange(ctx,state,next,p.path,remaining.length?release:null,remaining,release.manifest.members?.find(member=>member.id===p.memberId));if(change)changes.push(change);
    }
  }
  if(scope!=='global')changes.push(...await projectChanges(state,next,scope,(await loadCatalog(ctx)).catalogVersion));
  await transact(ctx,state,next,changes);return{scope,ids,enable,targets:targets.map(t=>t.id),discovery:'unverified'};
}
export async function removeSkills(ctx:Context,ids:string[],options:MutationOptions={}):Promise<OperationResult>{
  if(options.agents?.length)return toggleSkills(ctx,ids,false,options);
  const state=await loadState(ctx),next=structuredClone(state),scope=await scopeOf(options),selected={...selections(next,scope)};
  for(const id of ids){await getRelease(state,id,scope==='global'?undefined:scope);delete selected[id];}if(options.dryRun)return{remove:ids,scope,keepDownloaded:true,dryRun:true};
  setSelections(next,scope,selected);const changes=await reconcile(ctx,state,next,scope,new Set(ids));changes.push(...await projectChanges(state,next,scope,(await loadCatalog(ctx)).catalogVersion));await transact(ctx,state,next,changes);
  return{removed:ids,scope,keepDownloaded:true};
}
export async function pinSkills(ctx:Context,ids:string[],pinned:boolean,options:MutationOptions={}):Promise<OperationResult>{
  const state=await loadState(ctx),next=structuredClone(state),scope=await scopeOf(options),selected={...selections(next,scope)};
  for(const id of ids){await getRelease(state,id,scope==='global'?undefined:scope);selected[id]={...selected[id]!,pinned};}if(options.dryRun)return{ids,pinned,scope,dryRun:true};
  setSelections(next,scope,selected);await transact(ctx,state,next,await projectChanges(state,next,scope,(await loadCatalog(ctx)).catalogVersion));return{ids,pinned,scope};
}
export async function rollbackSkill(ctx:Context,id:string,version:string|undefined,options:MutationOptions&{revision?:string}={}):Promise<OperationResult>{
  const state=await loadState(ctx),next=structuredClone(state),scope=await scopeOf(options),selected={...selections(next,scope)},old=selected[id];if(!old)fail('USAGE','技能未安装');
  const candidates=old.history.map(key=>state.releases[key]).filter((r):r is Release=>!!r);
  if(options.revision!==undefined&&!/^[^@\s]+@[^#\s]+#[a-f0-9]{16}(?::[a-f0-9]{16})?$/u.test(options.revision))fail('USAGE','revision 必须是保留的精确 release 键');
  const release=options.revision!==undefined?candidates.find(r=>r.key===options.revision):version?candidates.find(r=>r.version===version):candidates.at(-1);if(!release)fail('OFFLINE','没有保留的对应历史版本');await verifyTree(storePath(ctx,release.contentDigest),release.manifest);
  if(options.dryRun)return{id,from:state.releases[old.releaseKey]!.version,to:release.version,revision:release.key,scope,dryRun:true};
  selected[id]={releaseKey:release.key,pinned:old.pinned,history:[...old.history.filter(k=>k!==release.key),old.releaseKey]};setSelections(next,scope,selected);
  const changes=await reconcile(ctx,state,next,scope,new Set([id]));changes.push(...await projectChanges(state,next,scope,(await loadCatalog(ctx)).catalogVersion));await transact(ctx,state,next,changes);return{id,version:release.version,scope};
}
const sourceChanged=(old:Release,latest:CatalogEntry):boolean=>{
  if(latest.sourceManifest?.acquisition.kind==='github')return latest.contentDigest!==old.contentDigest;
  return latest.contentDigest!==old.contentDigest||latest.version!==old.version||latest.integrity!==old.integrity;
};
/** Installed release history for one skill: current identity plus every retained release. */
export async function skillHistory(ctx:Context,id:string,project?:string):Promise<OperationResult>{
  const state=await loadState(ctx),scope=project?await canonicalProjectPath(project):'global';
  const selection=selections(state,scope)[id];if(!selection)fail('USAGE','此范围未安装技能：'+id);
  const current=state.releases[selection.releaseKey]!;
  return {id,scope,pinned:selection.pinned,
    current:{key:current.key,version:current.version,origin:current.origin,contentDigest:current.contentDigest,packRevision:current.packRevision},
    history:selection.history.map(key=>{const release=state.releases[key]!;return{key,version:release.version,origin:release.origin,contentDigest:release.contentDigest,packRevision:release.packRevision};})};
}

/** npm→GitHub source migration with preview and atomic apply. Pinned entries
 * are skipped by default; the old release always stays in history. */
export async function migrateSources(ctx:Context,options:MutationOptions&{ids?:string[]}={}):Promise<OperationResult>{
  const fixed=await fixedProjectOptions(options);
  return withMutation(ctx,{...fixed,dryRun:fixed.dryRun},async()=>{
    const catalog=await loadCatalog(ctx),state=await loadState(ctx),scope=await scopeOf(fixed),selected=selections(state,scope);
    const migrations=[];
    for(const [id,selection] of Object.entries(selected)){
      if(options.ids?.length&&!options.ids.includes(id))continue;
      const old=state.releases[selection.releaseKey]!;
      const latest=catalog.skills.find(entry=>entry.id===id&&entry.sourceManifest?.acquisition.kind==='github');
      if(!latest)continue;
      if(old.origin==='github')continue;
      migrations.push({id,from:{origin:old.origin,version:old.version,packageName:old.packageName,contentDigest:old.contentDigest},to:{origin:'github',repository:latest.source.repository,commit:latest.source.commit,packRevision:latest.packRevision,releaseDigest:latest.contentDigest},pinned:selection.pinned,migratable:!selection.pinned,reason:selection.pinned?'pinned：默认不迁移固定版本，请先显式 unpin':undefined});
    }
    const preview={scope:fixed.project??'global',migrations,skipped:migrations.filter(row=>!row.migratable).map(row=>row.id)};
    const targets=migrations.filter(row=>row.migratable).map(row=>row.id);
    if(fixed.dryRun||!targets.length)return{...preview,dryRun:true};
    if(fixed.yes!==true)fail('USAGE','迁移需确认预览后使用 yes:true');
    const install=await installSkillsInternal(ctx,targets,{...fixed,agents:[]});
    const next=await loadState(ctx);
    return {...preview,migrated:targets.map(id=>({id,releaseKey:selections(next,scope)[id]?.releaseKey,origin:'github'})),install};
  });
}

export async function checkUpdates(ctx:Context,options:MutationOptions={}):Promise<OperationResult>{
  const catalog=ctx.offline?await loadCatalog(ctx):await fetchLatestCatalog(ctx);const state=await loadState(ctx),scope=await scopeOf(options);
  return{catalogVersion:catalog.catalogVersion,scope,offline:ctx.offline,updates:Object.entries(selections(state,scope)).flatMap(([id,s])=>{const old=state.releases[s.releaseKey]!,latest=catalog.skills.find(e=>e.id===id);if(!latest||!sourceChanged(old,latest))return[];
    const row:Record<string,unknown>={id,from:old.version,to:latest.version,pinned:s.pinned,files:latest.fileCount};
    if(latest.sourceManifest?.acquisition.kind==='github'){
      row.source='github';row.repository=latest.source.repository;row.fromOrigin=old.origin;
      row.fromReleaseDigest=old.contentDigest;row.toReleaseDigest=latest.contentDigest;row.toPackRevision=latest.packRevision;
      const before=old.sourceManifest,after=latest.sourceManifest;
      if(before){row.fromCommit=before.acquisition.kind==='github'?before.acquisition.commit:undefined;row.fromPackRevision=before.packRevision;
        const oldFiles=new Map(before.files.map(f=>[f.path,f]as const)),newFiles=new Map(after.files.map(f=>[f.path,f]as const));
        row.filesDiff={added:[...newFiles.keys()].filter(p=>!oldFiles.has(p)).sort(),removed:[...oldFiles.keys()].filter(p=>!newFiles.has(p)).sort(),changed:[...newFiles].filter(([p,f])=>oldFiles.has(p)&&canonicalJson(oldFiles.get(p))!==canonicalJson(f)).map(([p])=>p).sort()};
        row.runtimeChanged=canonicalJson(before.runtime)!==canonicalJson(after.runtime);}
    }
    return[row];})};
}
export async function updateSkills(ctx:Context,ids:string[],options:MutationOptions={}):Promise<OperationResult>{
  const fixed=await fixedProjectOptions(options);
  await preflightProjectHome(ctx,fixed); // Online refresh may write the catalog before installSkills starts.
  if(fixed.dryRun)return checkUpdates(ctx,fixed);
  if(!ctx.offline&&!ctx.catalogPath)await refreshCatalog(ctx);
  const catalog=await loadCatalog(ctx),state=await loadState(ctx),selected=selections(state,await scopeOf(fixed));
  for(const id of ids)if(!selected[id])fail('USAGE','此范围未安装：'+id);
  const wanted=(ids.length?ids:Object.keys(selected)).filter(id=>!selected[id]!.pinned&&catalog.skills.some(e=>{const old=state.releases[selected[id]!.releaseKey]!;return e.id===id&&sourceChanged(old,e);}));
  if(!wanted.length)return{updated:[],message:'没有需要更新的未固定技能'};
  return installSkills(ctx,wanted,{...fixed,agents:[]});
}
export async function readSkill(ctx:Context,id:string,path='SKILL.md',project?:string):Promise<OperationResult>{
  const resolved=await resolveInstalledMember(await loadState(ctx),id,project),release=resolved.release,member=resolved.member||(release.manifest.members?.length===1?release.manifest.members[0]:undefined);safeRelativePath(path);if(member)path=member.path+'/'+path;const file=release.manifest.files.find(f=>f.path===path);if(!file)fail('USAGE','技能不包含此文件：'+path);await verifyTree(storePath(ctx,release.contentDigest),release.manifest);
  const absolute=join(storePath(ctx,release.contentDigest),path),bytes=await readFile(absolute);const text=bytes.includes(0)?undefined:bytes.toString('utf8');return{id,version:release.version,path:absolute,size:bytes.length,encoding:text===undefined?'base64':'utf8',content:text??bytes.toString('base64'),files:release.manifest.files};
}
export async function localStatus(ctx:Context):Promise<OperationResult>{const state=await loadState(ctx);return{home:ctx.home,generation:state.generation,installed:Object.entries(state.selections).map(([id,s])=>({id,...s,version:state.releases[s.releaseKey]!.version,path:storePath(ctx,state.releases[s.releaseKey]!.contentDigest)})),targets:Object.values(state.targets),projections:Object.values(state.projections),projects:Object.values(state.projects),pendingRecovery:await pendingTransactions(ctx)};}
export async function resolveInstalledMember(state:State,id:string,project?:string):Promise<{release:Release;member?:PackMember}> {
  const selected=selections(state,project?await canonicalProjectPath(project):'global');
  if(selected[id])return{release:state.releases[selected[id]!.releaseKey]!};
  const matches:Array<{release:Release;member:PackMember}>=[];
  for(const selection of Object.values(selected)){const release=state.releases[selection.releaseKey]!;for(const member of release.manifest.members||[])if(id===`${release.id}/${member.id}`||id===member.legacyId||id===member.id)matches.push({release,member});}
  if(matches.length!==1)fail('USAGE',matches.length?'成员名称不唯一，请使用 包ID/成员ID：'+id:'此范围尚未安装技能：'+id);
  return matches[0]!;
}
export async function listInstalledPacks(ctx:Context,project?:string):Promise<OperationResult[]> {
  const state=await loadState(ctx),scope=project?await canonicalProjectPath(project):'global';
  return Object.entries(selections(state,scope)).map(([id,selection])=>{const release=state.releases[selection.releaseKey]!;return{id,legacy:release.manifest.schemaVersion===1,selection,release,members:release.manifest.members||[],projections:Object.values(state.projections).filter(projection=>projection.releaseKey===release.key)};});
}
export async function setLocalPreference(ctx:Context,id:string,preference:NonNullable<State['preferences']>[string]):Promise<OperationResult> {
  const state=await loadState(ctx),next=structuredClone(state);next.schemaVersion=2;next.preferences={...next.preferences,[id]:preference};await transact(ctx,state,next,[]);return{id,preference};
}
export function desiredPackProjections(ctx:Context,release:Release,targets:AgentTarget[],memberIds?:string[]):Array<{path:string;source:string;targetId:string;memberId?:string;memberPath?:string}> {
  return targets.flatMap(target=>(release.manifest.members||[undefined]).filter(member=>!memberIds||!!member&&memberIds.includes(member.id)).map(member=>({path:join(target.path,member?.name||release.name),source:join(storePath(ctx,release.contentDigest),member?.path||''),targetId:target.id,...(member?{memberId:member.id,memberPath:member.path}:{})})));
}
async function selectPackReleaseInternal(ctx:Context,release:Release,fixed:MutationOptions):Promise<OperationResult> {
    const state=await loadState(ctx),next=structuredClone(state),scope=await scopeOf(fixed),selected={...selections(next,scope)},old=selected[release.id];
    if(release.manifest.schemaVersion!==2)fail('USAGE','需要完整包 manifest schema 2');
    await verifyTree(storePath(ctx,release.contentDigest),release.manifest);
    if(old?.pinned&&old.releaseKey!==release.key)fail('CONFLICT','包已固定，请先 unpin');
    const targets=await resolveTargets(next,scope,fixed.agents,fixed.mode);if(fixed.dryRun)return{id:release.id,scope,targets,dryRun:true};
    next.releases[release.key]=release;selected[release.id]={releaseKey:release.key,pinned:old?.pinned||false,history:[...new Set([...(old?.history||[]),...(old&&old.releaseKey!==release.key?[old.releaseKey]:[])])].filter(key=>key!==release.key)};setSelections(next,scope,selected);
    const changes=await reconcile(ctx,state,next,scope,new Set([release.id]),targets);changes.push(...await projectChanges(state,next,scope,(await loadCatalog(ctx)).catalogVersion));await transact(ctx,state,next,changes);return{id:release.id,scope,releaseKey:release.key};
}
export async function selectPackRelease(ctx:Context,release:Release,options:MutationOptions={}):Promise<OperationResult> {
  const fixed=await fixedProjectOptions(options);return withMutation(ctx,fixed,()=>selectPackReleaseInternal(ctx,release,fixed));
}
export async function importValidatedPack(ctx:Context,source:string,manifest:SkillManifest,version:string,options:MutationOptions={}):Promise<OperationResult> {
  if(manifest.schemaVersion!==2||!EXACT_VERSION.test(version))fail('USAGE','本地导入需要完整包与精确版本');
  const fixed=await fixedProjectOptions(options);await preflightProjectHome(ctx,fixed);await verifyTree(source,manifest);if(fixed.dryRun)return{id:manifest.id,version,members:manifest.members,dryRun:true};
  const {importTree}=await import('./store/local.js');return withMutation(ctx,fixed,async()=>{await importTree(ctx,source,manifest);const key=releaseKey(manifest.id,version,manifest.contentDigest);return selectPackReleaseInternal(ctx,{key,id:manifest.id,name:manifest.name,version,packageName:'local:'+manifest.id,integrity:'',contentDigest:manifest.contentDigest,manifest,source:{},installedAt:new Date().toISOString(),origin:'local'},fixed);});
}
export function comparePackManifests(previous:SkillManifest|undefined,next:SkillManifest):OperationResult {
  const before=new Map((previous?.members||[]).map(member=>[member.id,member])),after=new Map((next.members||[]).map(member=>[member.id,member]));
  const oldFiles=new Map((previous?.files||[]).map(file=>[file.path,file])),newFiles=new Map(next.files.map(file=>[file.path,file]));
  return {members:{added:[...after.keys()].filter(id=>!before.has(id)),removed:[...before.keys()].filter(id=>!after.has(id)),changed:[...after].filter(([id,member])=>before.has(id)&&canonicalJson(before.get(id))!==canonicalJson(member)).map(([id])=>id)},files:{added:[...newFiles.keys()].filter(name=>!oldFiles.has(name)),removed:[...oldFiles.keys()].filter(name=>!newFiles.has(name)),changed:[...newFiles].filter(([name,file])=>oldFiles.has(name)&&canonicalJson(oldFiles.get(name))!==canonicalJson(file)).map(([name])=>name)},dependencies:[...after].flatMap(([id,member])=>canonicalJson(before.get(id)?.dependencies||[])===canonicalJson(member.dependencies)?[]:[{id,before:before.get(id)?.dependencies||[],after:member.dependencies}]),runtimeChanged:!previous||canonicalJson(previous.runtime)!==canonicalJson(next.runtime),memberRuntimeChanges:[...after].filter(([id,member])=>!before.has(id)||canonicalJson(before.get(id)!.runtime)!==canonicalJson(member.runtime)).map(([id])=>id)};
}
export async function previewPackChange(ctx:Context,packId:string,options:Pick<MutationOptions,'project'>={}):Promise<OperationResult> {
  const fixed=await fixedProjectOptions(options),catalog=await loadCatalog(ctx),entry=catalog.skills.find(entry=>entry.id===packId&&entry.kind==='pack');if(!entry)fail('USAGE','需要完整包 ID：'+packId);await preflightProjectHome(ctx,fixed);
  return withMutation(ctx,{...fixed,dryRun:false},async()=>{const state=await loadState(ctx),scope=await scopeOf(fixed),selection=selections(state,scope)[packId],previous=selection?state.releases[selection.releaseKey]:undefined;const acquired=await acquireSkill(ctx,entry);return{id:packId,scope,from:previous?.version||null,to:entry.version,pinned:selection?.pinned||false,acquired:true,selectionChanged:false,...comparePackManifests(previous?.manifest,acquired.manifest)};});
}
async function legacyMigration(ctx:Context,packId:string,options:MutationOptions) {
  const catalog=await loadCatalog(ctx),entry=catalog.skills.find(entry=>entry.id===packId&&entry.kind==='pack');if(!entry)fail('USAGE','需要目录中的完整包 ID：'+packId);
  const state=await loadState(ctx),scope=await scopeOf(options),selected=selections(state,scope);
  const existing=entry.members!.flatMap(member=>{const choice=selected[member.legacyId];if(!choice)return[];const release=state.releases[choice.releaseKey]!;return release.manifest.schemaVersion===1?[{member,release,selection:choice}]:[];});
  const conversions=Object.values(state.projections).flatMap(projection=>{const item=existing.find(item=>item.release.key===projection.releaseKey);if(!item)return[];const targetIds=projection.targetIds.filter(id=>state.targets[id]?.scope===scope);return targetIds.length?[{path:projection.path,fromReleaseKey:projection.releaseKey,memberId:item.member.id,memberPath:item.member.path,targetIds}]:[];});
  const preview={packId,scope,version:entry.version,existingMembers:existing.map(item=>({id:item.member.id,legacyId:item.release.id,version:item.release.version,pinned:item.selection.pinned})),missingMembers:entry.members!.filter(member=>!existing.some(item=>item.member.id===member.id)).map(member=>member.id),versionDifferences:existing.map(item=>({id:item.member.id,from:item.release.version,to:entry.version,changed:item.release.version!==entry.version})),projectionConversions:conversions,memberCount:entry.members!.length,files:entry.fileCount,bytes:entry.unpackedSize,retainsLegacyReleases:true,exposure:'preserve existing per-target members; explicit agents expose the full pack'};
  return {state,scope,entry,existing,conversions,preview,catalog};
}
export async function previewLegacyMigration(ctx:Context,packId:string,options:MutationOptions={}):Promise<OperationResult> {
  return {...(await legacyMigration(ctx,packId,options)).preview,dryRun:true};
}
export async function applyLegacyMigration(ctx:Context,packId:string,options:MutationOptions={}):Promise<OperationResult> {
  const fixed=await fixedProjectOptions(options);if(fixed.dryRun)return previewLegacyMigration(ctx,packId,fixed);if(!fixed.yes)fail('USAGE','迁移需确认预览后使用 yes:true');
  return withMutation(ctx,fixed,async()=>{
    const {state,scope,entry,existing,conversions,preview,catalog}=await legacyMigration(ctx,packId,fixed);if(!existing.length)fail('USAGE','没有需要迁移的旧成员安装');
    const next=structuredClone(state),selected={...selections(next,scope)},key=releaseKey(entry.id,entry.version,entry.contentDigest,entry.integrity),old=selected[entry.id];
    if(old?.pinned&&state.releases[old.releaseKey]?.manifest.schemaVersion===2&&old.releaseKey!==key)fail('CONFLICT','父包已固定，请先 unpin');
    const acquired=await acquireSkill(ctx,entry);const release:Release={key,id:entry.id,name:entry.name,version:entry.version,packageName:entry.packageName,integrity:entry.integrity,contentDigest:entry.contentDigest,manifest:acquired.manifest,source:entry.source,installedAt:new Date().toISOString(),origin:'npm',catalogEntry:publicEntry(entry)};
    next.releases[key]=release;for(const item of existing)delete selected[item.release.id];selected[entry.id]={releaseKey:key,pinned:old?.pinned||existing.some(item=>item.selection.pinned),history:[...new Set([...(old?.history||[]),...(old&&old.releaseKey!==key?[old.releaseKey]:[])])].filter(value=>value!==key)};setSelections(next,scope,selected);
    const attachIds=new Map<string,Set<string>>();for(const conversion of conversions)for(const targetId of conversion.targetIds){const ids=attachIds.get(targetId)||new Set<string>();ids.add(entry.id+'/'+conversion.memberId);attachIds.set(targetId,ids);}
    if(fixed.agents)for(const target of await resolveTargets(next,scope,fixed.agents,fixed.mode))attachIds.set(target.id,new Set([entry.id]));
    const targets=[...attachIds.keys()].map(id=>next.targets[id]!);const changes=await reconcile(ctx,state,next,scope,new Set([entry.id,...existing.map(item=>item.release.id)]),targets,new Set(),attachIds);
    changes.push(...await projectChanges(state,next,scope,catalog.catalogVersion));await transact(ctx,state,next,changes);return {...preview,migrated:true,releaseKey:key};
  });
}
export async function verifyInstalled(ctx:Context):Promise<OperationResult>{
  const state=await loadState(ctx);const results:Array<{id:string;version:string;ok:boolean;error?:string}>=[];
  for(const r of Object.values(state.releases)){try{await verifyTree(storePath(ctx,r.contentDigest),r.manifest);results.push({id:r.id,version:r.version,ok:true});}catch(e){results.push({id:r.id,version:r.version,ok:false,error:errorMessage(e)});}}
  const projections=[];for(const p of Object.values(state.projections)){try{await checkProjection(ctx,p,state.releases[p.releaseKey]!);projections.push({path:p.path,ok:true});}catch(e){projections.push({path:p.path,ok:false,error:errorMessage(e)});}}
  return{ok:results.every(x=>x.ok)&&projections.every(x=>x.ok),releases:results,projections};
}
export async function doctor(ctx:Context):Promise<OperationResult>{const state=await loadState(ctx),verified=await verifyInstalled(ctx),pending=await pendingTransactions(ctx),runtime=await runtimeDoctor(ctx,Object.values(state.releases));return{...verified,ok:verified.ok&&pending.length===0&&runtime.node.ok&&runtime.permissions.ok&&runtime.configuration.ok&&!runtime.releases.some(r=>r.status==='missing'),pendingRecovery:pending,runtime,agents:Object.values(state.targets).map(t=>({id:t.id,path:t.path,discovery:t.discovery,hints:agentHints(t)})),network:'未请求面板或服务商；原生加载需单独验证'};}
export async function forkSkill(ctx:Context,id:string,output:string,project?:string):Promise<OperationResult>{
  const state=await loadState(ctx),r=await getRelease(state,id,project),destination=resolve(output);if(await exists(destination))fail('CONFLICT','fork输出必须是新目录');if(within(ctx.home,destination))fail('CONFLICT','定制副本不能写入SkillShelf受管数据目录');await verifyTree(storePath(ctx,r.contentDigest),r.manifest);await mkdir(dirname(destination),{recursive:true,mode:0o700});await cp(storePath(ctx,r.contentDigest),destination,{recursive:true,force:false,errorOnExist:true});
  await chmodTree(destination,false);return{id,path:destination,managed:false,sourceVersion:r.version};
}
const projectAgentSchema=z.object({agent:z.enum(['claude-code','codex','opencode','dsh','cursor','hermes','universal','custom']),relativePath:z.string().optional(),mode:z.enum(['auto','link','copy']).optional(),skills:z.array(z.string()).optional(),exposures:z.record(z.string(),z.object({all:z.boolean(),enabled:z.array(z.string()),disabled:z.array(z.string())}).strict()).optional()}).strict();
const projectSpecSchema=z.object({schemaVersion:z.union([z.literal(1),z.literal(2)]),skills:z.record(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),z.object({version:z.string().regex(EXACT_VERSION).optional(),pinned:z.boolean().optional()}).strict()),agents:z.array(projectAgentSchema).max(128)}).strict();
const projectLockSchema=z.object({schemaVersion:z.union([z.literal(1),z.literal(2)]),catalogVersion:z.string().regex(EXACT_VERSION),skills:z.array(z.object({id:z.string(),name:z.string(),packageName:z.string(),version:z.string().regex(EXACT_VERSION),integrity:z.string(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/),entry:z.unknown().optional(),manifest:z.unknown().optional(),source:z.unknown().optional(),origin:z.enum(['npm','local','panel','github']).optional()}).strict()).max(1000),agents:z.array(projectAgentSchema).max(128)}).strict();
export async function syncFrozen(ctx:Context,options:MutationOptions):Promise<OperationResult>{const fixed=await fixedProjectOptions(options);return withMutation(ctx,fixed,()=>syncFrozenInternal(ctx,fixed));}
async function syncFrozenInternal(ctx:Context,options:MutationOptions):Promise<OperationResult>{
  if(!options.project)fail('USAGE','sync --frozen 需要 --project <目录>');const root=await canonicalProjectPath(options.project);
  const guards=[{path:join(root,'skillshelf-lock.json'),expected:await fingerprint(join(root,'skillshelf-lock.json'))},{path:join(root,'skillshelf.json'),expected:await fingerprint(join(root,'skillshelf.json'))}];
  const lock=await readJson<ProjectLock>(join(root,'skillshelf-lock.json')),spec=await readJson<ProjectSpec>(join(root,'skillshelf.json'));
  if(!projectLockSchema.safeParse(lock).success||!projectSpecSchema.safeParse(spec).success)fail('INTEGRITY','项目锁/声明格式无效');
  if(canonicalJson(spec.agents)!==canonicalJson(lock.agents))fail('CONFLICT','项目Agent声明和锁不一致');
  if(new Set(lock.skills.map(s=>s.id)).size!==lock.skills.length)fail('INTEGRITY','项目锁技能ID重复');
  if(JSON.stringify(Object.keys(spec.skills).sort())!==JSON.stringify(lock.skills.map(s=>s.id).sort()))fail('CONFLICT','项目声明和锁文件不一致');
  const catalog=await loadCatalog(ctx);const entries:CatalogEntry[]=lock.skills.filter(item=>item.origin!=='local'&&item.origin!=='panel').map(item=>{const base=item.entry||catalog.skills.find(x=>x.id===item.id);if(!base)fail('UNAVAILABLE','锁文件缺少完整的版本元数据：'+item.id);if(spec.skills[item.id]?.version&&spec.skills[item.id]!.version!==item.version)fail('CONFLICT','项目声明版本和锁不一致：'+item.id);const entry={...base,id:item.id,name:item.name,packageName:item.packageName,version:item.version,integrity:item.integrity,contentDigest:item.contentDigest};if(item.entry&&(item.entry.id!==item.id||item.entry.name!==item.name||item.entry.version!==item.version||item.entry.integrity!==item.integrity||item.entry.contentDigest!==item.contentDigest||item.entry.packageName!==item.packageName))fail('INTEGRITY','锁定版本快照与顶层字段不一致');return entry;});
  const state=await loadState(ctx),next=structuredClone(state),targets:AgentTarget[]=[],attachIds=new Map<string,Set<string>>(),detached=new Set(activeTargets(state,root).map(t=>t.id));
  for(const id of detached)delete next.targets[id];
  for(const t of lock.agents){const path=t.relativePath?resolve(root,safeRelativePath(t.relativePath)):undefined;if(path&&!within(root,path))fail('INTEGRITY','项目目标越界');const target=await resolveAgentTarget(t.agent,{project:root,path,mode:t.mode});if(targets.some(x=>x.id===target.id))fail('INTEGRITY','项目目标重复');if(t.skills&&(new Set(t.skills).size!==t.skills.length||t.skills.some(id=>!lock.skills.some(s=>s.id===id||(s.entry?.members||s.manifest?.members)?.some(member=>id===s.id+'/'+member.id)))))fail('INTEGRITY','目标技能选择无效');next.targets[target.id]=target;for(const [packId,exposure] of Object.entries(t.exposures||{}))setExposure(next,target.id,packId,exposure);const requested=new Set(t.skills||lock.skills.map(s=>s.id));for(const [packId,exposure] of Object.entries(t.exposures||{}))if(exposure.all)requested.add(packId);targets.push(target);attachIds.set(target.id,requested);}
  await validateHomeLocation(ctx,Object.values(next.targets),{projects:[root]});
  if(options.dryRun)return{scope:root,skills:entries.map(e=>({id:e.id,version:e.version})),targets,dryRun:true,frozen:true};
  const selected:Record<string,Selection>={};
  for(const entry of entries){const a=await acquireLockedSkill(ctx,entry),key=releaseKey(entry.id,entry.version,entry.contentDigest,a.manifest.schemaVersion===2?entry.integrity:'');const locked=lock.skills.find(item=>item.id===entry.id)!;if(locked.manifest&&canonicalJson(validateManifest(locked.manifest))!==canonicalJson(a.manifest))fail('INTEGRITY','锁定包 manifest 不一致');if(locked.source&&canonicalJson(locked.source)!==canonicalJson(entry.source))fail('INTEGRITY','锁定来源不一致');const frozenGithub=entry.sourceManifest?.acquisition.kind==='github';
    next.releases[key]={key,id:entry.id,name:entry.name,version:entry.version,packageName:entry.packageName,integrity:entry.integrity,contentDigest:entry.contentDigest,manifest:a.manifest,source:entry.source,installedAt:new Date().toISOString(),origin:frozenGithub?'github':'npm',catalogEntry:publicEntry(entry),...(frozenGithub?{acquisition:entry.acquisition,sourceManifest:entry.sourceManifest,packRevision:entry.packRevision}:{})};selected[entry.id]={releaseKey:key,pinned:spec.skills[entry.id]?.pinned||false,history:[]};}
  for(const item of lock.skills.filter(item=>item.origin==='local'||item.origin==='panel')){
    if(item.entry||item.packageName!=='local:'+item.id||item.integrity!==''||!item.manifest)fail('INTEGRITY','本地锁记录无效');
    const manifest=validateManifest(item.manifest);if(manifest.id!==item.id||manifest.name!==item.name||manifest.contentDigest!==item.contentDigest)fail('INTEGRITY','本地锁 manifest 身份不一致');
    if(spec.skills[item.id]?.version&&spec.skills[item.id]!.version!==item.version)fail('CONFLICT','项目声明版本和锁不一致');
    await verifyTree(storePath(ctx,item.contentDigest),manifest);const key=releaseKey(item.id,item.version,item.contentDigest);
    next.releases[key]={key,id:item.id,name:item.name,version:item.version,packageName:item.packageName,integrity:'',contentDigest:item.contentDigest,manifest,source:item.source||{},installedAt:new Date().toISOString(),origin:item.origin!};
    selected[item.id]={releaseKey:key,pinned:spec.skills[item.id]?.pinned||false,history:[]};
  }
  setSelections(next,root,selected);next.projects[root]!.specHash=guards[1]!.expected||undefined;next.projects[root]!.lockHash=guards[0]!.expected||undefined;
  const changes=await reconcile(ctx,state,next,root,new Set([...Object.keys(selections(state,root)),...Object.keys(selected)]),targets,detached,attachIds);
  // Frozen restore never rewrites the declaration or lock and guards their read snapshots.
  await transact(ctx,state,next,changes,{guards});return{scope:root,restored:Object.keys(selected),frozen:true,discovery:'unverified'};
}
