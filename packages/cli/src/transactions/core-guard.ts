import { AsyncLocalStorage } from 'node:async_hooks';
import type { Catalog, Context, State } from '../types.js';
import { canonicalJson } from '../validation.js';
import { fail } from '../errors.js';

// Internal per-call context: never exported by the public package entrypoint.
interface CoreGuard {
  home: string;
  generation: number;
  catalog: string;
  validate: () => Promise<void>;
}
const guards = new AsyncLocalStorage<CoreGuard>();
export function withCoreGuard<T>(guard: CoreGuard, operation: () => Promise<T>): Promise<T> {
  return guards.run(guard, operation);
}
export function guardCatalog(catalog: Catalog): Catalog {
  const guard = guards.getStore();
  if (guard && canonicalJson(catalog) !== guard.catalog) fail('CONFLICT', '目录已变化；请重新预览并确认');
  return catalog;
}
export function forbidCoreRefresh(): void {
  if (guards.getStore()) fail('CONFLICT', '批准的 core 操作不能隐式刷新目录');
}
/** Called inside existing home-writer and target locks before any target writes. */
export async function assertCoreTransaction(ctx: Context, state: State): Promise<void> {
  const guard = guards.getStore();
  if (!guard) return; // Existing standalone CLI transactions are unchanged.
  if (ctx.home !== guard.home || state.generation !== guard.generation) fail('CONFLICT', '批准的库或状态代际已变化；请重新预览');
  await guard.validate();
}
