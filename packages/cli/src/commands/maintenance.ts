import { join } from 'node:path';
import { readdir, lstat, rm, readlink, unlink } from 'node:fs/promises';
import type { Context, MutationOptions, OperationResult } from '../types.js';
import { exists, readJson } from '../store/fs.js';
import { loadState } from '../store/state.js';
import { pendingTransactions } from '../transactions/transaction.js';
import { withLocks } from '../transactions/locks.js';
import { chmodTree } from '../store/local.js';
import { validateManifest, verifyTree } from '../validation.js';
import { fail } from '../errors.js';
import { withMutation } from '../transactions/operations.js';

export async function garbageCollect(ctx:Context,options:MutationOptions={}):Promise<OperationResult>{return withMutation(ctx,{...options,dryRun:options.dryRun||!options.yes},()=>garbageCollectInternal(ctx,options));}
async function garbageCollectInternal(ctx:Context,options:MutationOptions={}):Promise<OperationResult>{
  const state=await loadState(ctx),referenced=new Set<string>();
  for(const s of [...Object.values(state.selections),...Object.values(state.projects).flatMap(p=>Object.values(p.selections))])for(const k of[s.releaseKey,...s.history])if(state.releases[k])referenced.add(state.releases[k]!.contentDigest);
  for(const p of Object.values(state.projections))referenced.add(state.releases[p.releaseKey]!.contentDigest);
  // All recorded releases are retained: history and provenance are intentionally not pruned implicitly.
  for(const r of Object.values(state.releases))referenced.add(r.contentDigest);
  if((await pendingTransactions(ctx)).length)fail('RECOVERY','未完成事务存在，不能清理');
  const candidates:string[]=[];const store=join(ctx.home,'store');
  if(await exists(store))for(const name of await readdir(store)){
    if(!/^[a-f0-9]{64}$/.test(name)||referenced.has(name))continue;
    const object=join(store,name),s=await lstat(object);if(!s.isDirectory()||s.isSymbolicLink())continue;
    const manifest=validateManifest(await readJson(join(object,'manifest.json')));if(manifest.contentDigest!==name)continue;await verifyTree(join(object,'skill'),manifest);candidates.push(object);
  }
  if(options.dryRun||!options.yes)return{candidates,dryRun:true,retained:'所有已记录版本、项目引用、历史备份；仅清理无引用的完整孤立对象'};
  await withLocks([join(ctx.home,'writer.lock')],async()=>{
    const latest=await loadState(ctx);if(latest.generation!==state.generation||(await pendingTransactions(ctx)).length)fail('CONFLICT','本地状态已变化，请重新预览');
    for(const object of candidates){const manifest=validateManifest(await readJson(join(object,'manifest.json')));await verifyTree(join(object,'skill'),manifest);await chmodTree(object,false);await rm(object,{recursive:true});}
  });return{removed:candidates,artifactsRetained:true,backupsRetained:true};
}
