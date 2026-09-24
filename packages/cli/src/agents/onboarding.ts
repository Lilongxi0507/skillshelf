import { cp, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentId, AgentTarget, Context, OperationResult } from '../types.js';
import { loadState, storePath } from '../store/state.js';
import { chmodTree } from '../store/local.js';
import { readJson, ensurePrivateDir, exists, within } from '../store/fs.js';
import { inventory, digestManifest, verifyTree } from '../validation.js';
import { agentHints, resolveAgentTarget } from './agents.js';
import { addAgent, toggleSkills } from '../manager.js';
import { fail } from '../errors.js';

export interface ConnectMessage {
  protocol: 'skillshelf-connect/v1';
  agent?: AgentId;
  message: string;
  steps: string[];
}

export interface EnrolledAgent {
  targetId: string;
  agent: AgentId;
  label: string;
  path: string;
  status: 'registered' | 'configured' | 'verified' | 'reload-required';
  evidence: string[];
  enrolledAt: string;
  lastVerifiedAt?: string;
}

interface EnrollmentFile { schemaVersion: 1; agents: Record<string, EnrolledAgent> }

async function enrollmentPath(ctx: Context): Promise<string> {
  return join(ctx.home, 'config', 'enrollment.json');
}

async function readEnrollments(ctx: Context): Promise<EnrollmentFile> {
  const path = await enrollmentPath(ctx);
  if (!(await exists(path))) return { schemaVersion: 1, agents: {} };
  const value = await readJson<unknown>(path);
  if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== 1 || typeof (value as { agents?: unknown }).agents !== 'object') {
    fail('INTEGRITY', 'Agent 接入记录格式无效');
  }
  return value as EnrollmentFile;
}

async function writeEnrollments(ctx: Context, file: EnrollmentFile): Promise<void> {
  await ensurePrivateDir(join(ctx.home, 'config'));
  await writeFile(await enrollmentPath(ctx), JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
}

export function connectMessage(agent?: AgentId): ConnectMessage {
  const label = agent ? `（目标：${agent}）` : '';
  const steps = [
    '读取本消息并确认你正在使用的原生 Agent 与技能目录。',
    '执行 skillshelf agents add <agent>，或使用 --path 指定实际技能目录。',
    '执行 skillshelf agents verify <target>，返回目录、版本和读取证据。',
    '如果发现同内容私有技能，先运行 skillshelf agents dedupe <target> --dry-run，再等待用户确认。',
  ];
  return {
    protocol: 'skillshelf-connect/v1',
    agent,
    message: `请接入本机 SkillShelf${label}。${steps.join(' ')}`,
    steps,
  };
}

export async function enrollAgent(ctx: Context, agent: AgentId, options: { path?: string; label?: string; mode?: 'auto' | 'link' | 'copy'; yes?: boolean; dryRun?: boolean } = {}): Promise<OperationResult> {
  const result = await addAgent(ctx, agent, { path: options.path, label: options.label, mode: options.mode, yes: options.yes, dryRun: options.dryRun });
  if (options.dryRun) return { ...result, idempotent: true, protocol: 'skillshelf-connect/v1' };
  const target = (result as { target: AgentTarget }).target;
  const file = await readEnrollments(ctx);
  const prior = file.agents[target.id];
  const now = new Date().toISOString();
  file.agents[target.id] = {
    targetId: target.id,
    agent: target.agent,
    label: target.label,
    path: target.path,
    status: prior?.status === 'verified' ? 'verified' : 'configured',
    evidence: [...new Set([...(prior?.evidence || []), 'registered-target', 'shared-store-path'])],
    enrolledAt: prior?.enrolledAt || now,
    lastVerifiedAt: prior?.lastVerifiedAt,
  };
  await writeEnrollments(ctx, file);
  return { ...result, idempotent: !!prior, enrollment: file.agents[target.id] };
}

export async function verifyEnrolledAgent(ctx: Context, id: string): Promise<OperationResult> {
  const state = await loadState(ctx);
  const target = state.targets[id];
  if (!target) fail('USAGE', '未注册此 Agent 目标：' + id);
  const file = await readEnrollments(ctx);
  const prior = file.agents[id];
  if (!prior) fail('USAGE', 'Agent 尚未完成接入登记：' + id);
  const evidence = [...new Set([...(prior.evidence || []), 'registered-target'])];
  const entries = await scanTarget(target);
  const status: EnrolledAgent['status'] = entries.some(entry => entry.kind === 'shared') ? 'verified' : 'reload-required';
  const now = new Date().toISOString();
  file.agents[id] = { ...prior, status, evidence: [...evidence, ...(status === 'verified' ? ['native-directory-read'] : [])], lastVerifiedAt: now };
  await writeEnrollments(ctx, file);
  return { target, status, evidence: file.agents[id]!.evidence, scanned: entries.length, entries };
}

export async function listEnrollments(ctx: Context): Promise<OperationResult> {
  const file = await readEnrollments(ctx);
  const state = await loadState(ctx);
  return { protocol: 'skillshelf-connect/v1', agents: Object.values(file.agents).map(item => ({ ...item, registered: !!state.targets[item.targetId], hints: state.targets[item.targetId] ? agentHints(state.targets[item.targetId]!) : [] })) };
}

export interface ScannedSkill { path: string; name: string; digest: string; kind: 'shared' | 'private' | 'duplicate' | 'conflict' | 'unknown'; managedRelease?: string; memberId?: string }

async function findSkillDirectories(root: string, depth = 0): Promise<string[]> {
  if (depth > 4 || !(await exists(root))) return [];
  const result: string[] = [];
  let names: string[];
  try { names = await readdir(root); } catch { return result; }
  if (names.includes('SKILL.md')) result.push(root);
  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const child = join(root, name);
    try { if ((await lstat(child)).isDirectory()) result.push(...await findSkillDirectories(child, depth + 1)); } catch { /* changed during scan */ }
  }
  return result;
}

