import { cp, lstat, readlink, symlink, chmod, readdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import type { AgentTarget, Context, Projection, Release, State } from '../types.js';
import { canonicalPath, exists, fingerprint, keyFor, within } from './fs.js';
import { storePath } from './state.js';
import { verifyTree } from '../validation.js';
import { fail } from '../errors.js';
import type { Change } from '../transactions/transaction.js';
import { targetWorkRoot } from '../transactions/transaction.js';

export function projectionKey(path: string): string { return keyFor(resolve(path)); }
export function desiredMode(targets:AgentTarget[]): 'auto'|'link'|'copy' {const configured=targets.map(t=>t.mode);if(configured.includes('link')&&configured.includes('copy'))fail('CONFLICT','同一物理目标的链接/复制设置冲突');return configured.includes('copy')?'copy':configured.includes('link')?'link':'auto';}
export async function checkProjection(ctx: Context, projection: Projection, release: Release): Promise<void> {
  if(!(await exists(projection.path))) fail('CONFLICT','受管技能目录缺失，请先诊断：'+projection.path);
  const info=await lstat(projection.path);
  if(projection.mode==='link'){
    if(!info.isSymbolicLink()) fail('CONFLICT','受管链接已被替换，未覆盖：'+projection.path);
    const actual=resolve(dirname(projection.path),await readlink(projection.path));
    if(actual!==resolve(storePath(ctx,release.contentDigest))) fail('CONFLICT','受管链接目标已改变：'+projection.path);
    await verifyTree(storePath(ctx,release.contentDigest),release.manifest);
  } else {
    if(!info.isDirectory()||info.isSymbolicLink()) fail('CONFLICT','受管副本类型已改变：'+projection.path);
    await verifyTree(projection.path,release.manifest).catch(()=>fail('CONFLICT','技能副本有本地修改，保留文件：'+projection.path));
  }
}
async function makeWritable(path:string):Promise<void>{
  const s=await lstat(path); if(s.isSymbolicLink()) fail('INTEGRITY','副本中出现链接');
  if(process.platform!=='win32') await chmod(path,s.isDirectory()?0o700:(s.mode&0o111?0o700:0o600));
  if(s.isDirectory()) for(const name of await readdir(path)) await makeWritable(join(path,name));
}
export async function projectionChange(ctx: Context, state: State, next: State, path: string, release: Release | null, targets: AgentTarget[]): Promise<Change | null> {
  const key=projectionKey(path); const previous=state.projections[key];
  if(previous){ const old=state.releases[previous.releaseKey]; if(!old) fail('INTEGRITY','投影版本记录缺失'); await checkProjection(ctx,previous,old); }
  else if(await exists(path)) fail('CONFLICT','已有同名文件不归 SkillShelf 管理，拒绝接管：'+path);
  if(release===null){ if(!previous)return null; delete next.projections[key]; return{path,workRoot:targetWorkRoot(dirname(path)),expected:await fingerprint(path)}; }
  await verifyTree(storePath(ctx,release.contentDigest),release.manifest);
  if(within(dirname(path),storePath(ctx,release.contentDigest))||within(storePath(ctx,release.contentDigest),dirname(path)))fail('CONFLICT','Agent扫描目录不能包含持久store或位于store中');
  const targetIds=[...new Set(targets.map(t=>t.id))].sort();
  const mode=desiredMode(targets);
  if(previous?.releaseKey===release.key&&(mode==='auto'||previous.mode===mode)){ next.projections[key]={...previous,targetIds}; return null; }
  const projection:Projection={key,path,releaseKey:release.key,mode:mode==='copy'?'copy':'link',targetIds};
  next.projections[key]=projection;
  return {path,workRoot:targetWorkRoot(dirname(path)),expected:await fingerprint(path),prepare:async stage=>{
    if(mode!=='copy'){
      try{await symlink(storePath(ctx,release.contentDigest),stage,process.platform==='win32'?'junction':'dir');projection.mode='link';return;}
      catch(error){if(mode==='link'||!['EPERM','EACCES','ENOTSUP','EINVAL','UNKNOWN'].includes((error as NodeJS.ErrnoException).code||''))throw error;}
    }
    await cp(storePath(ctx,release.contentDigest),stage,{recursive:true,errorOnExist:true,force:false,dereference:false});
    await makeWritable(stage); await verifyTree(stage,release.manifest); projection.mode='copy';
  }};
}
export async function validateTargetPath(target:AgentTarget):Promise<void>{
  if(await canonicalPath(target.path)!==target.path)fail('CONFLICT','Agent目录真实路径已变化，请重新确认：'+target.path);
  if(await exists(target.path)){const s=await lstat(target.path);if(!s.isDirectory()||s.isSymbolicLink())fail('CONFLICT','Agent技能根不是普通目录：'+target.path);}
}
