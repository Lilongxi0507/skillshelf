import { join, resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { State, Context, Release, Projection, Selection } from '../types.js';
import { exists, readJson, keyFor, assertDirectoryChain, within } from './fs.js';
import { ensurePrivateDirectory } from '../runtime/privacy.js';
import { validateHomeLocation } from '../agents/storage-boundary.js';
import { canonicalProjectPath } from '../agents/agents.js';
import { ALLOWED_SCOPE, EXACT_VERSION, canonicalJson, safeRelativePath, validateCatalog, validateIntegrity, validateManifest } from '../validation.js';
import { validateSourceManifest } from '../registry/manifest.js';
import { storeManifestFor } from '../registry/acquisition.js';
import { CLI_VERSION } from '../release.js';
import { fail } from '../errors.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const bounded = z.string().max(8192);
const safeName = z.string().min(1).max(80).regex(namePattern);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const absolute = bounded.refine((value) => isAbsolute(value) && resolve(value) === value && !/[\0-\x1f\x7f]/u.test(value));
const timestamp = z.string().datetime();
const source = z.object({ repository: bounded.optional(), commit: bounded.optional(), path: bounded.optional(), panelRevision: bounded.optional(), url: bounded.optional() }).strict();
const releaseSchema = z.object({ key: bounded, id: safeName, name: safeName, version: z.string().max(100).regex(EXACT_VERSION), packageName: bounded, integrity: bounded, contentDigest: hash, manifest: z.unknown(), source, installedAt: timestamp, origin: z.enum(['npm', 'local', 'panel', 'github']), catalogEntry: z.unknown().optional(), acquisition: z.unknown().optional(), sourceManifest: z.unknown().optional(), packRevision: z.number().int().nonnegative().optional() }).strict();
const selectionSchema = z.object({ releaseKey: bounded, pinned: z.boolean(), history: z.array(bounded).max(10_000) }).strict();
const targetSchema = z.object({ id: bounded, agent: z.enum(['claude-code', 'codex', 'opencode', 'dsh', 'cursor', 'hermes', 'universal', 'custom']), label: z.string().min(1).max(160).refine((value) => !/[\0-\x1f\x7f]/u.test(value)), scope: z.union([z.literal('global'), absolute]), path: absolute, mode: z.enum(['auto', 'link', 'copy']), scanRoots: z.array(absolute).min(1).max(32), discovery: z.enum(['unverified', 'verified']) }).strict();
const projectionSchema = z.object({ key: hash, path: absolute, releaseKey: bounded, mode: z.enum(['link', 'copy']), targetIds: z.array(bounded).min(1).max(1000), memberId: safeName.optional(), memberPath: bounded.optional() }).strict();
const projectFileHash = z.string().regex(/^file:[a-f0-9]{64}$/u);
const projectSchema = z.object({ root: absolute, specPath: absolute, lockPath: absolute, specHash: projectFileHash.optional(), lockHash: projectFileHash.optional(), selections: z.record(safeName, selectionSchema) }).strict();
const exposureSchema=z.object({all:z.boolean(),enabled:z.array(safeName).max(1000),disabled:z.array(safeName).max(1000)}).strict();
const stateSchema = z.object({ schemaVersion: z.union([z.literal(1),z.literal(2)]), generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), lastTransactionId: z.string().regex(uuid).nullable(), releases: z.record(bounded, releaseSchema), selections: z.record(safeName, selectionSchema), targets: z.record(bounded, targetSchema), projections: z.record(hash, projectionSchema), projects: z.record(absolute, projectSchema), exposures:z.record(bounded,z.record(safeName,exposureSchema)).optional(), preferences:z.record(bounded,z.object({favorite:z.boolean().optional(),tags:z.array(bounded).max(128).optional(),category:safeName.optional(),subcategory:safeName.optional()}).strict()).optional() }).strict();