export async function scanTarget(target: AgentTarget): Promise<ScannedSkill[]> {
  const roots = [...new Set([target.path, ...target.scanRoots])];
  const paths = [...new Set((await Promise.all(roots.map(root => findSkillDirectories(root)))).flat())];
  const result: ScannedSkill[] = [];
  for (const path of paths) {
    try {
      const files = await inventory(path), digest = digestManifest(files);
      result.push({ path, name: basename(path), digest, kind: 'private' });
    } catch { result.push({ path, name: basename(path), digest: '', kind: 'unknown' }); }
  }
  return result;
}

export async function previewDedupe(ctx: Context, targetId: string): Promise<OperationResult> {
  const state = await loadState(ctx), target = state.targets[targetId];
  if (!target) fail('USAGE', '未注册此 Agent 目标：' + targetId);
  const scanned = await scanTarget(target);
  const managed = Object.values(state.projections).filter(projection => projection.targetIds.includes(targetId));
  const matches: ScannedSkill[] = [];
  const conflicts: ScannedSkill[] = [];
  for (const item of scanned) {
    const projection = managed.find(candidate => candidate.path === item.path);
    if (projection) { item.kind = 'shared'; item.managedRelease = projection.releaseKey; item.memberId = projection.memberId; continue; }
    const match = await (async () => {
      for (const candidate of Object.values(state.releases)) {
        for (const member of candidate.manifest.members || [{ id: undefined, name: candidate.name, path: '' }]) {
          if (member.name !== item.name) continue;
          try {
            const memberRoot = join(storePath(ctx, candidate.contentDigest), member.path || '');
            if (digestManifest(await inventory(memberRoot)) === item.digest) return { release: candidate, memberId: member.id };
          } catch { /* incomplete historical content is not a dedupe source */ }
        }
      }
      return undefined;
    })();
    if (match) { item.kind = 'duplicate'; item.managedRelease = match.release.key; item.memberId = match.memberId; matches.push(item); }
    else if (Object.values(state.selections).some(selection => state.releases[selection.releaseKey]?.name === item.name)) { item.kind = 'conflict'; conflicts.push(item); }
  }
  return { target, scanned, duplicates: matches, conflicts, protected: scanned.filter(item => item.kind === 'private' || item.kind === 'unknown'), requiresConfirmation: matches.length > 0 };
}

