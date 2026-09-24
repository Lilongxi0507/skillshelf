import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inventory, digestManifest } from '../packages/cli/dist/validation.js';
import { emptyState, loadState, releaseKey } from '../packages/cli/dist/store/state.js';
import { canonicalPath, fingerprint, writeJson } from '../packages/cli/dist/store/fs.js';
import { transact, recoverTransactions, targetWorkRoot } from '../packages/cli/dist/transactions/transaction.js';
import { importTree, chmodTree } from '../packages/cli/dist/store/local.js';
import { addAgent, toggleSkills, removeAgent, removeSkills, pinSkills, readSkill, verifyInstalled, forkSkill } from '../packages/cli/dist/manager.js';
import { exportLibrary, importLibrary } from '../packages/cli/dist/commands/portable.js';
import { buildProgram } from '../packages/cli/dist/index.js';
import { CLI_VERSION } from '../packages/cli/dist/release.js';
import { prepareExecution } from '../packages/cli/dist/core.js';
import { makeTarball } from '../scripts/lib.mjs';
async function cleanupModes(path){const s=await lstat(path);if(s.isSymbolicLink())return;if(s.isDirectory()){await chmod(path,0o700);for(const name of await readdir(path))await cleanupModes(join(path,name));}else await chmod(path,0o600);}
async function fixture(t){const root=await mkdtemp(join(process.env.SKILLSHELF_TEST_TMP||tmpdir(),'skillshelf-core-'));t.after(async()=>{await cleanupModes(root);await rm(root,{recursive:true,force:true});});const ctx={home:join(root,'home'),offline:true};return{root,ctx};}
async function installed(t){const f=await fixture(t);const source=join(f.root,'source');await mkdir(join(source,'references'),{recursive:true});await writeFile(join(source,'SKILL.md'),'---\nname: fixture-skill\ndescription: Test skill\n---\n# Test\n');await writeFile(join(source,'LICENSE'),'MIT\n');await writeFile(join(source,'references','data.bin'),Buffer.from([0,1,2,255]));const files=await inventory(source),contentDigest=digestManifest(files),manifest={schemaVersion:1,id:'fixture-skill',name:'fixture-skill',files,contentDigest,runtime:{kind:'instructions',requiresNetwork:false}};await importTree(f.ctx,source,manifest);const release={key:releaseKey('fixture-skill','1.0.0',contentDigest),id:manifest.id,name:manifest.name,version:'1.0.0',packageName:'local:fixture-skill',integrity:'',contentDigest,manifest,source:{},installedAt:new Date().toISOString(),origin:'local'};const next=emptyState();next.releases[release.key]=release;next.selections[release.id]={releaseKey:release.key,pinned:false,history:[]};await transact(f.ctx,emptyState(),next,[]);return{...f,release,source};}
async function curatedInstalled(t) {
  const f = await fixture(t), id = 'skillshelf-web-search', version = '0.1.0-preview.1';
  const source = join(f.root, 'curated-source'); await mkdir(join(source, 'scripts'), { recursive: true });
  const contents = { 'SKILL.md': `---\nname: ${id}\ndescription: Core fixture\n---\n# Test\n`, LICENSE: 'MIT\n', 'scripts/run.py': '# inert fixture\n' };
  for (const [name, data] of Object.entries(contents)) await writeFile(join(source, name), data);
  const files = await inventory(source), contentDigest = digestManifest(files);
  const runtime = { kind: 'python', entrypoint: 'scripts/run.py', minimumVersion: '3.10', requiresNetwork: true, providers: ['search'], dependencies: [] };
  const manifest = { schemaVersion: 1, id, name: id, files, contentDigest, runtime };
  const packageName = `@llx17669475/skillshelf-skill-${id}`;
  const archive = makeTarball([
    { path: 'package/package.json', data: JSON.stringify({ name: packageName, version, license: 'MIT', files: ['skill/', 'skillshelf.manifest.json', 'LICENSE'] }) },
    { path: 'package/skillshelf.manifest.json', data: JSON.stringify(manifest) },
    { path: 'package/LICENSE', data: contents.LICENSE },
    ...Object.entries(contents).map(([name, data]) => ({ path: `package/skill/${name}`, data })),
  ]);
  const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
  const entry = { id, name: id, title: id, description: 'Core fixture', useWhen: 'Tests', examples: ['local test'], category: 'tools', tags: [], collection: 'first-party', license: 'MIT', source: { repository: 'skillshelf/skillshelf', path: `skills/${id}` }, status: 'stable', runtime, packageName, version, integrity, contentDigest, fileCount: files.length, unpackedSize: files.reduce((sum, file) => sum + file.size, 0) };
  await importTree(f.ctx, source, manifest);
  const artifact = join(f.ctx.home, 'artifacts', `${contentDigest}-${createHash('sha256').update(integrity).digest('hex').slice(0, 16)}.tgz`);
  await writeFile(artifact, archive);
  const release = { key: releaseKey(id, version, contentDigest), id, name: id, version, packageName, integrity, contentDigest, manifest, source: entry.source, installedAt: new Date().toISOString(), origin: 'npm', catalogEntry: entry };
  const next = emptyState(); next.releases[release.key] = release; next.selections[id] = { releaseKey: release.key, pinned: false, history: [] };
  await transact(f.ctx, emptyState(), next, []);
  return { ...f, id };
}

