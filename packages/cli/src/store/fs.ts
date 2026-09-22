import { mkdir, open, rename, unlink, lstat, realpath, opendir, readlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, join, basename, relative, isAbsolute } from 'node:path';
import { homedir, platform } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from '../errors.js';

export function defaultHome(env = process.env, os = platform()): string {
  if (env.SKILLSHELF_HOME?.trim()) return resolve(env.SKILLSHELF_HOME);
  if (os === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'SkillShelf');
  if (os === 'darwin') return join(homedir(), 'Library', 'Application Support', 'SkillShelf');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'skillshelf');
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
export async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; } }
export async function canonicalPath(path: string): Promise<string> {
  let current = resolve(path); const absent: string[] = [];
  for (;;) {
    try {
      const info = await lstat(current);
      let root: string;
      try { root = await realpath(current); }
      catch (error) { if (info.isSymbolicLink() && missing(error)) fail('CONFLICT', '目标包含悬空链接'); throw error; }
      if (absent.length && !(await lstat(root)).isDirectory()) fail('CONFLICT', '目标的父路径不是目录');
      return join(root, ...absent.reverse());
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = dirname(current); if (parent === current) throw error;
      absent.push(basename(current)); current = parent;
    }
  }
}
export function within(root: string, path: string): boolean { const rel = relative(resolve(root), resolve(path)); return rel === '' || (!rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && rel !== '..' && !isAbsolute(rel)); }

/** Existing aliases must have been canonicalized by the caller; never write through changed links. */
export async function assertDirectoryChain(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/u.test(path)) fail('CONFLICT', '受管目录必须是规范绝对路径');
  let current = path;
  for (;;) {
    try { const info = await lstat(current); if (info.isSymbolicLink() || !info.isDirectory()) fail('CONFLICT', '受管目录祖先出现链接或非目录：' + current); }
    catch (error) { if (!missing(error)) throw error; }
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}
export async function ensurePrivateDir(path: string): Promise<void> {
  const absolute = resolve(path); await assertDirectoryChain(absolute);
  let current = absolute; const absent: string[] = [];
  while (!(await exists(current))) { absent.push(current); const parent = dirname(current); if (parent === current) break; current = parent; }
  for (const directory of absent.reverse()) {
    await assertDirectoryChain(dirname(directory));
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await assertDirectoryChain(directory);
  }
  await assertDirectoryChain(absolute); // Existing Agent roots are not chmodded or given new ACLs.
}
export async function flushDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
  finally { await handle.close(); }
}
/** Bounded sharing-violation retries on Windows only; never delete a destination to force rename. */
export async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await assertDirectoryChain(dirname(source)); await assertDirectoryChain(dirname(destination));
    try { await rename(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await delay([20, 50, 100][attempt]!);
    }
  }
}
export async function atomicWrite(path: string, bytes: string | Buffer, mode = 0o600): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const expected = await fingerprint(path);
  if (await exists(path)) { const info = await lstat(path); if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) fail('CONFLICT', '拒绝覆盖非普通或硬链接文件：' + path); }
  const temporary = join(dirname(path), '.' + basename(path) + '.' + randomUUID());
  let created = false;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode); created = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await assertDirectoryChain(dirname(path));
    if (await fingerprint(path) !== expected) fail('CONFLICT', '写入前文件已变化：' + path);
    await renameWithRetry(temporary, path); created = false; await flushDirectory(dirname(path));
  } finally { if (created) await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; }); }
}
export async function writeJson(path: string, value: unknown): Promise<void> { await atomicWrite(path, JSON.stringify(value, null, 2) + '\n'); }
export async function readJson<T>(path: string): Promise<T> {
  await assertDirectoryChain(dirname(path));
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 32 * 1024 * 1024) fail('INTEGRITY', 'JSON 文件类型或大小无效：' + path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (before.ino !== info.ino || before.dev !== info.dev || !before.isFile() || before.nlink !== 1 || before.size > 32 * 1024 * 1024) fail('CONFLICT', 'JSON 文件在读取时变化');
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const read = await handle.read(bytes, length, bytes.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('CONFLICT', 'JSON 文件在读取时变化');
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, length))) as T;
  } catch (error) { if (error instanceof SyntaxError || error instanceof TypeError) fail('INTEGRITY', 'JSON 内容无效：' + path); throw error; }
  finally { await handle.close(); }
}
export const FINGERPRINT_LIMITS = Object.freeze({ entries: 10_000, depth: 32, fileBytes: 32 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 });
export async function fingerprint(path: string): Promise<string | null> {
  await assertDirectoryChain(dirname(path));
  let entries = 0; let bytes = 0;
  async function visit(filename: string, depth: number): Promise<string | null> {
    if (depth > FINGERPRINT_LIMITS.depth || ++entries > FINGERPRINT_LIMITS.entries) fail('CONFLICT', '目录指纹超过安全数量或深度限制');
    let info;
    try { info = await lstat(filename); } catch (error) { if (missing(error)) return null; throw error; }
    if (info.isSymbolicLink()) return 'link:' + await readlink(filename);
    if (info.isFile()) {
      bytes += info.size;
      if (info.nlink !== 1 || info.size > FINGERPRINT_LIMITS.fileBytes || bytes > FINGERPRINT_LIMITS.totalBytes) fail('CONFLICT', '文件指纹超过安全大小或存在硬链接');
      const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size || before.nlink !== 1) fail('CONFLICT', '指纹文件在读取前变化');
        const hash = createHash('sha256'); const chunk = Buffer.alloc(64 * 1024); let offset = 0;
        for (;;) {
          const read = await handle.read(chunk, 0, chunk.length, offset); if (!read.bytesRead) break;
          offset += read.bytesRead; if (offset > before.size) fail('CONFLICT', '指纹文件在读取时增大'); hash.update(chunk.subarray(0, read.bytesRead));
        }
        const after = await handle.stat();
        if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('CONFLICT', '指纹文件在读取时变化');
        return 'file:' + hash.digest('hex');
      } finally { await handle.close(); }
    }
    if (!info.isDirectory()) fail('CONFLICT', '不支持的文件类型：' + filename);
    await assertDirectoryChain(filename);
    const names: string[] = [];
    const directory = await opendir(filename);
    for await (const entry of directory) {
      names.push(entry.name); if (names.length + entries > FINGERPRINT_LIMITS.entries) fail('CONFLICT', '目录指纹超过安全数量限制');
    }
    const rows: string[] = [];
    for (const name of names.sort()) { const result = await visit(join(filename, name), depth + 1); if (result === null) fail('CONFLICT', '目录在指纹扫描时变化'); rows.push(JSON.stringify([name, result])); }
    const after = await lstat(filename);
    if (!after.isDirectory() || after.isSymbolicLink() || after.ino !== info.ino || after.dev !== info.dev || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail('CONFLICT', '目录在指纹扫描时变化');
    return 'dir:' + createHash('sha256').update(rows.join('\n')).digest('hex');
  }
  return visit(path, 0);
}
export function keyFor(value: string): string { return createHash('sha256').update(process.platform === 'win32' ? value.toLowerCase() : value).digest('hex'); }
