import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readdir, lstat, rm, cp, rename } from 'node:fs/promises';
import type { Context, MutationOptions, OperationResult } from '../types.js';
import { exists, readJson, ensurePrivateDir, within } from '../store/fs.js';
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

export async function migrateHome(ctx: Context, destination: string, options: MutationOptions = {}): Promise<OperationResult> {
  const target = resolve(destination); if (target === ctx.home || within(ctx.home, target) || within(target, ctx.home)) fail('CONFLICT', '新旧 SkillShelf 目录不能互相包含');
  const state = await loadState(ctx); const preview = { from: ctx.home, to: target, releases: Object.keys(state.releases).length, targets: Object.keys(state.targets).length, projects: Object.keys(state.projects).length, requiresRestart: true };
  if (options.dryRun) return { ...preview, dryRun: true };
  if (!options.yes) fail('USAGE', '目录迁移需要明确确认');
  if (await exists(target)) fail('CONFLICT', '迁移目标必须不存在');
  await ensurePrivateDir(dirname(target));
  const staging = target + '.skillshelf-migrating';
  if (await exists(staging)) fail('CONFLICT', '迁移暂存目录已存在');
  await cp(ctx.home, staging, { recursive: true, errorOnExist: true, force: false, dereference: false });
  try {
    const copied = await readJson<unknown>(join(staging, 'state.json')); if (!copied || typeof copied !== 'object') fail('INTEGRITY', '迁移后的状态不可读');
    await rename(staging, target);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  return { ...preview, migrated: true, next: `使用 --home ${target} 验证后再移除旧目录` };
}

export async function uninstallSkillShelf(ctx: Context, options: MutationOptions & { removeHome?: boolean } = {}): Promise<OperationResult> {
  const state = await loadState(ctx);
  const owned = Object.values(state.projections).map(projection => projection.path);
  const pending = await pendingTransactions(ctx);
  const preview = { home: ctx.home, ownedProjections: owned, pending, npmCommand: 'npm uninstall -g @llx17669475/skillshelf', removeHome: options.removeHome !== false, requiresConfirmation: true };
  if (options.dryRun || !options.yes) return { ...preview, dryRun: true };
  if (pending.length) fail('RECOVERY', '存在未完成事务，不能完整卸载');
  const removed: string[] = [], retained: Array<{ path: string; reason: string }> = [];
  for (const path of owned) {
    try {
      const info = await lstat(path); if (info.isSymbolicLink()) { await rm(path); removed.push(path); }
      else retained.push({ path, reason: '受管目标已被改为普通目录，保留用户内容' });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') retained.push({ path, reason: '无法移除：' + (error instanceof Error ? error.message : String(error)) }); }
  }
  if (options.removeHome !== false) {
    const target = resolve(ctx.home), userHome = resolve(process.env.HOME || process.env.USERPROFILE || homedir());
    // A dedicated SkillShelf home inside the OS home directory is removable; the OS home directory itself or any ancestor never is.
    if (target === userHome || within(target, userHome)) fail('CONFLICT', '拒绝删除用户主目录或任何包含它的目录');
    await rm(target, { recursive: true, force: true }); removed.push(target);
  }
  return { removed, retained, npmCommand: preview.npmCommand, complete: retained.length === 0 };
}
