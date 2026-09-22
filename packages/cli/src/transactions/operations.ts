import { join } from 'node:path';
import type { Context, MutationOptions } from '../types.js';
import { initHome } from '../store/state.js';
import { withLocks } from './locks.js';

/** Serialize acquisition-to-ledger operations and GC; ordinary transactions still guard generations.
 * Read-only previews never create a directory or lock. No asynchronous callback is retried.
 */
export async function withMutation<T>(ctx:Context,options:MutationOptions,operation:()=>Promise<T>):Promise<T>{
  if(options.dryRun)return operation();
  await initHome(ctx);
  return withLocks([join(ctx.home,'operation.lock')],operation);
}
