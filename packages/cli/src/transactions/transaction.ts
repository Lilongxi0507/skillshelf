import { join, dirname, resolve, basename, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, mkdir, rm, rmdir } from 'node:fs/promises';
import { z } from 'zod';
import type { Context, State } from '../types.js';
import { exists, fingerprint, ensurePrivateDir, keyFor, readJson, writeJson, flushDirectory, within, assertDirectoryChain, renameWithRetry } from '../store/fs.js';
import { loadState, initHome, validateState } from '../store/state.js';
import { withLocks } from './locks.js';
import { fail } from '../errors.js';

export interface Change { path: string; workRoot: string; expected: string | null; prepare?: (stage: string) => Promise<void> }
// New journals store exact fs identifiers as decimal strings. Safe numeric anchors
// remain readable so interrupted journals from older versions can be recovered.
interface Anchor { path: string; dev: string | number; ino: string | number }
interface JournalOperation { path: string; stage: string; backup: string; workRoot: string; oldHash: string | null; newHash: string | null; anchors: Anchor[] }
interface Journal { schemaVersion: 1; id: string; baseGeneration: number; newGeneration: number; phase: 'prepared' | 'committed' | 'recovered'; operations: JournalOperation[]; createdAt: string }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const absolute = z.string().max(8192).refine((path) => isAbsolute(path) && resolve(path) === path && !/[\0\r\n]/u.test(path));
const hash = z.string().max(8192).refine((value) => /^(?:file|dir):[a-f0-9]{64}$/u.test(value) || value.startsWith('link:') && !value.includes('\0')).nullable();
const exactFsId = z.string().refine((value) => value.length <= 20 && /^(?:0|[1-9]\d*)$/u.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n);
const fsId = z.union([exactFsId, z.number().int().nonnegative()]);
const anchorSchema = z.object({ path: absolute, dev: fsId, ino: fsId }).strict();
const operationSchema = z.object({ path: absolute, stage: absolute, backup: absolute, workRoot: absolute, oldHash: hash, newHash: hash, anchors: z.array(anchorSchema).min(1).max(256) }).strict();
const journalSchema = z.object({ schemaVersion: z.literal(1), id: z.string().regex(UUID), baseGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), newGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), phase: z.enum(['prepared', 'committed', 'recovered']), operations: z.array(operationSchema).max(10_000), createdAt: z.string().datetime() }).strict();

