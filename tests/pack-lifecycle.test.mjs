import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, stat, realpath, cp, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadCatalog, searchCatalog } from '../packages/cli/dist/catalog/catalog.js';
import { emptyState, loadState, storePath, validateState } from '../packages/cli/dist/store/state.js';
import { chmodTree } from '../packages/cli/dist/store/local.js';
import { installSkills, addAgent, toggleSkills, readSkill, updateSkills, rollbackSkill, pinSkills, syncFrozen, verifyInstalled, removeSkills, importValidatedPack, setLocalPreference, previewLegacyMigration, applyLegacyMigration, comparePackManifests } from '../packages/cli/dist/manager.js';
import { inventory, digestManifest, canonicalJson, validateCatalog } from '../packages/cli/dist/validation.js';
import { makeTarball, integrityFor, root, readJsonFile, modules } from '../scripts/lib.mjs';
import { packDefinitions, packContents } from '../scripts/packs.mjs';
import { info } from '../packages/cli/dist/core.js';
import { exportLibrary, importLibrary } from '../packages/cli/dist/commands/portable.js';
import { legacyCatalogFixture } from './legacy-fixture.mjs';

const catalogPath=process.env.SKILLSHELF_PACK_TEST_CATALOG||process.env.SKILLSHELF_TEST_CATALOG;
const requiresPacks={skip:catalogPath?false:'Set SKILLSHELF_PACK_TEST_CATALOG to schema2 development catalog'};
async function writable(root){const info=await lstat(root);if(info.isSymbolicLink())return;await chmod(root,info.isDirectory()?0o700:0o600);if(info.isDirectory())for(const name of await readdir(root))await writable(path.join(root,name));}
async function fixture(t){const root=await mkdtemp(path.join(process.env.SKILLSHELF_TEST_TMP||tmpdir(),'pack-lifecycle-'));t.after(async()=>{await writable(root);await rm(root,{recursive:true,force:true});});return{root,ctx:{home:path.join(root,'home'),offline:true,catalogPath}};}
async function newVersion(root,catalog,entry,manifest,source){
  const destination=path.join(root,'revision');await cp(source,destination,{recursive:true});await chmodTree(destination,false);
  const document=path.join(destination,manifest.members[0].path,'SKILL.md');await writeFile(document,(await readFile(document,'utf8'))+'\nRevision fixture.\n');
  const files=await inventory(destination),updated={...manifest,files,contentDigest:'0'.repeat(64)},version='0.2.1';updated.contentDigest=(await import('../packages/cli/dist/validation.js')).digestPackManifest(updated);
  const archive=makeTarball([{path:'package/package.json',data:JSON.stringify({name:entry.packageName,version,license:entry.license,files:['skill/','skillshelf.manifest.json','LICENSE']})},{path:'package/skillshelf.manifest.json',data:JSON.stringify(updated)},{path:'package/LICENSE',data:await readFile(path.join(destination,'LICENSE'))},...await Promise.all(files.map(async file=>({path:'package/skill/'+file.path,data:await readFile(path.join(destination,file.path)),executable:file.executable})))]);
  await writeFile(path.join(root,'revision.tgz'),archive);const changed={...entry,version,contentDigest:updated.contentDigest,integrity:integrityFor(archive),fileCount:files.length,unpackedSize:files.reduce((sum,file)=>sum+file.size,0),localArtifact:'revision.tgz'};
  const filename=path.join(root,'revision-catalog.json');await writeFile(filename,JSON.stringify({...catalog,skills:catalog.skills.map(row=>row.id===entry.id?changed:{...row,localArtifact:undefined})}));return{...changed,catalogPath:filename};
}

