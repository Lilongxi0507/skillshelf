import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../errors.js';

export interface LocalCommandResult { code: number; stdout: string; stderr: string }
/** Shared read/write budget for private provider configuration, measured in UTF-8 bytes. */
export const PRIVATE_CONFIG_MAX_BYTES = 1_048_576;

/** Local probes only: no shell, bounded output, bounded lifetime, and no raw spawn error text. */
export async function localCommand(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<LocalCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, env, ...(cwd ? { cwd } : {}), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let tooLarge = false;
    const timer = setTimeout(() => child.kill(), 10_000);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > 65_536) { tooLarge = true; child.kill(); } });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); if (stderr.length > 65_536) { tooLarge = true; child.kill(); } });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Local executable is unavailable')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (tooLarge) reject(new Error('Local probe exceeded its output limit'));
      else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Reject preload hooks, cloud credentials, proxies, Python paths and unrelated provider keys. */
export function sanitizedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const permitted = ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM', 'COLORTERM', 'NO_COLOR'];
  for (const name of permitted) if (source[name] !== undefined) result[name] = source[name];
  const entries = (source.PATH ?? source.Path ?? '').split(path.delimiter).filter((entry) => path.isAbsolute(entry) && !/[\0\r\n]/u.test(entry));
  result.PATH = entries.join(path.delimiter);
  result.PYTHONDONTWRITEBYTECODE = '1';
  result.PYTHONNOUSERSITE = '1';
  return result;
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function permission(message: string): never { return fail('PERMISSION', message); }

/** Refuse symlink/junction ancestors; private storage never changes permissions on an Agent root. */
export async function assertNoLinkAncestors(target: string): Promise<void> {
  if (!path.isAbsolute(target)) permission('Private runtime storage must use an absolute path');
  let current = path.resolve(target);
  for (;;) {
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) permission('Private runtime storage cannot contain symbolic links or junctions');
      if (current !== path.resolve(target) && !entry.isDirectory()) permission('Private runtime storage conflicts with a non-directory');
      if (process.platform !== 'win32' && entry.isDirectory() && (entry.mode & 0o022) !== 0 && (entry.mode & 0o1000) === 0) permission('Private runtime storage cannot have group/world-writable non-sticky ancestors');
    } catch (error) { if (!missing(error)) throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function windowsTools(): { powershell: string; icacls: string; whoami: string; env: NodeJS.ProcessEnv } {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !/^[A-Za-z]:\\Windows$/iu.test(root)) permission('Cannot establish a controlled Windows system tool path; secret storage refused');
  return {
    powershell: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    icacls: path.win32.join(root, 'System32', 'icacls.exe'),
    whoami: path.win32.join(root, 'System32', 'whoami.exe'),
    env: { SystemRoot: root, SYSTEMROOT: root, PATH: path.win32.join(root, 'System32') },
  };
}

async function windowsSid(): Promise<string> {
  const tools = windowsTools();
  const result = await localCommand(tools.whoami, ['/user', '/fo', 'csv', '/nh'], tools.env);
  const sid = result.code === 0 ? result.stdout.match(/\bS-1-5-21-\d+-\d+-\d+-\d+\b/u)?.[0] : undefined;
  if (!sid) permission('Cannot verify the current Windows user SID; secret storage refused');
  return sid;
}

/** Pure validator exported so SID/ACE edge cases can be tested without claiming Windows execution. */
export function validateWindowsAcl(value: unknown, sid: string): boolean {
  if (!/^S-1-5-21-\d+-\d+-\d+-\d+$/u.test(sid) || !value || typeof value !== 'object') return false;
  const acl = value as { owner?: unknown; protected?: unknown; rules?: unknown };
  if (acl.owner !== sid || acl.protected !== true || !Array.isArray(acl.rules) || acl.rules.length === 0) return false;
  const allowed = new Set([sid, 'S-1-5-18', 'S-1-5-32-544']);
  let selfFull = false;
  for (const item of acl.rules) {
    if (!item || typeof item !== 'object') return false;
    const rule = item as { sid?: unknown; type?: unknown; rights?: unknown; inherited?: unknown };
    if (typeof rule.sid !== 'string' || !allowed.has(rule.sid) || rule.type !== 'Allow' || rule.inherited !== false || typeof rule.rights !== 'number') return false;
    if (rule.sid === sid && (rule.rights & 2_032_127) === 2_032_127) selfFull = true;
  }
  return selfFull;
}

