import { join } from 'node:path';
import type { Context, MutationOptions, OperationResult } from './types.js';
import { ensurePrivateDir, exists, readJson, writeJson } from './store/fs.js';
import { installSkills, toggleSkills } from './manager.js';
import { fail } from './errors.js';

export interface TaskProfile { id: string; name: string; description?: string; packs: string[]; members?: Record<string, string[]>; mcps?: string[]; createdAt: string; updatedAt: string }
interface ProfileFile { schemaVersion: 1; profiles: Record<string, TaskProfile> }
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
function checkId(id: string): string { if (!ID.test(id) || id.length > 64) fail('USAGE', '组合 ID 无效：' + id); return id; }
async function path(ctx: Context): Promise<string> { return join(ctx.home, 'config', 'profiles.json'); }
async function readProfiles(ctx: Context): Promise<ProfileFile> {
  const file = await path(ctx); if (!(await exists(file))) return { schemaVersion: 1, profiles: {} };
  const value = await readJson<unknown>(file);
  if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== 1 || typeof (value as { profiles?: unknown }).profiles !== 'object') fail('INTEGRITY', '任务组合文件格式无效');
  return value as ProfileFile;
}
async function saveProfiles(ctx: Context, value: ProfileFile): Promise<void> { await ensurePrivateDir(join(ctx.home, 'config')); await writeJson(await path(ctx), value); }

export async function listProfiles(ctx: Context): Promise<OperationResult> { return { profiles: Object.values((await readProfiles(ctx)).profiles) }; }
export async function getProfile(ctx: Context, id: string): Promise<TaskProfile> { const profile = (await readProfiles(ctx)).profiles[checkId(id)]; if (!profile) fail('USAGE', '任务组合不存在：' + id); return profile; }
export async function saveProfile(ctx: Context, input: { id: string; name: string; description?: string; packs: string[]; members?: Record<string, string[]>; mcps?: string[] }): Promise<OperationResult> {
  const id = checkId(input.id); if (!input.name?.trim() || input.packs.length > 100) fail('USAGE', '任务组合名称或包列表无效');
  const file = await readProfiles(ctx), prior = file.profiles[id], now = new Date().toISOString();
  const profile: TaskProfile = { id, name: input.name.trim(), description: input.description?.trim(), packs: [...new Set(input.packs)], members: input.members, mcps: input.mcps, createdAt: prior?.createdAt || now, updatedAt: now };
  file.profiles[id] = profile; await saveProfiles(ctx, file); return { profile, replaced: !!prior };
}
export async function removeProfile(ctx: Context, id: string): Promise<OperationResult> { const file = await readProfiles(ctx), key = checkId(id); if (!file.profiles[key]) return { id: key, removed: false }; delete file.profiles[key]; await saveProfiles(ctx, file); return { id: key, removed: true }; }
export async function applyProfile(ctx: Context, id: string, options: MutationOptions = {}): Promise<OperationResult> {
  const profile = await getProfile(ctx, id), preview = { profile: profile.id, packs: profile.packs, members: profile.members || {}, agents: options.agents || [], scope: options.project || 'global' };
  if (options.dryRun) return { ...preview, dryRun: true };
  const installed = await installSkills(ctx, profile.packs, { ...options, agents: options.agents });
  const enabled: OperationResult[] = [];
  for (const [pack, members] of Object.entries(profile.members || {})) if (members.length) enabled.push(await toggleSkills(ctx, members.map(member => `${pack}/${member}`), true, { ...options, agents: options.agents, yes: true }));
  return { ...preview, installed, enabled, profileVersion: profile.updatedAt };
}
