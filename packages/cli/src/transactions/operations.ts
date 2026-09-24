import { join } from 'node:path';
import type { Context, MutationOptions } from '../types.js';
import { canonicalProjectPath } from '../agents/agents.js';
import { initHome, validateStoredHomeLocation } from '../store/state.js';
import { withLocks } from './locks.js';

/** Freeze a caller's project alias before preflight and transaction work. */
export async function fixedProjectOptions<T extends MutationOptions>(options:T):Promise<T>{
  const {project,...rest}=options;
  return {...rest,project:project?await canonicalProjectPath(project):undefined} as T;
}

/** Serialize acquisition-to-ledger operations and GC; ordinary transactions still guard generations.
 * Read-only previews never create a directory or lock. No asynchronous callback is retried.
 */
export async function preflightProjectHome(ctx:Context,options:MutationOptions):Promise<void>{
  // An unregistered project still has native Agent scan roots. Check before initHome creates data.
  await validateStoredHomeLocation(ctx,options.project?[await canonicalProjectPath(options.project)]:[]);
}
export async function withMutation<T>(ctx:Context,options:MutationOptions,operation:()=>Promise<T>):Promise<T>{
  await preflightProjectHome(ctx,options);
  if(options.dryRun)return operation();
  await initHome(ctx);
  return withLocks([join(ctx.home,'operation.lock')],operation);
}