async function checkWindowsAcl(target: string): Promise<void> {
  const tools = windowsTools();
  const sid = await windowsSid();
  // Paths travel through an environment variable, not interpolated PowerShell source; no tokens in argv.
  const script = "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:SKILLSHELF_ACL_PATH; $s=[System.Security.Principal.SecurityIdentifier]; $r=@($a.GetAccessRules($true,$true,$s)|ForEach-Object { @{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=[int]$_.FileSystemRights;inherited=$_.IsInherited} }); @{owner=$a.GetOwner($s).Value;protected=$a.AreAccessRulesProtected;rules=$r}|ConvertTo-Json -Depth 4 -Compress";
  const result = await localCommand(tools.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { ...tools.env, SKILLSHELF_ACL_PATH: target });
  let acl: unknown;
  try { acl = JSON.parse(result.stdout); } catch { permission('Cannot inspect Windows ACLs; secret storage refused'); }
  if (result.code !== 0 || !validateWindowsAcl(acl, sid)) permission('Windows storage ACLs are not private to the verified user, SYSTEM and Administrators');
  const checked = await localCommand(tools.icacls, [target, '/verify', '/q'], tools.env);
  if (checked.code !== 0) permission('Windows ACL integrity verification failed');
}

async function restrictNewWindowsPath(target: string, directory: boolean): Promise<void> {
  const tools = windowsTools();
  const sid = await windowsSid();
  const access = directory ? '(OI)(CI)F' : 'F';
  const result = await localCommand(tools.icacls, [target, '/inheritance:r', '/grant:r', `*${sid}:${access}`, '*S-1-5-18:' + access, '*S-1-5-32-544:' + access, '/q'], tools.env);
  if (result.code !== 0) permission('Cannot establish private Windows ACLs; secret storage refused');
  await checkWindowsAcl(target);
}

export async function assertPrivatePath(target: string, directory: boolean): Promise<void> {
  await assertNoLinkAncestors(target);
  const info = await lstat(target);
  if (directory ? !info.isDirectory() : !info.isFile()) permission('Runtime storage has an unexpected file type');
  if (process.platform === 'win32') { await checkWindowsAcl(target); return; }
  if (typeof process.getuid !== 'function' || info.uid !== process.getuid()) permission('Runtime storage is not owned by the current user');
  const expected = directory ? 0o700 : 0o600;
  if ((info.mode & 0o7777) !== expected) permission(`Runtime ${directory ? 'directories require 0700' : 'files require 0600'} permissions; existing permissions are never changed automatically`);
  if (!directory && info.nlink !== 1) permission('Private runtime files must not have additional hard links');
}

/** Creates private directories only for explicit provider mutations/runs, never for list/doctor. */
export async function ensurePrivateDirectory(target: string): Promise<void> {
  await assertNoLinkAncestors(target);
  try { await assertPrivatePath(target, true); return; }
  catch (error) { if (!missing(error)) throw error; }
  const parent = path.dirname(target);
  try { const parentInfo = await lstat(parent); if (!parentInfo.isDirectory()) permission('Private directory parent is not a directory'); }
  catch (error) { if (!missing(error)) throw error; await ensurePrivateDirectory(parent); }
  try {
    await mkdir(target, { mode: 0o700 });
    if (process.platform === 'win32') await restrictNewWindowsPath(target, true);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await assertPrivatePath(target, true);
}

export async function createPrivateFile(target: string, contents: string): Promise<void> {
  await assertPrivatePath(path.dirname(target), true);
  await assertNoLinkAncestors(target);
  const descriptor = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    // Windows starts empty. Do not write a secret until the ACL has been secured and verified.
    if (process.platform === 'win32') await restrictNewWindowsPath(target, false);
    await assertPrivatePath(target, false);
    await descriptor.writeFile(contents, 'utf8');
    await descriptor.sync();
  } catch (error) {
    await descriptor.close();
    await unlink(target).catch(() => undefined);
    throw error;
  }
  await descriptor.close();
  await assertPrivatePath(target, false);
}

export async function readPrivateFile(target: string): Promise<string> {
  await assertPrivatePath(target, false);
  const descriptor = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await descriptor.stat();
    const current = await lstat(target);
    if (!info.isFile() || info.nlink !== 1 || info.ino !== current.ino || info.dev !== current.dev || info.size > PRIVATE_CONFIG_MAX_BYTES) permission('Private configuration file changed or is too large');
    if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600)) permission('Private configuration file permissions changed');
    const bytes = Buffer.alloc(info.size + 1); let length = 0;
    while (length < bytes.length) {
      const read = await descriptor.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await descriptor.stat(); const named = await lstat(target);
    if (length !== info.size || after.size !== info.size || after.ino !== info.ino || after.dev !== info.dev || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || named.ino !== info.ino || named.dev !== info.dev || named.isSymbolicLink()) permission('Private configuration file changed while reading');
    try { return new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { permission('Private configuration must contain valid UTF-8'); }
  } finally { await descriptor.close(); }
}

export async function canonicalStorageHome(home: string): Promise<string> {
  if (!path.isAbsolute(home)) fail('USAGE', 'SkillShelf data home must be absolute');
  await assertNoLinkAncestors(home);
  return path.resolve(home);
}

export function temporaryName(prefix: string): string { return `${prefix}-${randomUUID()}`; }
export async function canonicalExistingDirectory(value: string): Promise<string> {
  if (!path.isAbsolute(value)) fail('USAGE', 'Project paths must be absolute');
  const canonical = await realpath(value);
  if (!(await lstat(canonical)).isDirectory()) fail('USAGE', 'Project path must be a directory');
  return canonical;
}