export function emptyState(): State { return { schemaVersion: 2, generation: 0, lastTransactionId: null, releases: {}, selections: {}, targets: {}, projections: {}, projects: {}, exposures: {} }; }
export function storePath(ctx: Context, digest: string): string { if (!/^[a-f0-9]{64}$/u.test(digest)) fail('INTEGRITY', '内容摘要无效'); return join(ctx.home, 'store', digest, 'skill'); }
export function releaseKey(id: string, version: string, digest: string, integrity = ''): string {
  if (!namePattern.test(id) || id.length > 80 || !EXACT_VERSION.test(version) || !/^[a-f0-9]{64}$/u.test(digest)) fail('INTEGRITY', '版本键输入无效');
  safeRelativePath(id); return id + '@' + version + '#' + digest.slice(0, 16) + (integrity ? ':' + createHash('sha256').update(integrity).digest('hex').slice(0, 16) : '');
}
function invalid(message: string): never { return fail('INTEGRITY', message); }
function equalPath(left: string, right: string): boolean { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }
function selectionValid(state: State, id: string, selection: Selection): void {
  const current = state.releases[selection.releaseKey];
  if (!current || current.id !== id || new Set(selection.history).size !== selection.history.length || selection.history.includes(selection.releaseKey)) invalid('选择版本或历史记录无效');
  for (const key of selection.history) if (!state.releases[key] || state.releases[key]!.id !== id) invalid('历史记录引用了缺失或其他技能版本');
}
/** Pure strict validation used before both reading and committing the authoritative ledger. */
export function validateState(value: unknown): State {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) invalid('本地状态格式无效或需要更新 CLI');
  const state = parsed.data as State;
  if ((state.generation === 0) !== (state.lastTransactionId === null)) invalid('状态代际与事务ID不一致');
  for (const map of [state.releases, state.selections, state.targets, state.projections, state.projects]) if (Object.keys(map).length > 10_000) invalid('状态记录数量超过安全限制');
  for (const [key, release] of Object.entries(state.releases)) {
    const expectedKey=releaseKey(release.id,release.version,release.contentDigest,release.manifest.schemaVersion===2?release.integrity:'');
    const legacySchema2Key=release.manifest.schemaVersion===2?releaseKey(release.id,release.version,release.contentDigest):'';
    const compatibilityKey=release.manifest.schemaVersion===2&&key.startsWith(`${release.id}@${release.version}#${release.contentDigest.slice(0,16)}`);
    if (release.id !== release.name || release.key !== key || (key !== expectedKey && key !== legacySchema2Key && !compatibilityKey)) invalid('本地 release 记录键或名称无效');
    safeRelativePath(release.id);
    let manifest;
    try { manifest = validateManifest(release.manifest); } catch { invalid('本地 release manifest 无效'); }
    if (manifest.id !== release.id || manifest.name !== release.name) invalid('Release与manifest不一致');
    if (release.origin === 'github') {
      // The store manifest is the derived legacy view of the source manifest;
      // identity binds through releaseDigest == contentDigest, not the view digest.
      if (!release.sourceManifest) invalid('GitHub release 缺少 source manifest');
      let sourceRecord;
      try { sourceRecord = validateSourceManifest(release.sourceManifest); } catch { invalid('GitHub release source manifest 无效'); }
      if (sourceRecord.releaseDigest !== release.contentDigest) invalid('GitHub release 与 source manifest 身份不一致');
      let view;
      try { view = storeManifestFor(sourceRecord).manifest; } catch { invalid('GitHub release store manifest 派生失败'); }
      if (canonicalJson(view) !== canonicalJson(manifest)) invalid('GitHub release store manifest 与来源不一致');
    } else if (manifest.contentDigest !== release.contentDigest) invalid('Release与manifest不一致');
    if (release.source.path) safeRelativePath(release.source.path);
    if (release.source.repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(release.source.repository)) invalid('来源仓库无效');
    if (release.source.commit && !/^[a-f0-9]{40}$/u.test(release.source.commit)) invalid('来源commit无效');
    if (release.source.url) { let url: URL; try { url = new URL(release.source.url); } catch { invalid('来源URL无效'); } if (url.protocol !== 'https:' || url.username || url.password) invalid('来源URL无效'); }
    if (release.origin === 'npm') {
      if (release.packageName !== `${ALLOWED_SCOPE}/skillshelf-${manifest.schemaVersion === 2 ? 'pack' : 'skill'}-${release.name}`) invalid('非信任npm包名');
      try { validateIntegrity(release.integrity); } catch { invalid('npm release SRI无效'); }
    } else if (release.origin === 'github') {
      if (release.packageName !== `github:${release.id}` || release.integrity !== '') invalid('GitHub release 不能冒充其他来源');
    } else if (release.packageName !== `local:${release.id}` || release.integrity !== '' || release.catalogEntry !== undefined) invalid('本地或迁移来源不能冒充npm版本');
    if (release.origin === 'github' && release.catalogEntry !== undefined) {
      const entry = release.catalogEntry as unknown as Record<string, unknown>;
      if (canonicalJson(entry.sourceManifest) !== canonicalJson(release.sourceManifest) || entry.id !== release.id || entry.name !== release.name || entry.packageName !== release.packageName || entry.version !== release.version || entry.contentDigest !== release.contentDigest || entry.integrity !== '') invalid('保存的 GitHub 目录快照与release不一致');
    } else if (release.catalogEntry !== undefined) {
      const entry = release.catalogEntry;
      let checked;
      try { checked = validateCatalog({ schemaVersion: manifest.schemaVersion, catalogVersion: CLI_VERSION, minCliVersion: CLI_VERSION, scope: ALLOWED_SCOPE, categories: [{ id: entry.category, title: entry.category }], collections: [{ id: entry.collection, title: entry.collection, description: 'Installed catalog snapshot', skills: [entry.id] }], skills: [entry] }).skills[0]!; }
      catch { invalid('保存的策展版本快照无效'); }
      if (manifest.schemaVersion === 2 && canonicalJson(checked.members) !== canonicalJson(manifest.members)) invalid('保存的包成员与 manifest 不一致');
      if (checked.localArtifact !== undefined || checked.id !== release.id || checked.name !== release.name || checked.version !== release.version || checked.packageName !== release.packageName || checked.integrity !== release.integrity || checked.contentDigest !== release.contentDigest || canonicalJson(checked.source) !== canonicalJson(release.source) || canonicalJson(checked.runtime) !== canonicalJson(manifest.runtime) || checked.fileCount !== manifest.files.length || checked.unpackedSize !== manifest.files.reduce((sum, file) => sum + file.size, 0)) invalid('保存的策展版本与release不一致');
    }
  }
  for (const [id, target] of Object.entries(state.targets)) {
    const identity = [target.agent, target.scope, target.path].map((part) => process.platform === 'win32' ? part.toLowerCase() : part).join('\0');
    const expected = `${target.agent}-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
    if (target.id !== id || id !== expected || new Set(target.scanRoots.map((item) => process.platform === 'win32' ? item.toLowerCase() : item)).size !== target.scanRoots.length || !target.scanRoots.some((root) => equalPath(root, target.path))) invalid('Agent目标ID或扫描根无效');
    if (target.scope !== 'global' && !within(target.scope, target.path)) invalid('项目Agent目标必须位于该项目内');
  }
  for (const [id, selection] of Object.entries(state.selections)) selectionValid(state, id, selection);
  for (const [root, project] of Object.entries(state.projects)) {
    if (root !== project.root || project.specPath !== join(root, 'skillshelf.json') || project.lockPath !== join(root, 'skillshelf-lock.json')) invalid('项目路径记录无效');
    for (const [id, selection] of Object.entries(project.selections)) selectionValid(state, id, selection);
  }
  const paths = new Set<string>();
  for (const [key, projection] of Object.entries(state.projections)) {
    const release = state.releases[projection.releaseKey];
    if (!release || projection.key !== key || key !== keyFor(projection.path) || new Set(projection.targetIds).size !== projection.targetIds.length) invalid('投影键或版本引用无效');
    const physical = process.platform === 'win32' ? projection.path.toLowerCase() : projection.path;
    if (paths.has(physical)) invalid('重复物理投影'); paths.add(physical);
    for (const id of projection.targetIds) {
      const target = state.targets[id];
      const member = release.manifest.members?.find(member => member.id === projection.memberId && member.path === projection.memberPath);
      if (release.manifest.schemaVersion === 2 ? !member : projection.memberId !== undefined || projection.memberPath !== undefined) invalid('投影成员身份无效');
      if (!target || !equalPath(projection.path, join(target.path, member?.name || release.name))) invalid('投影路径与目标关联不一致');
      const selection = target.scope === 'global' ? state.selections[release.id] : state.projects[target.scope]?.selections[release.id];
      if (!selection || selection.releaseKey !== projection.releaseKey) invalid('投影与目标范围的选择版本不一致');
    }
  }
  return state;
}
export async function loadState(ctx: Context): Promise<State> {
  if (!isAbsolute(ctx.home) || resolve(ctx.home) !== ctx.home) invalid('SkillShelf home必须是规范绝对路径');
  await assertDirectoryChain(ctx.home);
  const path = join(ctx.home, 'state.json'); if (!(await exists(path))) return emptyState();
  return validateState(await readJson<unknown>(path));
}
/** Read-only preflight for every recorded project, including projects with no Agent target. */
export async function validateStoredHomeLocation(ctx: Context, proposedProjects: readonly string[] = []): Promise<void> {
  const state = await loadState(ctx);
  const projects = [...new Set([...Object.keys(state.projects), ...proposedProjects])];
  await validateHomeLocation(ctx,Object.values(state.targets),{projects});
}
export async function initHome(ctx: Context): Promise<void> {
  await validateStoredHomeLocation(ctx);
  await ensurePrivateDirectory(ctx.home); // Windows ACL/SID checks, POSIX 0700; only SkillShelf-owned data.
  for (const name of ['transactions', 'store', 'artifacts', 'catalogs', 'config', 'backups', 'outputs', 'cache']) await ensurePrivateDirectory(join(ctx.home, name));
}
export async function getRelease(state: State, id: string, project?: string): Promise<Release> {
  const selections = project ? state.projects[await canonicalProjectPath(project)]?.selections : state.selections;
  const selection = selections?.[id]; if (!selection) fail('USAGE', '此范围尚未安装技能：' + id);
  const release = state.releases[selection.releaseKey]; if (!release) fail('INTEGRITY', '技能版本记录缺失：' + id);
  return release;
}
export function projectionsFor(state: State, release: Release): Projection[] { return Object.values(state.projections).filter((projection) => projection.releaseKey === release.key); }
