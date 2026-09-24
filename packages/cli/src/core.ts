import { join, resolve, isAbsolute } from 'node:path';
import type { CatalogEntry, Context, MutationOptions, OperationResult, Release, State } from './types.js';
import { loadCatalog, searchCatalog as searchCatalogEntries } from './catalog/catalog.js';
import { getRelease, loadState, storePath } from './store/state.js';
import { canonicalProjectPath } from './agents/agents.js';
import { listSkills, installSkills, toggleSkills, removeSkills, pinSkills, rollbackSkill, updateSkills, readSkill, verifyInstalled, syncFrozen as managerSyncFrozen } from './manager.js';
import { exportLibrary, importLibrary } from './commands/portable.js';
import { verifyTree, canonicalJson } from './validation.js';
import { assertDirectoryChain, canonicalPath, fingerprint, within } from './store/fs.js';
import { fail } from './errors.js';
import { withCoreGuard } from './transactions/core-guard.js';
import { pendingTransactions } from './transactions/transaction.js';
import { verifyExecutionRelease } from './runtime/runtime.js';
export { resolveInstalledMember, listInstalledPacks, desiredPackProjections, selectPackRelease, importValidatedPack, setLocalPreference, comparePackManifests, previewPackChange, previewLegacyMigration, applyLegacyMigration } from './manager.js';
export { connectMessage, enrollAgent, listEnrollments, verifyEnrolledAgent, scanTarget, previewDedupe, applyDedupe, restoreDedupe } from './agents/onboarding.js';
export { createDraft, listDrafts, validateDraft, publishDraft, removeDraft } from './authoring.js';
export { listProfiles, getProfile, saveProfile, removeProfile, applyProfile } from './profiles.js';
export { addMcp, listMcp, removeMcp, setMcpEnabled, diagnoseMcp, mcpConfigPreview } from './mcp/manager.js';

/** Stable, typed integration surface for Agent consumers. It never starts a skill. */
export type SkillQuery = { category?: string; collection?: string; installed?: boolean };
export type CoreMutationOptions = MutationOptions & { collection?: string; version?: string };
export type MutationKind = 'install' | 'enable' | 'disable' | 'remove' | 'update' | 'rollback' | 'pin' | 'unpin';
export type MutationPlan = Readonly<{ kind: MutationKind; ids: readonly string[]; options: Readonly<CoreMutationOptions>; preview: OperationResult }>;

type PlanMeta = {
  home: string;
  offline: boolean;
  catalogPath?: string;
  kind: MutationKind;
  ids: readonly string[];
  options: Readonly<CoreMutationOptions>;
  generation: number;
  catalog: string;
  statePath: string;
  stateFingerprint: string | null;
  projectGuards: Array<{ path: string; expected: string | null }>;
};
const planMeta = new WeakMap<object, PlanMeta>();
function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}

export type SandboxExecutor = Readonly<{
  kind: 'podman-rootless';
  isolationVerified: true;
  runId: string;
  signal: AbortSignal;
  deadlineMs: number;
  outputDirectory: string;
}>;
export type PreparedExecution = Readonly<{
  id: string;
  version: string;
  contentDigest: string;
  entrypoint: string;
  runtime: Release['manifest']['runtime'];
  files: Release['manifest']['files'];
  requiresNetwork: boolean;
  readOnlyMount: string;
  outputDirectory: string;
  runId: string;
  arguments: { maxItems: 256; maxBytes: 32768 };
}>;

