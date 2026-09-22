import { constants } from 'node:fs';
import { open, unlink, lstat } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { ensurePrivateDir, readJson, assertDirectoryChain } from '../store/fs.js';
import { fail } from '../errors.js';

interface Lock { pid: number; nonce: string; hostname: string; createdAt: string }
function valid(value: unknown): value is Lock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const lock = value as Lock;
  return Object.keys(value).sort().join(',') === 'createdAt,hostname,nonce,pid' && Number.isSafeInteger(lock.pid) && lock.pid > 0 && typeof lock.hostname === 'string' && lock.hostname === hostname() && typeof lock.nonce === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(lock.nonce) && typeof lock.createdAt === 'string' && Number.isFinite(Date.parse(lock.createdAt));
}
export async function acquireLock(path: string): Promise<() => Promise<void>> {
  if (resolve(path) !== path) fail('CONFLICT', '锁必须使用规范绝对路径');
  await ensurePrivateDir(dirname(path));
  const value: Lock = { pid: process.pid, nonce: randomUUID(), hostname: hostname(), createdAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assertDirectoryChain(dirname(path));
    let created = false;
    try {
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); created = true;
      const identity = await handle.stat();
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      catch (error) { await handle.close(); await assertDirectoryChain(dirname(path)); const current = await lstat(path); if (current.ino === identity.ino && current.dev === identity.dev) await unlink(path); throw error; }
      await handle.close();
      return async () => {
        await assertDirectoryChain(dirname(path));
        const current = await readJson<Lock>(path).catch(() => null);
        if (!valid(current) || current.nonce !== value.nonce) fail('CONFLICT', '安装锁释放前已变化，未删除');
        const latest = await lstat(path);
        if (latest.ino !== identity.ino || latest.dev !== identity.dev || latest.isSymbolicLink()) fail('CONFLICT', '安装锁被替换，未删除');
        await unlink(path);
      };
    } catch (error) {
      if (created || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const identity = await lstat(path);
      const current = await readJson<Lock>(path).catch(() => null);
      if (!valid(current) || !identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) fail('CONFLICT', '安装锁无法安全确认，请运行 doctor');
      let dead = false;
      try { process.kill(current.pid, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') dead = true; }
      if (!dead) fail('CONFLICT', '另一 SkillShelf 操作仍持有安装锁');
      const latest = await readJson<Lock>(path).catch(() => null); const info = await lstat(path);
      if (!valid(latest) || latest.nonce !== current.nonce || info.ino !== identity.ino || info.dev !== identity.dev) fail('CONFLICT', '锁在检查时发生变化，请重试');
      await assertDirectoryChain(dirname(path)); await unlink(path);
    }
  }
  return fail('CONFLICT', '无法取得安装锁');
}

/** Home writer locks always precede sorted target locks, including recovery's nested acquisition. */
export function orderedLocks(paths: string[]): string[] {
  const unique = [...new Set(paths.map((path) => resolve(path)))];
  return unique.sort((left, right) => {
    const a = basename(left) === 'writer.lock' ? 0 : 1; const b = basename(right) === 'writer.lock' ? 0 : 1;
    return a - b || left.localeCompare(right, 'en');
  });
}
export async function withLocks<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const releases: Array<() => Promise<void>> = [];
  let failure: unknown;
  try { for (const path of orderedLocks(paths)) releases.push(await acquireLock(path)); return await fn(); }
  finally {
    for (const release of releases.reverse()) { try { await release(); } catch (error) { failure ??= error; } }
    if (failure) throw failure;
  }
}