export async function applyDedupe(ctx: Context, targetId: string, options: { paths?: string[]; yes?: boolean; dryRun?: boolean } = {}): Promise<OperationResult> {
  const preview = await previewDedupe(ctx, targetId);
  const duplicates = (preview.duplicates as ScannedSkill[]).filter(item => !options.paths?.length || options.paths.includes(item.path));
  if (!options.yes && !options.dryRun) fail('USAGE', '去重需要先预览并明确确认');
  if (options.dryRun) return { ...preview, selected: duplicates.map(item => item.path), dryRun: true };
  const state = await loadState(ctx), target = state.targets[targetId]!;
  const backupRoot = join(ctx.home, 'backups', `dedupe-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`);
  await ensurePrivateDir(backupRoot);
  const replaced: string[] = [];
  const manifest: Record<string, string> = {};
  for (const item of duplicates) {
    const release = state.releases[item.managedRelease!];
    if (!release) continue;
    await verifyTree(storePath(ctx, release.contentDigest), release.manifest);
    if (!within(target.path, item.path)) fail('CONFLICT', '扫描结果超出 Agent 目标目录：' + item.path);
    const backup = join(backupRoot, item.name);
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await cp(item.path, backup, { recursive: true, errorOnExist: true, force: false });
    manifest[item.path] = backup;
    await chmodTree(item.path, false);
    await rm(item.path, { recursive: true, force: true });
    try {
      const selectedMember = release.manifest.members?.find(member => member.id === item.memberId || member.name === item.name);
      await toggleSkills(ctx, [selectedMember ? `${release.id}/${selectedMember.id}` : release.id], true, { agents: [targetId], yes: true });
    } catch (error) { await cp(backup, item.path, { recursive: true, errorOnExist: true, force: false }); throw error; }
    replaced.push(item.path);
  }
  await writeFile(join(backupRoot, 'dedupe.json'), JSON.stringify({ schemaVersion: 1, targetId, paths: manifest }, null, 2) + '\n', { mode: 0o600 });
  return { targetId, backup: backupRoot, replaced, conflicts: preview.conflicts, restoredBy: 'backup directory' };
}

export async function restoreDedupe(ctx: Context, backup: string): Promise<OperationResult> {
  const root = resolve(backup); if (!within(join(ctx.home, 'backups'), root)) fail('CONFLICT', '备份路径必须位于 SkillShelf backups 目录');
  if (!(await exists(root))) fail('USAGE', '备份不存在');
  const record = await readJson<{ schemaVersion: 1; targetId: string; paths: Record<string, string> }>(join(root, 'dedupe.json'));
  if (record.schemaVersion !== 1 || !record.paths || typeof record.paths !== 'object') fail('INTEGRITY', '去重备份清单无效');
  const state = await loadState(ctx), targetRoot = record.targetId ? state.targets[record.targetId] : undefined;
  if (!targetRoot) fail('INTEGRITY', '去重备份缺少有效 Agent 目标');
  const restored: string[] = [];
  for (const [target, source] of Object.entries(record.paths)) {
    if (!within(targetRoot.path, resolve(target))) fail('CONFLICT', '去重恢复目标越界');
    if (await exists(target)) continue;
    if (!within(root, resolve(source))) fail('CONFLICT', '去重备份来源越界');
    await cp(source, target, { recursive: true, errorOnExist: true, force: false }); restored.push(target);
  }
  return { restored, backup: root };
}