test('catalog contains source-derived packs, curated children and exact original inventory',requiresPacks,async t=>{
  const {ctx}=await fixture(t),catalog=await loadCatalog(ctx),config=await readJsonFile(path.join(root,'catalog/sources.json')),api=await modules();
  assert.equal(catalog.schemaVersion,2);assert.equal(catalog.categories.length,12);assert.equal(catalog.skills.length,packDefinitions(config).length);
  assert.equal(catalog.skills.reduce((sum,pack)=>sum+pack.members.length,0),config.skills.length);
  for(const definition of packDefinitions(config)){const expected=await packContents(config,definition,api),entry=catalog.skills.find(pack=>pack.id===definition.id);assert.deepEqual(entry.members,expected.manifest.members);assert.equal(entry.fileCount,expected.manifest.files.length);assert.equal(entry.contentDigest,expected.manifest.contentDigest);for(const member of entry.members){assert.match(member.description,/[\u4e00-\u9fff]/u);assert.ok(member.examples.length);assert.ok(catalog.categories.some(category=>category.id===member.category&&category.children.some(child=>child.id===member.subcategory)));}}
  const search=searchCatalog(catalog,'frontend');assert.ok(search.some(pack=>pack.id==='taste'&&pack.matchedMembers.some(member=>member.id==='image-to-code')));
  const fullStack=searchCatalog(catalog,'',{category:'full-stack'});assert.ok(fullStack.every(pack=>pack.id!=='taste'));
  assert.ok(catalog.skills.find(pack=>pack.id==='gitnexus').license.includes('Noncommercial'));
});
test('whole Taste install shares physical member files across targets and disables exposure only',requiresPacks,async t=>{
  const {root,ctx}=await fixture(t),first=(await addAgent(ctx,'custom',{path:path.join(root,'a','skills')})).target,second=(await addAgent(ctx,'custom',{path:path.join(root,'b','skills')})).target;
  await installSkills(ctx,['taste'],{agents:[first.id]});const state=await loadState(ctx),release=state.releases[state.selections.taste.releaseKey],contentRoot=storePath(ctx,release.contentDigest);
  const before=await readdir(path.join(ctx.home,'artifacts'));await installSkills(ctx,['taste'],{agents:[second.id]});assert.deepEqual(await readdir(path.join(ctx.home,'artifacts')),before);
  assert.equal(Object.keys((await loadState(ctx)).selections).length,1);assert.equal(Object.values((await loadState(ctx)).projections).length,release.manifest.members.length*2);
  for(const member of release.manifest.members){const left=path.join(first.path,member.name),right=path.join(second.path,member.name);assert.equal(await realpath(left),path.join(contentRoot,member.path));assert.equal(await realpath(right),await realpath(left));assert.equal((await stat(path.join(left,'SKILL.md'))).ino,(await stat(path.join(right,'SKILL.md'))).ino);}
  const text=await readSkill(ctx,'taste/image-to-code');assert.match(text.content,/image-to-code/);assert.equal((await readSkill(ctx,'image-to-code')).path,text.path);
  await toggleSkills(ctx,['taste/image-to-code'],false,{agents:[first.id]});await assert.rejects(lstat(path.join(first.path,'image-to-code')),{code:'ENOENT'});assert.ok(await lstat(path.join(second.path,'image-to-code')));assert.ok(await lstat(text.path));
  await toggleSkills(ctx,['taste/image-to-code'],true,{agents:[first.id]});assert.equal(await realpath(path.join(first.path,'image-to-code')),path.join(contentRoot,release.manifest.members.find(member=>member.id==='image-to-code').path));assert.equal((await verifyInstalled(ctx)).ok,true);
});
test('cross-member references resolve inside the complete immutable store',requiresPacks,async t=>{
  const {ctx}=await fixture(t);await installSkills(ctx,['superpowers'],{agents:[]});const document=await readSkill(ctx,'superpowers/writing-skills');assert.match(document.content,/\.\.\/using-superpowers\/references\/codex-tools.md/);
  const reference=path.resolve(path.dirname(document.path),'../using-superpowers/references/codex-tools.md');assert.match(await readFile(reference,'utf8'),/Codex/);
});
test('failed acquisition cannot expose a partial pack or selection',requiresPacks,async t=>{
  const {root,ctx}=await fixture(t),catalog=await loadCatalog(ctx),entry=catalog.skills.find(pack=>pack.id==='taste');
  const archive=await readFile(path.resolve(path.dirname(catalogPath),entry.localArtifact));archive[20]^=1;await writeFile(path.join(root,'broken.tgz'),archive);
  const broken=path.join(root,'broken.json');await writeFile(broken,JSON.stringify({...catalog,skills:catalog.skills.map(pack=>pack.id==='taste'?{...pack,localArtifact:'broken.tgz'}:{...pack,localArtifact:undefined})}));
  const target=(await addAgent(ctx,'custom',{path:path.join(root,'agent','skills')})).target;const before=await loadState(ctx);
  await assert.rejects(installSkills({...ctx,catalogPath:broken},['taste'],{agents:[target.id]}));assert.deepEqual(await loadState(ctx),before);await assert.rejects(lstat(path.join(target.path,'image-to-code')),{code:'ENOENT'});
});
test('whole pack update and rollback preserve independent project version and member exposure',requiresPacks,async t=>{
  const {root,ctx}=await fixture(t),catalog=await loadCatalog(ctx),target=(await addAgent(ctx,'custom',{path:path.join(root,'global','skills')})).target;
  await installSkills(ctx,['taste'],{agents:[target.id]});await toggleSkills(ctx,['taste/brandkit'],false,{agents:[target.id]});const project=path.join(root,'project');await mkdir(project);await installSkills(ctx,['taste'],{project,agents:['codex']});await pinSkills(ctx,['taste'],true,{project});
  const original=await loadState(ctx),release=original.releases[original.selections.taste.releaseKey],entry=catalog.skills.find(pack=>pack.id==='taste');const changed=await newVersion(root,catalog,entry,release.manifest,storePath(ctx,release.contentDigest));await updateSkills({...ctx,catalogPath:changed.catalogPath},['taste']);
  let state=await loadState(ctx);assert.equal(state.releases[state.selections.taste.releaseKey].version,changed.version);assert.equal(state.projects[project].selections.taste.releaseKey,original.projects[project].selections.taste.releaseKey);assert.equal(state.projects[project].selections.taste.pinned,true);
  assert.equal(Object.values(state.projections).filter(projection=>projection.targetIds.includes(target.id)).length,release.manifest.members.length-1);await assert.rejects(lstat(path.join(target.path,'brandkit')),{code:'ENOENT'});
  await rollbackSkill(ctx,'taste',undefined);state=await loadState(ctx);assert.equal(state.selections.taste.releaseKey,original.selections.taste.releaseKey);assert.equal((await verifyInstalled(ctx)).ok,true);
});
test('schema2 project locks preserve members and offline frozen member exposure',requiresPacks,async t=>{
  const {root,ctx}=await fixture(t),project=path.join(root,'project');await mkdir(project);await installSkills(ctx,['superpowers'],{project,agents:['codex']});const state=await loadState(ctx),target=Object.values(state.targets)[0];await toggleSkills(ctx,['superpowers/writing-skills'],false,{project,agents:[target.id]});
  const lock=JSON.parse(await readFile(path.join(project,'skillshelf-lock.json'),'utf8'));assert.equal(lock.schemaVersion,2);assert.deepEqual(lock.skills[0].manifest.members,lock.skills[0].entry.members);assert.ok(lock.agents[0].skills.every(id=>id.includes('/')));
  const moved=path.join(root,'moved');await mkdir(moved);for(const file of ['skillshelf.json','skillshelf-lock.json'])await cp(path.join(project,file),path.join(moved,file));
  const before=await readFile(path.join(moved,'skillshelf-lock.json'),'utf8');await syncFrozen(ctx,{project:moved});assert.equal(await readFile(path.join(moved,'skillshelf-lock.json'),'utf8'),before);
  const next=await loadState(ctx);assert.equal(Object.values(next.projections).filter(projection=>next.targets[projection.targetIds[0]].scope===moved).length,lock.skills[0].manifest.members.length-1);assert.equal((await verifyInstalled(ctx)).ok,true);
});
test('schema1 is readable without migration and legacy child installation explains its parent',requiresPacks,async t=>{
  const {ctx}=await fixture(t);const state=emptyState();state.schemaVersion=1;assert.deepEqual(validateState(state),state);assert.equal((await loadState(ctx)).generation,0);
  await assert.rejects(installSkills(ctx,['brandkit'],{agents:[]}),/显式安装完整包 taste/);assert.deepEqual((await loadState(ctx)).selections,{});
  await installSkills(ctx,['taste'],{agents:[]});await setLocalPreference(ctx,'taste/brandkit',{favorite:true,tags:['客户项目'],category:'media'});const catalog=await loadCatalog(ctx);assert.equal(catalog.skills.find(pack=>pack.id==='taste').members.find(member=>member.id==='brandkit').category,'design');assert.equal((await loadState(ctx)).preferences['taste/brandkit'].favorite,true);
  await removeSkills(ctx,['taste']);assert.deepEqual((await loadState(ctx)).selections,{});
});
test('local validated packs retain complete metadata in frozen locks and portable bundles',requiresPacks,async t=>{
  const {root,ctx}=await fixture(t);await installSkills(ctx,['taste'],{agents:[]});const state=await loadState(ctx),release=state.releases[state.selections.taste.releaseKey],source=path.join(root,'authored');
  await cp(storePath(ctx,release.contentDigest),source,{recursive:true});await chmodTree(source,false);await writeFile(path.join(source,'AUTHORING.md'),'Locally authored pack fixture.\n');
  const files=await inventory(source),manifest={...release.manifest,id:'local-design',name:'local-design',files,contentDigest:'0'.repeat(64)},project=path.join(root,'authored-project');manifest.contentDigest=(await import('../packages/cli/dist/validation.js')).digestPackManifest(manifest);await mkdir(project);
  await importValidatedPack(ctx,source,manifest,'1.0.0',{project,agents:['codex']});const lock=JSON.parse(await readFile(path.join(project,'skillshelf-lock.json'),'utf8'));assert.equal(lock.skills[0].origin,'local');assert.deepEqual(lock.skills[0].manifest,manifest);
  const moved=path.join(root,'authored-moved');await mkdir(moved);for(const file of ['skillshelf.json','skillshelf-lock.json'])await cp(path.join(project,file),path.join(moved,file));await syncFrozen(ctx,{project:moved});assert.match((await readSkill(ctx,'local-design/image-to-code','SKILL.md',moved)).content,/image-to-code/);
  const bundle=path.join(root,'bundle');await exportLibrary(ctx,bundle,{project,bundle:true});const other={...ctx,home:path.join(root,'restored-home')};await importLibrary(other,bundle,{});assert.equal((await info(other,'local-design')).members.length,manifest.members.length);assert.equal((await verifyInstalled(other)).ok,true);
});
test('explicit legacy migration converts owned projections in one commit and preserves disabled members',requiresPacks,async t=>{
  const {root,ctx}=await fixture(t),legacy={...ctx,catalogPath:await legacyCatalogFixture(catalogPath)},target=(await addAgent(ctx,'custom',{path:path.join(root,'agent','skills')})).target;
  await installSkills(legacy,['brandkit','image-to-code'],{agents:[target.id]});await toggleSkills(legacy,['image-to-code'],false,{agents:[target.id]});await pinSkills(legacy,['brandkit'],true);
  const before=await loadState(ctx),preview=await previewLegacyMigration(ctx,'taste');assert.equal(preview.existingMembers.length,2);assert.equal(preview.missingMembers.length,11);assert.equal(preview.projectionConversions.length,1);assert.equal(preview.versionDifferences.length,2);
  assert.deepEqual(await loadState(ctx),before);await assert.rejects(applyLegacyMigration(ctx,'taste'),/确认/);await applyLegacyMigration(ctx,'taste',{yes:true});
  const after=await loadState(ctx);assert.equal(after.generation,before.generation+1);assert.deepEqual(Object.keys(after.selections),['taste']);assert.equal(after.selections.taste.pinned,true);assert.ok(after.releases[before.selections.brandkit.releaseKey]);assert.equal(Object.values(after.projections).length,1);assert.equal(Object.values(after.projections)[0].memberId,'brandkit');assert.equal((await verifyInstalled(ctx)).ok,true);
});
test('pack diff identifies added removed changed members, files and dependencies',requiresPacks,async t=>{
  const {ctx}=await fixture(t);await installSkills(ctx,['taste'],{agents:[]});const state=await loadState(ctx),previous=state.releases[state.selections.taste.releaseKey].manifest,next=structuredClone(previous);
  next.members.shift();next.members[0].dependencies.push('测试依赖');next.members.push({...next.members[0],id:'new-member',name:'new-member'});const removed=next.files.shift();next.files[0].size+=1;next.files.push({...next.files[0],path:'new-file'});
  const difference=comparePackManifests(previous,next);assert.ok(difference.members.removed.includes(previous.members[0].id));assert.ok(difference.members.added.includes('new-member'));assert.ok(difference.files.removed.includes(removed.path));assert.ok(difference.files.added.includes('new-file'));assert.ok(difference.files.changed.length);assert.ok(difference.dependencies.some(change=>change.after.includes('测试依赖')));
});
test('new bundled catalog supersedes old cached schema1 metadata without changing its bytes',requiresPacks,async t=>{
  const {ctx}=await fixture(t),legacy=await readJsonFile(await legacyCatalogFixture(catalogPath));legacy.catalogVersion='0.1.0-preview.3';legacy.minCliVersion='0.1.0-preview.3';legacy.skills=legacy.skills.map(({localArtifact,...entry})=>entry);
  const packageName='@llx17669475/skillshelf-catalog',archive=makeTarball([{path:'package/package.json',data:JSON.stringify({name:packageName,version:legacy.catalogVersion,license:'MIT',files:['catalog.json','LICENSE']})},{path:'package/catalog.json',data:JSON.stringify(legacy)},{path:'package/LICENSE',data:'MIT\n'}]);
  await mkdir(path.join(ctx.home,'catalogs'),{recursive:true,mode:0o700});const filename=path.join(ctx.home,'catalogs','cache.json'),bytes=JSON.stringify({packageName,version:legacy.catalogVersion,integrity:integrityFor(archive),archive:archive.toString('base64')});await writeFile(filename,bytes);
  const result=await loadCatalog({...ctx,catalogPath:undefined});assert.equal(result.schemaVersion,2);assert.equal(result.skills.length,8);assert.equal(await readFile(filename,'utf8'),bytes);await assert.rejects(lstat(path.join(ctx.home,'state.json')),{code:'ENOENT'});
});
test('singleton legacy IDs never auto-replace schema1 selection and pinned legacy migrates explicitly',requiresPacks,async t=>{
  const legacyPath=await legacyCatalogFixture(catalogPath),{root,ctx}=await fixture(t),legacy={...ctx,catalogPath:legacyPath},target=(await addAgent(legacy,'custom',{path:path.join(root,'legacy','skills')})).target;
  await installSkills(legacy,['archify'],{agents:[target.id]});await pinSkills(legacy,['archify'],true);const before=await loadState(ctx);
  await assert.rejects(installSkills(ctx,['archify'],{agents:[]}),/旧成员[\s\S]*remove[\s\S]*applyLegacyMigration/);assert.deepEqual(await loadState(ctx),before);
  const preview=await previewLegacyMigration(ctx,'archify');assert.equal(preview.existingMembers.length,1);await applyLegacyMigration(ctx,'archify',{yes:true});const after=await loadState(ctx);assert.equal(after.selections.archify.pinned,true);assert.ok(after.releases[before.selections.archify.releaseKey]);assert.equal(after.generation,before.generation+1);
});
test('schema2 manifest identity changes when metadata changes over identical files',requiresPacks,async t=>{
  const {ctx}=await fixture(t);await installSkills(ctx,['taste'],{agents:[]});const state=await loadState(ctx),manifest=structuredClone(state.releases[state.selections.taste.releaseKey].manifest),original=manifest.contentDigest;manifest.members[0].dependencies=[...(manifest.members[0].dependencies||[]),'metadata-only-change'];const changed={...manifest,contentDigest:'0'.repeat(64)};changed.contentDigest=(await import('../packages/cli/dist/validation.js')).digestPackManifest(changed);assert.notEqual(changed.contentDigest,original);assert.equal(changed.files.length,manifest.files.length);
});