test('npm-style symlink entry really executes instead of silently succeeding',{skip:process.platform==='win32'?'npm uses a .cmd shim on Windows; the packed CLI test exercises it':false},async t=>{const {root}=await fixture(t);const cli=join(root,'skillshelf');await symlink(fileURLToPath(new URL('../packages/cli/dist/index.js',import.meta.url)),cli);const result=spawnSync(process.execPath,[cli,'--version'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),CLI_VERSION);});
test('CLI program builds and help lists real commands',()=>{const program=buildProgram();const names=program.commands.map(x=>x.name());for(const name of['install','providers','agents','sync','export','repair','run'])assert.ok(names.includes(name));});
test('run parser keeps skill options positional and exposes exactly one leading delimiter',async()=>{
  for(const tail of [['--','--help'],['--help'],['--','--','literal'],['query','--count','2']]){
    const program=buildProgram();let seen;program.commands.find(cmd=>cmd.name()==='run').action((id,args)=>{seen={id,args};});
    await program.parseAsync(['node','skillshelf','run','skillshelf-web-search',...tail]);assert.equal(seen.id,'skillshelf-web-search');assert.deepEqual(seen.args,tail);
  }
});
test('transaction rollback restores original data after every injected switch error',async t=>{const{root,ctx}=await fixture(t);const path=join(root,'agent','skills','one');await mkdir(path,{recursive:true});await writeFile(join(path,'old.txt'),'original');const before=await fingerprint(path);const next=emptyState();await assert.rejects(transact(ctx,emptyState(),next,[{path,workRoot:targetWorkRoot(join(root,'agent','skills')),expected:before,prepare:async stage=>{await mkdir(stage);await writeFile(join(stage,'new.txt'),'new');}}],{afterStep:async step=>{if(step==='switched')throw new Error('injected');}}),/injected/);assert.equal(await fingerprint(path),before);assert.equal((await loadState(ctx)).generation,0);assert.deepEqual((await recoverTransactions(ctx)).recovered,[]);});
test('state commit wins over post-commit error and preserves new file',async t=>{const{root,ctx}=await fixture(t),path=join(root,'data','item.json');await mkdir(join(root,'data'));const next=emptyState();await assert.rejects(transact(ctx,emptyState(),next,[{path,workRoot:targetWorkRoot(join(root,'data')),expected:null,prepare:stage=>writeFile(stage,'new')}],{afterStep:async step=>{if(step==='state-committed')throw new Error('after commit');}}));assert.equal(await readFile(path,'utf8'),'new');assert.equal((await loadState(ctx)).generation,1);});
test('unknown and concurrently changed target prevents any modification',async t=>{const{root,ctx}=await fixture(t),path=join(root,'file');await writeFile(path,'mine');await assert.rejects(transact(ctx,emptyState(),emptyState(),[{path,workRoot:targetWorkRoot(root),expected:null,prepare:stage=>writeFile(stage,'replacement')}]),/已变化/);assert.equal(await readFile(path,'utf8'),'mine');});
test('one local tree serves multiple distinct agents, removing one preserves the other',async t=>{const{root,ctx,release}=await installed(t);const a=(await addAgent(ctx,'custom',{path:join(root,'a','skills'),label:'A'})).target;const b=(await addAgent(ctx,'custom',{path:join(root,'b','skills'),label:'B'})).target;await toggleSkills(ctx,[release.id],true,{agents:[a.id,b.id]});let state=await loadState(ctx);assert.equal(Object.keys(state.projections).length,2);const projection=Object.values(state.projections).find(p=>p.path===join(a.path,release.name));assert.ok(projection);assert.ok(['link','copy'].includes(projection.mode));assert.equal((await lstat(projection.path)).isSymbolicLink(),projection.mode==='link');await removeAgent(ctx,a.id);state=await loadState(ctx);assert.equal(Object.keys(state.projections).length,1);assert.equal((await readSkill(ctx,release.id,'references/data.bin')).encoding,'base64');assert.equal((await verifyInstalled(ctx)).ok,true);});
test('same physical target is deduplicated and owns multiple agent references',async t=>{const{root,ctx,release}=await installed(t),path=join(root,'shared','skills');const a=(await addAgent(ctx,'custom',{path})).target,b=(await addAgent(ctx,'dsh',{path})).target;await toggleSkills(ctx,[release.id],true,{agents:[a.id,b.id]});let state=await loadState(ctx);assert.equal(Object.keys(state.projections).length,1);assert.equal(Object.values(state.projections)[0].targetIds.length,2);await removeAgent(ctx,a.id);state=await loadState(ctx);assert.equal(Object.values(state.projections)[0].targetIds.length,1);assert.equal((await verifyInstalled(ctx)).ok,true);});
test('copy modification is not overwritten or removed; fork has independent bytes',async t=>{const{root,ctx,release}=await installed(t);const a=(await addAgent(ctx,'custom',{path:join(root,'a','skills'),mode:'copy'})).target;await toggleSkills(ctx,[release.id],true,{agents:[a.id]});await writeFile(join(a.path,release.name,'SKILL.md'),'local customization');await assert.rejects(toggleSkills(ctx,[release.id],false,{agents:[a.id]}),/修改/);const destination=join(root,'fork');await forkSkill(ctx,release.id,destination);await writeFile(join(destination,'SKILL.md'),'fork edit');assert.match((await readSkill(ctx,release.id)).content,/# Test/);});
test('bundle import exports no user paths or credentials and works offline',async t=>{const{root,ctx,release}=await installed(t);const catalog={schemaVersion:1,catalogVersion:'1.0.0',minCliVersion:'0.1.0-preview.1',scope:'@llx17669475',categories:[{id:'tools',title:'Tools'}],collections:[],skills:[]};const catalogPath=join(root,'catalog.json');await writeJson(catalogPath,catalog);ctx.catalogPath=catalogPath;const output=join(root,'bundle');await exportLibrary(ctx,output,{bundle:true});const raw=await readFile(join(output,'skillshelf-export.json'),'utf8');assert.equal(raw.includes(ctx.home),false);assert.equal(raw.includes('providers'),false);const other={home:join(root,'other'),offline:true,catalogPath};await importLibrary(other,output,{});assert.match((await readSkill(other,release.id)).content,/# Test/);assert.equal(Object.keys((await loadState(other)).targets).length,0);});
test('frozen state read does not create a missing home',async t=>{const{ctx}=await fixture(t);assert.equal((await loadState(ctx)).generation,0);await assert.rejects(lstat(ctx.home),{code:'ENOENT'});});
function executor(outputDirectory) {
  return {
    kind: 'podman-rootless', isolationVerified: true, runId: 'fixture',
    signal: new AbortController().signal, deadlineMs: Date.now() + 60_000, outputDirectory,
  };
}
test('core executor accepts adjacent output names with existing and missing descendants', async t => {
  const { root, ctx } = await fixture(t);
  await mkdir(ctx.home);
  const adjacent = `${ctx.home}-outputs`;
  await mkdir(adjacent);
  // A valid output path reaches the missing-skill check; the permission check does not reject it.
  for (const output of [adjacent, join(adjacent, 'new'), join(root, 'other-new', 'child')]) {
    await assert.rejects(prepareExecution(ctx, 'absent', executor(output)), { code: 'USAGE' });
  }
});
test('core executor rejects home, its ancestor and missing descendants', async t => {
  const { root, ctx } = await fixture(t);
  await mkdir(ctx.home);
  for (const output of [root, ctx.home, join(ctx.home, 'new', 'child')]) {
    await assert.rejects(prepareExecution(ctx, 'absent', executor(output)), { code: 'PERMISSION' });
  }
});
test('core executor rejects linked paths into home with existing and missing descendants', { skip: process.platform === 'win32' ? 'symlink fixture needs POSIX privileges' : false }, async t => {
  const { root, ctx } = await fixture(t);
  await mkdir(ctx.home);
  await mkdir(join(ctx.home, 'existing'));
  const alias = join(root, 'shortcut');
  await symlink(ctx.home, alias);
  for (const output of [join(alias, 'existing'), join(alias, 'new', 'child')]) {
    await assert.rejects(prepareExecution(ctx, 'absent', executor(output)), { code: 'PERMISSION' });
  }
});
test('core executor rejects mutable links even when they currently lead to a safe output', { skip: process.platform === 'win32' ? 'symlink fixture needs POSIX privileges' : false }, async t => {
  const { root, ctx } = await fixture(t);
  await mkdir(ctx.home);
  const safe = join(root, 'safe-output'); await mkdir(safe);
  const alias = join(root, 'output-link'); await symlink(safe, alias);
  for (const output of [alias, join(alias, 'new-child')]) {
    await assert.rejects(prepareExecution(ctx, 'absent', executor(output)), { code: 'PERMISSION' });
  }
});
test('core executor rejects an existing file as its output directory', async t => {
  const { root, ctx } = await fixture(t);
  await mkdir(ctx.home);
  const output = join(root, 'output-file'); await writeFile(output, 'user data');
  await assert.rejects(prepareExecution(ctx, 'absent', executor(output)), { code: 'PERMISSION' });
});
test('core preparation returns the verified canonical output path without executing a skill', async t => {
  const { root, ctx, id } = await curatedInstalled(t);
  const safe = join(root, 'safe-output'); await mkdir(safe);
  for (const output of [safe, join(safe, 'new-child')]) {
    const prepared = await prepareExecution({ ...ctx, offline: false }, id, executor(output));
    assert.equal(prepared.outputDirectory, await canonicalPath(output));
    assert.equal(prepared.id, id);
    assert.equal(prepared.entrypoint, 'scripts/run.py');
  }
  assert.deepEqual(await readdir(safe), []);
});