export function targetWorkRoot(skillsRoot: string): string { return join(dirname(skillsRoot), '.skillshelf-work-' + keyFor(resolve(skillsRoot)).slice(0, 16)); }
export function targetLock(skillsRoot: string): string { return join(targetWorkRoot(skillsRoot), 'target.lock'); }
function validWorkRoot(path: string, workRoot: string): boolean {
  if (resolve(path) !== path || resolve(workRoot) !== workRoot || !isAbsolute(path) || !isAbsolute(workRoot)) return false;
  if (workRoot === targetWorkRoot(dirname(path))) return true;
  return ['skillshelf.json', 'skillshelf-lock.json'].includes(basename(path)) && workRoot === join(dirname(path), '.skillshelf-work');
}
function ancestorPaths(path: string): string[] {
  const paths: string[] = [];
  for (let current = path; ; current = dirname(current)) { paths.push(current); if (dirname(current) === current) return paths; }
}
async function captureAnchors(path: string, workRoot: string, work: string): Promise<Anchor[]> {
  const anchors: Anchor[] = [];
  for (const directory of [...new Set([...ancestorPaths(dirname(path)), ...ancestorPaths(workRoot), work])].sort()) {
    await assertDirectoryChain(directory); const info = await lstat(directory, { bigint: true });
    anchors.push({ path: directory, dev: info.dev.toString(), ino: info.ino.toString() });
  }
  return anchors;
}
async function assertAnchors(operation: JournalOperation): Promise<void> {
  await assertDirectoryChain(dirname(operation.path)); await assertDirectoryChain(operation.workRoot); await assertDirectoryChain(dirname(operation.stage));
  for (const anchor of operation.anchors) {
    const info = await lstat(anchor.path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev.toString() !== String(anchor.dev) || info.ino.toString() !== String(anchor.ino)) fail('RECOVERY', '事务目录身份已变化，未修改或删除任何替换目录');
  }
}
export async function pendingTransactions(ctx: Context): Promise<string[]> {
  const directory = join(ctx.home, 'transactions'); if (!(await exists(directory))) return [];
  await assertDirectoryChain(directory);
  const names = await readdir(directory); if (names.length > 10_000) fail('RECOVERY', '事务日志数量超过安全限制');
  const result: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    if (!UUID.test(name.slice(0, -5))) fail('RECOVERY', '发现未知事务日志，保留待检查');
    const journal = checkJournal(await readJson<unknown>(join(directory, name)), name);
    if (journal.phase === 'prepared') result.push(name);
  }
  return result;
}
/** Exact nonce/index path grammar, not substring/within checks on attacker-controlled paths. */
export function checkJournal(value: unknown, filename?: string): Journal {
  const parsed = journalSchema.safeParse(value);
  if (!parsed.success) fail('RECOVERY', '事务日志无效，保留数据待人工检查');
  const journal: Journal = parsed.data;
  if (filename !== undefined && filename !== journal.id + '.json' || journal.newGeneration !== journal.baseGeneration + 1) fail('RECOVERY', '事务日志ID或代际无效');
  const paths = new Set<string>();
  for (let index = 0; index < journal.operations.length; index++) {
    const operation = journal.operations[index]!; const work = join(operation.workRoot, journal.id);
    if (!validWorkRoot(operation.path, operation.workRoot) || operation.stage !== join(work, index + '-new') || operation.backup !== join(work, index + '-old') || paths.has(operation.path)) fail('RECOVERY', '事务路径无效，未执行恢复');
    paths.add(operation.path);
    const expectedAnchors = [...new Set([...ancestorPaths(dirname(operation.path)), ...ancestorPaths(operation.workRoot), work])].sort();
    if (JSON.stringify(expectedAnchors) !== JSON.stringify(operation.anchors.map((anchor) => anchor.path).sort()) || new Set(operation.anchors.map((anchor) => anchor.path)).size !== operation.anchors.length) fail('RECOVERY', '事务目录身份边界无效');
  }
  for (const operation of journal.operations) for (const other of journal.operations) {
    if (operation !== other && (within(operation.path, other.path) || within(operation.path, other.workRoot))) fail('RECOVERY', '事务目标与工作目录发生重叠');
  }
  return journal;
}
async function removeExact(path: string, expected: string | null): Promise<void> {
  await assertDirectoryChain(dirname(path));
  const actual = await fingerprint(path); if (actual === null) return;
  if (expected === null || actual !== expected) fail('RECOVERY', '恢复发现计划外修改，保留内容');
  const info = await lstat(path);
  await rm(path, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: false });
}
async function rollbackOperation(operation: JournalOperation): Promise<void> {
  await assertAnchors(operation);
  const backupHash = await fingerprint(operation.backup); const activeHash = await fingerprint(operation.path);
  if (backupHash !== null) {
    if (backupHash !== operation.oldHash) fail('RECOVERY', '备份已被修改，停止恢复');
    if (activeHash !== null) await removeExact(operation.path, operation.newHash);
    await assertAnchors(operation);
    await renameWithRetry(operation.backup, operation.path); await flushDirectory(dirname(operation.path));
  } else if (operation.oldHash === null) {
    if (activeHash !== null) await removeExact(operation.path, operation.newHash);
  } else if (activeHash !== operation.oldHash) fail('RECOVERY', '无法确定原文件所在位置，保留内容');
  await assertAnchors(operation); await removeExact(operation.stage, operation.newHash);
}
async function recoverOne(ctx: Context, path: string, input: Journal): Promise<void> {
  const journal = checkJournal(input, basename(path));
  const state = await loadState(ctx);
  if (state.lastTransactionId === journal.id && state.generation === journal.newGeneration) {
    for (const operation of journal.operations) { await assertAnchors(operation); await removeExact(operation.stage, operation.newHash); }
    journal.phase = 'committed'; await writeJson(path, journal); return;
  }
  if (state.generation !== journal.baseGeneration) fail('RECOVERY', '事务状态代际不匹配，保留所有文件');
  for (const operation of [...journal.operations].reverse()) await rollbackOperation(operation);
  journal.phase = 'recovered'; await writeJson(path, journal);
}
export async function recoverTransactions(ctx: Context): Promise<{ recovered: string[] }> {
  await initHome(ctx);
  return withLocks([join(ctx.home, 'writer.lock')], async () => {
    const recovered: string[] = [];
    for (const name of await pendingTransactions(ctx)) {
      const path = join(ctx.home, 'transactions', name); const journal = checkJournal(await readJson<unknown>(path), name);
      const locks = journal.operations.map((operation) => join(operation.workRoot, 'target.lock'));
      await withLocks(locks, async () => recoverOne(ctx, path, journal)); recovered.push(journal.id);
    }
    return { recovered };
  });
}
export interface TransactionHooks { afterStep?: (step: string, index: number) => Promise<void>; guards?: Array<{ path: string; expected: string | null }> }
export async function transact(ctx: Context, expectedState: State, nextState: State, changes: Change[], hooks: TransactionHooks = {}): Promise<void> {
  validateState(expectedState); validateState(nextState);
  if (changes.length > 10_000) fail('CONFLICT', '事务修改数量超过安全限制');
  const paths = changes.map((change) => resolve(change.path));
  if (new Set(paths).size !== paths.length) fail('CONFLICT', '同一事务不能重复修改目标');
  for (const change of changes) if (!validWorkRoot(change.path, change.workRoot)) fail('CONFLICT', '事务目标或工作目录不符合受控路径规则');
  for (const change of changes) for (const other of changes) if (change !== other && (within(change.path, other.path) || within(change.path, other.workRoot))) fail('CONFLICT', '事务目标或工作目录重叠');
  await initHome(ctx);
  // This nested order matches recoverTransactions exactly: home first, targets second.
  await withLocks([join(ctx.home, 'writer.lock')], async () => withLocks(changes.map((change) => join(change.workRoot, 'target.lock')), async () => {
    if ((await pendingTransactions(ctx)).length) fail('RECOVERY', '存在未完成事务，请先运行 repair --recover');
    const current = await loadState(ctx);
    if (current.generation !== expectedState.generation) fail('CONFLICT', '本地状态已变化，请重新预览');
    for (const change of changes) if (await fingerprint(change.path) !== change.expected) fail('CONFLICT', '目标内容已变化，未修改');
    for (const guard of hooks.guards || []) if (await fingerprint(guard.path) !== guard.expected) fail('CONFLICT', '只读契约文件已变化');
    const id = randomUUID(); const journalPath = join(ctx.home, 'transactions', id + '.json');
    const journal: Journal = { schemaVersion: 1, id, baseGeneration: current.generation, newGeneration: current.generation + 1, phase: 'prepared', operations: [], createdAt: new Date().toISOString() };
    const ownedWork = new Map<string, { dev: bigint; ino: bigint }>();
    const pendingStages: string[] = [];
    try {
      for (let index = 0; index < changes.length; index++) {
        const change = changes[index]!; const work = join(change.workRoot, id);
        await ensurePrivateDir(dirname(change.path)); await assertDirectoryChain(change.workRoot);
        if (!ownedWork.has(work)) { await mkdir(work, { mode: 0o700 }); const info = await lstat(work, { bigint: true }); ownedWork.set(work, { dev: info.dev, ino: info.ino }); }
        const stage = join(work, index + '-new'); const backup = join(work, index + '-old');
        const anchors = await captureAnchors(change.path, change.workRoot, work);
        pendingStages.push(stage); // Registered before prepare, including partially created outputs.
        if (change.prepare) await change.prepare(stage);
        const operation: JournalOperation = { path: change.path, workRoot: change.workRoot, stage, backup, oldHash: change.expected, newHash: await fingerprint(stage), anchors };
        await assertAnchors(operation); journal.operations.push(operation);
      }
      checkJournal(journal); await writeJson(journalPath, journal); await hooks.afterStep?.('prepared', -1);
      for (let index = 0; index < journal.operations.length; index++) {
        const operation = journal.operations[index]!;
        await assertAnchors(operation);
        if (await fingerprint(operation.path) !== operation.oldHash || await fingerprint(operation.stage) !== operation.newHash || await fingerprint(operation.backup) !== null) fail('CONFLICT', '提交前发现目标或stage变化');
        if (operation.oldHash !== null) { await renameWithRetry(operation.path, operation.backup); await flushDirectory(dirname(operation.path)); }
        await hooks.afterStep?.('backed-up', index);
        await assertAnchors(operation);
        if (await fingerprint(operation.path) !== null) fail('CONFLICT', '切换前出现未知文件，未覆盖');
        if (operation.newHash !== null) { if (await fingerprint(operation.stage) !== operation.newHash) fail('CONFLICT', '切换前stage已变化'); await renameWithRetry(operation.stage, operation.path); await flushDirectory(dirname(operation.path)); }
        await hooks.afterStep?.('switched', index);
      }
      for (const operation of journal.operations) { await assertAnchors(operation); if (await fingerprint(operation.path) !== operation.newHash) fail('CONFLICT', '提交状态前投影发生变化'); }
      for (const guard of hooks.guards || []) if (await fingerprint(guard.path) !== guard.expected) fail('CONFLICT', '提交时契约文件已变化');
      nextState.generation = journal.newGeneration; nextState.lastTransactionId = id; validateState(nextState);
      await writeJson(join(ctx.home, 'state.json'), nextState); await hooks.afterStep?.('state-committed', -1);
      journal.phase = 'committed'; await writeJson(journalPath, journal);
    } catch (error) {
      if (await exists(journalPath)) {
        try { await recoverOne(ctx, journalPath, journal); }
        catch { fail('RECOVERY', '操作中断且自动恢复未完成；数据已保留，请运行 repair --recover', { transaction: id }); }
      } else {
        for (const [work, identity] of ownedWork) {
          await assertDirectoryChain(work); const info = await lstat(work, { bigint: true });
          if (info.dev !== identity.dev || info.ino !== identity.ino) fail('RECOVERY', '准备工作目录被替换，保留待检查');
          for (const stage of pendingStages.filter((item) => dirname(item) === work)) await removeExact(stage, await fingerprint(stage));
          // Never recursively remove an unexpected work entry.
          if ((await readdir(work)).length === 0) await rmdir(work);
        }
      }
      throw error;
    }
  }));
}