export async function list(ctx: Context, query = '', filters: SkillQuery = {}): Promise<OperationResult> { return listSkills(ctx, query, filters); }
export async function search(ctx: Context, query = '', filters: SkillQuery = {}): Promise<OperationResult> { return listSkills(ctx, query, filters); }
export async function info(ctx: Context, id: string): Promise<CatalogEntry> {
  const catalog = await loadCatalog(ctx);
  const exact = catalog.skills.find(item => item.id === id || item.name === id);
  const matches = catalog.skills.flatMap(pack=>(pack.members||[]).filter(member=>`${pack.id}/${member.id}`===id||member.id===id||member.legacyId===id).map(member=>({pack,member})));
  if(!exact&&matches.length>1)fail('USAGE','成员名称不唯一，请使用 包ID/成员ID：'+id);
  const entry=exact||(matches.length===1?{...matches[0]!.pack,selectedMember:matches[0]!.member}:undefined);
  if (!entry) {
    const {resolveInstalledMember}=await import('./manager.js');
    const {release,member}=await resolveInstalledMember(await loadState(ctx),id);
    if(release.catalogEntry)return structuredClone({...release.catalogEntry,...(member?{selectedMember:member}:{})});
    const first=member||release.manifest.members?.[0];
    return {id:release.id,name:release.name,title:release.name,description:first?.description||'本地技能',useWhen:first?.useWhen||'本地导入',examples:first?.examples||[],category:first?.category||'collaboration',tags:first?.tags||[],collection:'local',license:first?.license||'见包内 LICENSE',source:release.source,status:'experimental',runtime:release.manifest.runtime,packageName:release.packageName,version:release.version,integrity:release.integrity,contentDigest:release.contentDigest,fileCount:release.manifest.files.length,unpackedSize:release.manifest.files.reduce((sum,file)=>sum+file.size,0),...(release.manifest.members?{kind:'pack' as const,members:release.manifest.members}:{})};
  }
  return structuredClone(entry);
}
export async function read(ctx: Context, id: string, file = 'SKILL.md', project?: string): Promise<OperationResult> { return readSkill(ctx, id, file, project); }
export async function verify(ctx: Context): Promise<OperationResult> { return verifyInstalled(ctx); }

async function snapshot(ctx: Context): Promise<{ state: State; catalog: string; stateFingerprint: string | null }> {
  const state = await loadState(ctx);
  const catalog = canonicalJson(await loadCatalog(ctx));
  return { state, catalog, stateFingerprint: await fingerprint(join(resolve(ctx.home), 'state.json')) };
}
function assertCoreOptions(options: CoreMutationOptions): void {
  if (options.dryRun) fail('CONFLICT', 'core plan 内部控制 dryRun，不接受外部覆盖');
  if (options.agents?.some(id => typeof id !== 'string') || (options.project && !isAbsolute(resolve(options.project)))) fail('USAGE', 'core mutation options invalid');
}
async function guardFor(ctx: Context, base: { state: State; catalog: string; stateFingerprint: string | null }, options: CoreMutationOptions): Promise<PlanMeta> {
  const projectGuards: Array<{ path: string; expected: string | null }> = [];
  if (options.project) {
    const project = await canonicalProjectPath(options.project);
    projectGuards.push(
      { path: join(project, 'skillshelf.json'), expected: await fingerprint(join(project, 'skillshelf.json')) },
      { path: join(project, 'skillshelf-lock.json'), expected: await fingerprint(join(project, 'skillshelf-lock.json')) },
    );
  }
  return {
    home: resolve(ctx.home), offline: ctx.offline, catalogPath: ctx.catalogPath ? resolve(ctx.catalogPath) : undefined,
    kind: 'install', ids: [], options: freezeDeep(structuredClone(options)), generation: base.state.generation,
    catalog: base.catalog, statePath: join(resolve(ctx.home), 'state.json'), stateFingerprint: base.stateFingerprint, projectGuards,
  };
}
async function validatePlan(meta: PlanMeta, ctx: Context): Promise<void> {
  if (resolve(ctx.home) !== meta.home || ctx.offline !== meta.offline || (ctx.catalogPath ? resolve(ctx.catalogPath) : undefined) !== meta.catalogPath) fail('CONFLICT', 'core plan 上下文已变化');
  const state = await loadState(ctx);
  if (state.generation !== meta.generation) fail('CONFLICT', '状态已变化；请重新预览并确认');
  if (await fingerprint(meta.statePath) !== meta.stateFingerprint) fail('CONFLICT', '状态文件已变化；请重新预览并确认');
  if (canonicalJson(await loadCatalog(ctx)) !== meta.catalog) fail('CONFLICT', '目录已变化；请重新预览并确认');
  for (const guard of meta.projectGuards) if (await fingerprint(guard.path) !== guard.expected) fail('CONFLICT', '项目锁或声明已变化；请重新预览并确认');
}

