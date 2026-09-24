import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Context, PackMember, RuntimeDeclaration, SkillManifest, OperationResult } from './types.js';
import { ensurePrivateDir, exists, readJson, writeJson, within } from './store/fs.js';
import { digestPackManifest, EXACT_VERSION, inventory, validateManifest, validateSkillDocument, verifyTree } from './validation.js';
import { importValidatedPack } from './manager.js';
import { initHome } from './store/state.js';
import { fail } from './errors.js';

export interface DraftMemberInput { id: string; name?: string; title?: string; description?: string; category?: string; subcategory?: string; tags?: string[]; path?: string }
const runtime: RuntimeDeclaration = { kind: 'instructions', requiresNetwork: false };

function safeId(id: string): string { if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || id.length > 64) fail('USAGE', '草稿 ID 无效：' + id); return id; }
function member(input: DraftMemberInput, parent: string): PackMember {
  const id = safeId(input.id), name = input.name || id;
  return { id, name, path: input.path !== undefined ? input.path : id, legacyId: id, title: input.title || name, description: input.description || '本机创作技能', useWhen: input.description || '需要本机创作的共享技能时使用。', examples: [], category: input.category || 'ai-agent', subcategory: input.subcategory || 'local', tags: input.tags || ['local'], purpose: input.description || '本机创作', stack: [], dependencies: [], license: 'MIT', source: {}, runtime };
}

async function draftRoot(ctx: Context, id: string): Promise<string> {
  safeId(id); return join(ctx.home, 'drafts', id);
}

export async function createDraft(ctx: Context, id: string, options: { description?: string; members?: DraftMemberInput[] } = {}): Promise<OperationResult> {
  const root = await draftRoot(ctx, id); if (await exists(root)) fail('CONFLICT', '草稿已存在：' + id);
  const members = options.members?.length ? options.members : [{ id, name: id, description: options.description }];
  const packMembers = members.map(input => member(input, id));
  await initHome(ctx);
  await ensurePrivateDir(root);
  for (const item of packMembers) {
    const directory = join(root, item.path);
    await ensurePrivateDir(directory);
    const document = `---\nname: ${item.name}\ndescription: ${item.description}\n---\n\n# ${item.title}\n\n${item.description}\n`;
    await writeFile(join(directory, 'SKILL.md'), document, { mode: 0o600 });
    await writeFile(join(directory, 'LICENSE'), 'MIT\n', { mode: 0o600 });
  }
  await writeFile(join(root, 'LICENSE'), 'MIT\n', { mode: 0o600 });
  return { id, path: root, members: packMembers.map(item => ({ id: item.id, path: item.path })), next: '编辑 SKILL.md 后运行 skillshelf author validate ' + id };
}

async function manifestForDraft(ctx: Context, id: string): Promise<SkillManifest> {
  const root = await draftRoot(ctx, id); if (!(await exists(root))) fail('USAGE', '草稿不存在：' + id);
  const files = await inventory(root);
  const entries = (await readdir(root, { withFileTypes: true })).filter(item => item.isDirectory() && !item.name.startsWith('.'));
  const candidates: DraftMemberInput[] = [];
  for (const entry of entries) if (await exists(join(root, entry.name, 'SKILL.md'))) candidates.push({ id: entry.name, name: entry.name, path: entry.name });
  if (!candidates.length) fail('INTEGRITY', '草稿缺少 SKILL.md');
  const members = candidates.map(input => member(input, id));
  for (const item of members) validateSkillDocument(await readFile(join(root, item.path, 'SKILL.md')), item.name);
  const manifest: SkillManifest = { schemaVersion: 2, id: safeId(id), name: safeId(id), files, contentDigest: '0'.repeat(64), runtime, members };
  manifest.contentDigest = digestPackManifest(manifest);
  return validateManifest(manifest);
}

export async function validateDraft(ctx: Context, id: string): Promise<OperationResult> {
  const manifest = await manifestForDraft(ctx, id), root = await draftRoot(ctx, id);
  await verifyTree(root, manifest);
  return { id, valid: true, manifest: { ...manifest, files: manifest.files.length, members: manifest.members?.map(item => item.id) } };
}

export async function listDrafts(ctx: Context): Promise<OperationResult> {
  const root = join(ctx.home, 'drafts'); if (!(await exists(root))) return { drafts: [] };
  const drafts = [];
  for (const name of await readdir(root)) {
    try { const manifest = await manifestForDraft(ctx, name); drafts.push({ id: name, members: manifest.members?.length || 0, files: manifest.files.length, valid: true }); }
    catch (error) { drafts.push({ id: name, valid: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return { drafts };
}

export async function publishDraft(ctx: Context, id: string, options: { version?: string; yes?: boolean; dryRun?: boolean } = {}): Promise<OperationResult> {
  const version = options.version || '0.0.0-local.1';
  if (!EXACT_VERSION.test(version)) fail('USAGE', '草稿版本必须是精确的语义化版本');
  const manifest = await manifestForDraft(ctx, id), root = await draftRoot(ctx, id);
  await verifyTree(root, manifest);
  if (options.dryRun) return { id, version, members: manifest.members?.map(item => item.id), files: manifest.files.length, dryRun: true };
  if (!options.yes) fail('USAGE', '入库需要明确确认');
  return importValidatedPack(ctx, root, manifest, version, { yes: true });
}

export async function removeDraft(ctx: Context, id: string, options: { dryRun?: boolean } = {}): Promise<OperationResult> {
  const root = await draftRoot(ctx, id); if (options.dryRun) return { id, path: root, exists: await exists(root), dryRun: true };
  if (!(await exists(root))) return { id, removed: false };
  if (!within(join(ctx.home, 'drafts'), resolve(root))) fail('CONFLICT', '草稿路径越界');
  const { rm } = await import('node:fs/promises'); await rm(root, { recursive: true }); return { id, removed: true };
}
