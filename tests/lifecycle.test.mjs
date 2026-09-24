import test from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync, unlinkSync } from 'node:fs';
import { mkdir, mkdtemp, cp, writeFile, readFile, lstat, readdir, chmod, rm, symlink, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadCatalog } from '../packages/cli/dist/catalog/catalog.js';
import { loadState } from '../packages/cli/dist/store/state.js';
import { addAgent, installSkills, toggleSkills, checkUpdates, updateSkills, pinSkills, rollbackSkill, readSkill, removeSkills, syncFrozen, verifyInstalled } from '../packages/cli/dist/manager.js';
import { exportLibrary, importLibrary, migratePanel } from '../packages/cli/dist/commands/portable.js';
import { planMutation, applyMutation } from '../packages/cli/dist/core.js';
import { inventory, digestManifest } from '../packages/cli/dist/validation.js';
import { makeTarball } from '../scripts/lib.mjs';
import { legacyCatalogFixture } from './legacy-fixture.mjs';
const catalogPath=await legacyCatalogFixture(process.env.SKILLSHELF_TEST_CATALOG);
const requiresPacks={skip:catalogPath?false:'Set SKILLSHELF_TEST_CATALOG to verified development catalog after pack'};
async function cleanup(path){const s=await lstat(path);if(s.isSymbolicLink())return;if(s.isDirectory()){await chmod(path,0o700);for(const name of await readdir(path))await cleanup(join(path,name));}else await chmod(path,0o600);}
async function fixture(t){const root=await mkdtemp(join(process.env.SKILLSHELF_TEST_TMP||tmpdir(),'skillshelf-lifecycle-'));t.after(async()=>{await cleanup(root);await rm(root,{recursive:true,force:true});});return{root,ctx:{home:join(root,'home'),offline:true,catalogPath}};}
async function updatedCatalog(root,original,id,version,body){const old=original.skills.find(e=>e.id===id);const source=join(root,'version-'+version);await mkdir(source);await writeFile(join(source,'SKILL.md'),`---\nname: ${id}\ndescription: Fixture revision\n---\n${body}\n`);await writeFile(join(source,'LICENSE'),'MIT\n');const files=await inventory(source),runtime={kind:'instructions',requiresNetwork:false},contentDigest=digestManifest(files),manifest={schemaVersion:1,id,name:id,files,contentDigest,runtime};const bytes=makeTarball([{path:'package/package.json',data:JSON.stringify({name:old.packageName,version,license:'MIT',files:['skill/','skillshelf.manifest.json','LICENSE']})},{path:'package/skillshelf.manifest.json',data:JSON.stringify(manifest)},{path:'package/LICENSE',data:'MIT\n'},...await Promise.all(files.map(async f=>({path:'package/skill/'+f.path,data:await readFile(join(source,f.path)),executable:f.executable})))]);const artifact=id+'-'+version+'.tgz';await writeFile(join(root,artifact),bytes);const entry={...old,version,runtime,contentDigest,integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64'),fileCount:files.length,unpackedSize:files.reduce((s,f)=>s+f.size,0),localArtifact:artifact};const catalog={...original,catalogVersion:version,skills:original.skills.map(e=>e.id===id?entry:e)};const file=join(root,'catalog-'+version+'.json');await writeFile(file,JSON.stringify(catalog));return file;}

test('legacy v1 child releases remain installable and verify complete trees',requiresPacks,async t=>{const{ctx}=await fixture(t),catalog=await loadCatalog(ctx);const source=JSON.parse(await readFile(fileURLToPath(new URL('../catalog/sources.json',import.meta.url)),'utf8'));assert.equal(catalog.skills.length,source.skills.length);await installSkills(ctx,['ui-ux-pro-max'],{agents:[]});let state=await loadState(ctx);assert.equal(Object.keys(state.selections).length,1);assert.equal((await readdir(join(ctx.home,'artifacts'))).length,1);assert.equal(state.releases[state.selections['ui-ux-pro-max'].releaseKey].manifest.files.length,74);await installSkills(ctx,catalog.skills.map(e=>e.id),{agents:[]});assert.equal((await verifyInstalled(ctx)).ok,true);assert.equal(Object.keys((await loadState(ctx)).selections).length,source.skills.length);});
test('real first-party Python help works through CLI with and without one separator and no providers',requiresPacks,async t=>{
  const probe=spawnSync(process.env.SKILLSHELF_PYTHON||'python3',['-I','-B','-S','-c','import sys;print(sys.version_info >= (3,10))'],{encoding:'utf8'});
  if(probe.status!==0||probe.stdout.trim()!=='True'){t.skip('Python 3.10+ not installed; real CLI/Python coverage requires it');return;}
  const {ctx}=await fixture(t),ids=['skillshelf-web-search','skillshelf-media-generation'];await installSkills(ctx,ids,{agents:[]});
  const cli=fileURLToPath(new URL('../packages/cli/dist/index.js',import.meta.url));
  for(const id of ids)for(const separator of [[],['--']]){
    const result=spawnSync(process.execPath,[cli,'--home',ctx.home,'--offline','--json','run',id,...separator,'--help'],{encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'cp1252',PYTHONUTF8:'0'}});
    assert.equal(result.status,0,result.stdout+result.stderr);const data=JSON.parse(result.stdout).data;assert.equal(data.exitCode,0);assert.match(data.stdout,/usage:/);assert.match(data.stdout,/本地直连/u);assert.equal(data.stderr,'');
  }
  assert.deepEqual(await readdir(join(ctx.home,'runtime')),[]);await assert.rejects(lstat(join(ctx.home,'config','providers.json')),{code:'ENOENT'});
});
test('global pin/update/rollback leaves project pin and disabled targets alone',requiresPacks,async t=>{const{root,ctx}=await fixture(t),id='brandkit';const catalog=await loadCatalog(ctx);const a=(await addAgent(ctx,'custom',{path:join(root,'a','skills')})).target;const b=(await addAgent(ctx,'custom',{path:join(root,'b','skills')})).target;await installSkills(ctx,[id],{agents:[a.id,b.id]});await toggleSkills(ctx,[id],false,{agents:[b.id]});const project=join(root,'project');await mkdir(project);await installSkills(ctx,[id],{project,agents:['codex']});const projectBefore=await readFile(join(project,'skillshelf-lock.json'),'utf8');const newer=await updatedCatalog(root,catalog,id,'0.2.0','new release');const updateCtx={...ctx,catalogPath:newer};await pinSkills(ctx,[id],true);assert.deepEqual((await updateSkills(updateCtx,[])).updated,[]);await pinSkills(ctx,[id],false);const homeBefore=JSON.stringify(await loadState(ctx));assert.equal((await checkUpdates(updateCtx)).updates.length,1);assert.equal(JSON.stringify(await loadState(ctx)),homeBefore);await updateSkills(updateCtx,[]);let state=await loadState(ctx);assert.equal(state.releases[state.selections[id].releaseKey].version,'0.2.0');assert.equal(Object.values(state.projections).filter(p=>p.targetIds.includes(b.id)).length,0);assert.equal(await readFile(join(project,'skillshelf-lock.json'),'utf8'),projectBefore);await rollbackSkill(ctx,id,undefined);state=await loadState(ctx);assert.equal(state.releases[state.selections[id].releaseKey].version,catalog.skills.find(e=>e.id===id).version);});
test('frozen project restore is portable, offline, exact, and preserves both files',requiresPacks,async t=>{const{root,ctx}=await fixture(t),project=join(root,'original');await mkdir(project);await installSkills(ctx,['brandkit'],{project,agents:['codex']});const destination=join(root,'moved');await mkdir(destination);for(const file of['skillshelf.json','skillshelf-lock.json'])await cp(join(project,file),join(destination,file));const files=await Promise.all(['skillshelf.json','skillshelf-lock.json'].map(f=>readFile(join(destination,f),'utf8')));const other={...ctx,home:join(root,'other')};await syncFrozen(other,{project:destination});assert.deepEqual(await Promise.all(['skillshelf.json','skillshelf-lock.json'].map(f=>readFile(join(destination,f),'utf8'))),files);assert.equal((await verifyInstalled(other)).ok,true);await writeFile(join(destination,'skillshelf.json'),files[0]+' ');await assert.rejects(pinSkills(other,['brandkit'],true,{project:destination}),/本地修改/);});
test('project symlink and real path share one install, read, plan, export and frozen sync identity',requiresPacks,async t=>{
  const{root,ctx}=await fixture(t),project=join(root,'project'),alias=join(root,'alias');await mkdir(project);
  try{await symlink(project,alias,process.platform==='win32'?'junction':'dir');}
  catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Host has no junction privilege');return;}throw error;}
  const installed=await installSkills(ctx,['brandkit'],{project:alias,agents:['codex']});
  assert.equal(installed.scope,project);
  let state=await loadState(ctx);
  assert.deepEqual(Object.keys(state.projects),[project]);
  assert.equal(Object.values(state.projections).length,1);
  assert.equal(Object.values(state.targets)[0].scope,project);
  const fromAlias=await readSkill(ctx,'brandkit','SKILL.md',alias);
  assert.deepEqual(await readSkill(ctx,'brandkit','SKILL.md',project),fromAlias);
  const plan=await planMutation(ctx,'pin',['brandkit'],{project:alias});
  assert.equal(plan.options.project,project);
  const other=join(root,'other-project');await mkdir(other);await unlink(alias);
  await symlink(other,alias,process.platform==='win32'?'junction':'dir');
  await applyMutation(ctx,plan,{yes:true});
  await unlink(alias);await symlink(project,alias,process.platform==='win32'?'junction':'dir');
  state=await loadState(ctx);assert.equal(state.projects[project].selections.brandkit.pinned,true);
  const output=join(root,'selection.json');
  assert.deepEqual((await exportLibrary(ctx,output,{project:alias,dryRun:true})).skills,['brandkit']);
  await installSkills(ctx,['brandkit'],{project,agents:['codex']});
  const lock=await readFile(join(project,'skillshelf-lock.json'),'utf8');
  const synced=await syncFrozen(ctx,{project:alias});
  assert.equal(synced.scope,project);
  assert.equal(await readFile(join(project,'skillshelf-lock.json'),'utf8'),lock);
  const cli=fileURLToPath(new URL('../packages/cli/dist/index.js',import.meta.url));
  const command=(...args)=>{const result=spawnSync(process.execPath,[cli,'--home',ctx.home,'--catalog',catalogPath,'--offline','--json',...args],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);return JSON.parse(result.stdout).data;};
  assert.ok(command('files','brandkit','--project',alias).some(file=>file.path==='SKILL.md'));
  assert.match(command('read','brandkit','--project',alias).content,/brandkit/);
  assert.equal(command('sync','--frozen','--project',alias,'--dry-run').scope,project);
  assert.deepEqual(Object.keys((await loadState(ctx)).projects),[project]);
  assert.equal((await verifyInstalled(ctx)).ok,true);
});
test('project alias retargeted after preflight cannot redirect direct install, sync or import',requiresPacks,async t=>{
  const{root,ctx}=await fixture(t),project=join(root,'project'),other=join(root,'other'),alias=join(root,'alias');
  await mkdir(project);await mkdir(other);
  const linkType=process.platform==='win32'?'junction':'dir';
  try{await symlink(project,alias,linkType);}
  catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Host has no junction privilege');return;}throw error;}
  const repoint=destination=>{unlinkSync(alias);symlinkSync(destination,alias,linkType);};
  const contextRetargetingDuringInit=()=>{
    let changed=false;
    const moving={...ctx,get home(){
      if(!changed&&/\bat initHome\b/u.test(new Error().stack||'')){repoint(other);changed=true;}
      return ctx.home;
    }};
    return{moving,changed:()=>changed};
  };
  let probe=contextRetargetingDuringInit();
  assert.equal((await installSkills(probe.moving,['brandkit'],{project:alias,agents:[]})).scope,project);
  assert.equal(probe.changed(),true);
  assert.equal((await loadState(ctx)).projects[other],undefined);
  repoint(project);
  probe=contextRetargetingDuringInit();
  assert.equal((await syncFrozen(probe.moving,{project:alias})).scope,project);
  assert.equal(probe.changed(),true);
  repoint(project);
  const selection=join(root,'selection.json');await exportLibrary(ctx,selection,{project});
  probe=contextRetargetingDuringInit();
  assert.equal((await importLibrary(probe.moving,selection,{project:alias})).scope,project);
  assert.equal(probe.changed(),true);
  assert.deepEqual(Object.keys((await loadState(ctx)).projects),[project]);
});
test('complete bundle carries original verified artifacts and restores historical release offline',requiresPacks,async t=>{const{root,ctx}=await fixture(t);await installSkills(ctx,['skillshelf-web-search','ui-ux-pro-max'],{agents:[]});const output=join(root,'bundle');await exportLibrary(ctx,output,{bundle:true});const other={...ctx,home:join(root,'other')};await importLibrary(other,output,{});const state=await loadState(other);assert.equal(Object.values(state.releases).every(r=>r.origin==='npm'),true);assert.equal((await readdir(join(other.home,'artifacts'))).length,2);assert.equal((await verifyInstalled(other)).ok,true);});
test('same-version mode changes to copy without an explicit agent',requiresPacks,async t=>{
  const{root,ctx}=await fixture(t);
  const a=(await addAgent(ctx,'custom',{path:join(root,'agent','skills')})).target;
  await installSkills(ctx,['brandkit'],{agents:[a.id]});
  await installSkills(ctx,['brandkit'],{mode:'copy'});
  const projection=Object.values((await loadState(ctx)).projections).find(p=>p.path===join(a.path,'brandkit'));
  assert.equal(projection?.mode,'copy');
  assert.equal((await lstat(join(a.path,'brandkit'))).isSymbolicLink(),false);
  assert.equal((await verifyInstalled(ctx)).ok,true);
});
test('same-version explicit link mode and conflicting target stay safe',requiresPacks,async t=>{
  const{root,ctx}=await fixture(t);
  if(process.platform==='win32'){
    const target=join(root,'junction-target'),probe=join(root,'junction-probe');
    await mkdir(target);
    try{await symlink(target,probe,'junction');}
    catch(error){
      if(['EPERM','EACCES','ENOTSUP','EINVAL','UNKNOWN'].includes(error.code)){
        t.skip('Windows runner cannot create junctions; auto and copy projection paths remain covered');
        return;
      }
      throw error;
    }
    await rm(probe);
  }
  const a=(await addAgent(ctx,'custom',{path:join(root,'agent','skills')})).target;
  await installSkills(ctx,['brandkit'],{agents:[a.id]});
  await installSkills(ctx,['brandkit'],{mode:'copy'});
  await installSkills(ctx,['brandkit'],{mode:'link'});
  assert.equal((await lstat(join(a.path,'brandkit'))).isSymbolicLink(),true);
  const b=(await addAgent(ctx,'dsh',{path:a.path,mode:'copy'})).target;
  await assert.rejects(toggleSkills(ctx,['brandkit'],true,{agents:[b.id]}),/冲突/);
});
test('frozen disabled target selection removes old project projections exactly',requiresPacks,async t=>{const{root,ctx}=await fixture(t),project=join(root,'project');await mkdir(project);await installSkills(ctx,['brandkit'],{project,agents:['codex']});const spec=JSON.parse(await readFile(join(project,'skillshelf.json'),'utf8')),lock=JSON.parse(await readFile(join(project,'skillshelf-lock.json'),'utf8'));spec.agents=[];lock.agents=[];await writeFile(join(project,'skillshelf.json'),JSON.stringify(spec));await writeFile(join(project,'skillshelf-lock.json'),JSON.stringify(lock));await syncFrozen(ctx,{project});assert.equal(Object.values((await loadState(ctx)).projections).length,0);assert.equal(Object.values((await loadState(ctx)).targets).length,0);});
test('historical bundle claims cannot self-authorize first-party execution',requiresPacks,async t=>{const{root,ctx}=await fixture(t);await installSkills(ctx,['skillshelf-web-search'],{agents:[]});const output=join(root,'bundle');await exportLibrary(ctx,output,{bundle:true});const empty=join(root,'empty.json');await writeFile(empty,JSON.stringify({schemaVersion:1,catalogVersion:'0.1.0-preview.1',minCliVersion:'0.1.0-preview.1',scope:'@llx17669475',categories:[],collections:[],skills:[]}));const other={home:join(root,'other'),offline:true,catalogPath:empty};await importLibrary(other,output);assert.equal(Object.values((await loadState(other)).releases)[0].origin,'local');});
test('legacy migration preserves modified bytes, skips missing license, and never touches old state',requiresPacks,async t=>{const{root,ctx}=await fixture(t),old=join(root,'legacy'),target=join(root,'old-skills');await mkdir(old);const managed={};for(const name of['legacy-complete','legacy-no-license']){await mkdir(join(target,name),{recursive:true});await writeFile(join(target,name,'SKILL.md'),`---\nname: ${name}\ndescription: Legacy\n---\nold user bytes\n`);if(name==='legacy-complete')await writeFile(join(target,name,'LICENSE'),'Original license retained\n');const files=await inventory(join(target,name));managed[name]={revision:'old-python-json-digest',hashes:Object.fromEntries(files.map(f=>[f.path,f.sha256]))};}const original=JSON.stringify({target,managed});await writeFile(join(old,'state.json'),original);await writeFile(join(target,'legacy-complete','custom.txt'),'locally modified');const result=await migratePanel(ctx,old);assert.equal(result.imported[0].modified,true);assert.equal(result.skipped.length,1);assert.equal(await readFile(join(old,'state.json'),'utf8'),original);assert.equal((await readSkill(ctx,'legacy-complete','custom.txt')).content,'locally modified');});
test('CLI emits stable JSON, requires explicit non-TTY confirmation, offline check is read-only',requiresPacks,async t=>{const{root,ctx}=await fixture(t);const cli=fileURLToPath(new URL('../packages/cli/dist/index.js',import.meta.url));const run=(...args)=>spawnSync(process.execPath,[cli,'--home',ctx.home,'--catalog',catalogPath,'--offline','--json',...args],{encoding:'utf8'});let result=run('list');assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).data.skills.length,(await loadCatalog(ctx)).skills.length);result=run('install','brandkit');assert.equal(result.status,2);assert.equal(JSON.parse(result.stdout).error.code,'USAGE');result=run('install','brandkit','--yes');assert.equal(result.status,0,result.stdout+result.stderr);const before=await readFile(join(ctx.home,'state.json'),'utf8');result=run('check');assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(await readFile(join(ctx.home,'state.json'),'utf8'),before);result=run('run','brandkit','--','--help');assert.equal(result.status,9,result.stdout+result.stderr);});