export async function planMutation(ctx: Context, kind: MutationKind, ids: readonly string[] = [], options: CoreMutationOptions = {}): Promise<MutationPlan> {
  assertCoreOptions(options);
  if (kind === 'update' && !ctx.offline && !ctx.catalogPath) fail('NETWORK', 'core update 必须使用显式离线/固定目录快照，禁止隐式刷新');
  const fixedOptions = options.project ? { ...options, project: await canonicalProjectPath(options.project) } : options;
  const before = await snapshot(ctx);
  const normalized = Object.freeze([...ids]);
  const previewOptions = { ...fixedOptions, dryRun: true } as CoreMutationOptions;
  let preview: OperationResult;
  switch (kind) {
    case 'install': preview = await installSkills(ctx, [...normalized], previewOptions); break;
    case 'enable': preview = await toggleSkills(ctx, [...normalized], true, previewOptions); break;
    case 'disable': preview = await toggleSkills(ctx, [...normalized], false, previewOptions); break;
    case 'remove': preview = await removeSkills(ctx, [...normalized], previewOptions); break;
    case 'update': preview = await updateSkills(ctx, [...normalized], previewOptions); break;
    case 'rollback': preview = await rollbackSkill(ctx, normalized[0] ?? fail('USAGE', 'rollback 需要技能 ID'), options.version, previewOptions); break;
    case 'pin': preview = await pinSkills(ctx, [...normalized], true, previewOptions); break;
    case 'unpin': preview = await pinSkills(ctx, [...normalized], false, previewOptions); break;
    default: return assertNever(kind);
  }
  const after = await snapshot(ctx);
  if (before.state.generation !== after.state.generation || before.catalog !== after.catalog) fail('CONFLICT', '预览期间状态或目录变化，请重新预览');
  const meta = await guardFor(ctx, after, fixedOptions);
  meta.kind = kind; meta.ids = normalized;
  const plan = freezeDeep({ kind, ids: normalized, options: freezeDeep(structuredClone(fixedOptions)), preview: structuredClone(preview) });
  planMeta.set(plan, meta);
  return plan;
}

export async function applyMutation(ctx: Context, plan: MutationPlan, options: Pick<MutationOptions, 'yes'> = {}): Promise<OperationResult> {
  const meta = planMeta.get(plan);
  if (!meta || meta.kind !== plan.kind || meta.ids.join('\0') !== plan.ids.join('\0')) fail('PERMISSION', '只能应用当前进程创建的未篡改 core plan');
  if (Object.keys(options).some(key => key !== 'yes')) fail('USAGE', 'apply 不允许覆盖 project、agent、mode 或操作参数');
  if (options.yes !== true) fail('PERMISSION', '应用 core 计划必须显式确认 yes: true');
  const fixed = { ...meta.options, yes: true, dryRun: false } as MutationOptions & { collection?: string; version?: string };
  // Consume the opaque approval before any filesystem/network work. A failed
  // operation must be re-planned rather than replayed with stale authority.
  planMeta.delete(plan);
  const operation = async (): Promise<OperationResult> => {
    switch (meta.kind) {
      case 'install': return installSkills(ctx, [...meta.ids], fixed);
      case 'enable': return toggleSkills(ctx, [...meta.ids], true, fixed);
      case 'disable': return toggleSkills(ctx, [...meta.ids], false, fixed);
      case 'remove': return removeSkills(ctx, [...meta.ids], fixed);
      case 'update': return updateSkills(ctx, [...meta.ids], fixed);
      case 'rollback': return rollbackSkill(ctx, meta.ids[0] ?? fail('USAGE', 'rollback 需要技能 ID'), meta.options.version, fixed);
      case 'pin': return pinSkills(ctx, [...meta.ids], true, fixed);
      case 'unpin': return pinSkills(ctx, [...meta.ids], false, fixed);
      default: return assertNever(meta.kind);
    }
  };
  await validatePlan(meta, ctx);
  const result = await withCoreGuard({ home: meta.home, generation: meta.generation, catalog: meta.catalog, validate: () => validatePlan(meta, ctx) }, operation);
  return result;
}

export async function resolveRelease(ctx: Context, id: string, project?: string): Promise<Release> { return getRelease(await loadState(ctx), id, project); }
async function validateExecutor(executor: SandboxExecutor, ctx: Context): Promise<string> {
  const invalid = (): never => fail('PERMISSION', 'Agent 执行器必须是已验证的 rootless sandbox、带期限/取消信号和隔离输出目录');
  if (!executor || executor.kind !== 'podman-rootless' || executor.isolationVerified !== true || typeof executor.runId !== 'string' || !executor.runId || !(executor.signal instanceof AbortSignal) || !Number.isFinite(executor.deadlineMs) || executor.deadlineMs <= Date.now() || executor.deadlineMs > Date.now() + 3_600_000 || typeof executor.outputDirectory !== 'string' || !isAbsolute(executor.outputDirectory) || resolve(executor.outputDirectory) !== executor.outputDirectory) invalid();
  if (executor.signal.aborted) fail('CANCELLED', 'sandbox run 已取消');
  const home = resolve(ctx.home), output = executor.outputDirectory;
  if (within(home, output) || within(output, home)) invalid();
  // Existing output components must be real directories; a mutable link cannot be a mount authority.
  await assertDirectoryChain(output).catch(() => invalid());
  const [canonicalHome, canonicalOutput] = await Promise.all([canonicalPath(home), canonicalPath(output)]).catch(() => invalid());
  if (within(canonicalHome, canonicalOutput) || within(canonicalOutput, canonicalHome)) invalid();
  return canonicalOutput;
}
/** Validate an exact curated release without starting a host process. The consumer must recheck the output directory identity immediately before its sandbox mount; this preparation cannot close external TOCTOU races. */
export async function prepareExecution(ctx: Context, id: string, executor: SandboxExecutor, project?: string): Promise<PreparedExecution> {
  const initialOutputDirectory = await validateExecutor(executor, ctx);
  const release = await resolveRelease(ctx, id, project);
  if (ctx.offline && release.manifest.runtime.requiresNetwork) fail('OFFLINE', '离线模式拒绝需要网络的技能执行');
  const directory = await verifyExecutionRelease(ctx, release);
  const entrypoint = release.manifest.runtime.entrypoint;
  if (!entrypoint) fail('UNAVAILABLE', '技能没有可验证的执行入口');
  const outputDirectory = await validateExecutor(executor, ctx);
  if (outputDirectory !== initialOutputDirectory) fail('PERMISSION', 'Agent 执行器输出目录在准备期间发生变化');
  return Object.freeze({
    id: release.id, version: release.version, contentDigest: release.contentDigest, entrypoint,
    runtime: structuredClone(release.manifest.runtime), files: structuredClone(release.manifest.files),
    requiresNetwork: release.manifest.runtime.requiresNetwork, readOnlyMount: directory,
    outputDirectory, runId: executor.runId, arguments: { maxItems: 256 as const, maxBytes: 32768 as const },
  });
}

export async function doctor(ctx: Context): Promise<OperationResult> {
  const verified = await verifyInstalled(ctx);
  return { ...verified, pendingRecovery: await pendingTransactions(ctx), network: 'not-requested', hostExecution: 'not-used-by-core' };
}
export async function exportSkills(ctx: Context, output: string, options: MutationOptions & { bundle?: boolean; ids?: string[] } = {}): Promise<OperationResult> { return exportLibrary(ctx, output, options); }
export async function importSkills(ctx: Context, input: string, options: MutationOptions = {}): Promise<OperationResult> { return importLibrary(ctx, input, options); }
export async function syncFrozen(ctx: Context, options: MutationOptions): Promise<OperationResult> { return managerSyncFrozen(ctx, options); }
export { searchCatalogEntries as searchCatalog };
function assertNever(value: never): never { throw new Error('Unsupported SkillShelf core operation: ' + String(value)); }
