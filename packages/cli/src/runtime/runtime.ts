import { spawn } from 'node:child_process';
import { lstat, readdir, rm } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Context, Release } from '../types.js';
import { fail } from '../errors.js';
import { createHash } from 'node:crypto';
import { ALLOWED_SCOPE, canonicalJson, LIMITS, validateCatalog, verifyTree } from '../validation.js';
import { loadCatalog } from '../catalog/catalog.js';
import { loadState } from '../store/state.js';
import { validateHomeLocation } from '../agents/storage-boundary.js';
import { readRegularFile } from '../registry/files.js';
import { verifySkillArchive } from '../registry/tar.js';
import { assertNoLinkAncestors, assertPrivatePath, canonicalExistingDirectory, canonicalStorageHome, createPrivateFile, ensurePrivateDirectory, localCommand, sanitizedEnvironment, temporaryName } from './privacy.js';
import { loadProviders, providerSecret, type ProviderConfig, type ProviderKind, type ProviderResource } from './providers.js';
export { addProvider, listProviders, removeProvider } from './providers.js';
export type { ProviderInput, ProviderKind, ProviderMetadata, ProvidersView } from './providers.js';

export interface RunOptions { project?: string; capture?: boolean }
export interface RunResult {
  skill: string; exitCode: number; signal: NodeJS.Signals | null; outputs: string; workdir: string;
  stdout?: string; stderr?: string;
}
export interface RuntimeCheck { skill: string; status: 'ok' | 'instructions' | 'unsupported' | 'missing'; details: string[] }
export interface DoctorReport {
  node: { version: string; ok: boolean }; python?: { available: boolean; version?: string };
  configuration: { ok: boolean; providerCount: number; missingEnvironment: string[]; issue?: string };
  permissions: { ok: boolean; issues: string[] }; releases: RuntimeCheck[];
  network: 'not-requested'; windows: 'not-applicable' | 'local-acl-checks-only';
}
interface PythonRuntime { executable: string; version: string }
const RUNNABLE: Record<string, readonly ProviderKind[]> = {
  'skillshelf-web-search': ['search'],
  'skillshelf-media-generation': ['image', 'video'],
};

function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

function requireCurated(release: Release): readonly ProviderKind[] {
  const kinds = Object.hasOwn(RUNNABLE, release.id) ? RUNNABLE[release.id]! : undefined;
  if (!kinds || release.origin !== 'npm' || release.manifest.id !== release.id || release.manifest.name !== release.name || release.packageName !== `${ALLOWED_SCOPE}/skillshelf-skill-${release.id}`) fail('UNAVAILABLE', 'Only catalog-verified npm first-party SkillShelf search/media releases can execute; local and panel imports are not executable');
  const runtime = release.manifest.runtime;
  if (runtime.kind !== 'python' || runtime.entrypoint !== 'scripts/run.py' || runtime.requiresNetwork !== true) fail('UNAVAILABLE', 'This first-party release does not declare its approved Python entrypoint');
  if (runtime.dependencies?.length) fail('DEPENDENCY', 'The first release runner supports standard-library-only curated scripts; dependencies are never installed automatically');
  if (!runtime.providers || runtime.providers.length !== kinds.length || runtime.providers.some((kind) => !kinds.includes(kind))) fail('INTEGRITY', 'First-party runtime provider declaration does not match the curated skill');
  if (release.contentDigest !== release.manifest.contentDigest || !/^[a-f0-9]{64}$/u.test(release.contentDigest)) fail('INTEGRITY', 'Release and manifest content digests do not match');
  return kinds;
}

function runtimeVersion(value: string): number[] | undefined {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}
function atLeast(actual: string, required: string): boolean {
  const a = runtimeVersion(actual); const b = runtimeVersion(required);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index]! > b[index]!) return true;
    if (a[index]! < b[index]!) return false;
  }
  return true;
}

async function executableCandidates(): Promise<string[]> {
  const explicit = process.env.SKILLSHELF_PYTHON;
  if (explicit) {
    if (!path.isAbsolute(explicit) || /[\0\r\n]/u.test(explicit) || /\.(?:bat|cmd|ps1)$/iu.test(explicit)) fail('USAGE', 'SKILLSHELF_PYTHON must be an absolute interpreter executable path, never a command string');
    return [explicit];
  }
  const names = process.platform === 'win32' ? ['python3.exe', 'python.exe'] : ['python3', 'python'];
  const candidates: string[] = [];
  for (const name of names) for (const directory of (sanitizedEnvironment().PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try { await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); candidates.push(candidate); }
    catch { /* A PATH entry without the interpreter is not a failure. */ }
  }
  return [...new Set(candidates)];
}

async function findPython(minimum = '3.10'): Promise<PythonRuntime | undefined> {
  if (!runtimeVersion(minimum)) fail('INTEGRITY', 'Invalid minimum Python version in the manifest');
  const required = atLeast(minimum, '3.10') ? minimum : '3.10';
  for (const executable of await executableCandidates()) {
    try {
      const result = await localCommand(executable, ['-I', '-B', '-S', '-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))'], sanitizedEnvironment());
      const version = result.stdout.trim();
      if (result.code === 0 && atLeast(version, required)) return { executable, version };
    } catch { /* Report missing locally; never install, retry a task, or call a provider. */ }
  }
  return undefined;
}

async function verifiedDirectory(ctx: Context, release: Release): Promise<string> {
  // Installation preserves this snapshot only for a verified catalog/explicitly trusted project lock.
  // An imported local tree or a self-asserted source.repository is never an execution authority.
  const snapshot = release.catalogEntry;
  const entry = snapshot
    ? validateCatalog({ schemaVersion: 1, catalogVersion: '0.1.0-preview.1', minCliVersion: '0.1.0-preview.1', scope: ALLOWED_SCOPE,
      categories: [{ id: snapshot.category, title: snapshot.category }],
      collections: [{ id: snapshot.collection, title: snapshot.collection, description: 'Installed curated release snapshot', skills: [snapshot.id] }], skills: [snapshot] }).skills[0]
    : (await loadCatalog(ctx)).skills.find((item) => item.id === release.id && item.version === release.version); // local only
  if (!entry || entry.localArtifact !== undefined || entry.id !== release.id || entry.name !== release.name || entry.packageName !== release.packageName || entry.version !== release.version || entry.integrity !== release.integrity || entry.contentDigest !== release.contentDigest || canonicalJson(entry.source) !== canonicalJson(release.source) || canonicalJson(entry.runtime) !== canonicalJson(release.manifest.runtime)) fail('INTEGRITY', 'This exact release is not authorized by an installed or current verified first-party catalog entry');
  const home = await canonicalStorageHome(ctx.home);
  const artifact = path.join(home, 'artifacts', `${entry.contentDigest}-${createHash('sha256').update(entry.integrity).digest('hex').slice(0, 16)}.tgz`);
  await assertNoLinkAncestors(artifact);
  const verified = await verifySkillArchive(await readRegularFile(artifact, LIMITS.archiveBytes), entry);
  if (canonicalJson(verified.manifest) !== canonicalJson(release.manifest)) fail('INTEGRITY', 'Runtime manifest does not match the cached original npm artifact');
  const directory = path.join(home, 'store', release.contentDigest, 'skill');
  await assertNoLinkAncestors(directory);
  await verifyTree(directory, release.manifest);
  const entrypoint = path.join(directory, 'scripts', 'run.py');
  const entryInfo = await lstat(entrypoint);
  if (!entryInfo.isFile() || entryInfo.isSymbolicLink()) fail('INTEGRITY', 'Approved runtime entrypoint is not a regular file');
  return directory;
}

/** Pure streaming redactor: prevents a secret split across stdout/stderr chunks from leaking. */
export class SecretRedactor {
  private pending = '';
  private readonly secrets: string[];
  private readonly window: number;
  constructor(secrets: string[]) {
    this.secrets = [...new Set(secrets.filter(Boolean).flatMap((secret) => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]))].sort((a, b) => b.length - a.length);
    this.window = Math.max(1, ...this.secrets.map((secret) => secret.length));
  }
  write(text: string, final = false): string {
    this.pending += text;
    let emitted = '';
    const threshold = final ? 0 : this.window - 1;
    while (this.pending.length > threshold) {
      const secret = this.secrets.find((item) => this.pending.startsWith(item));
      if (secret) { emitted += '[REDACTED]'; this.pending = this.pending.slice(secret.length); }
      else { emitted += this.pending[0]; this.pending = this.pending.slice(1); }
    }
    return emitted;
  }
}

function optionValue(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name) return args[index + 1];
    if (args[index]!.startsWith(name + '=')) return args[index]!.slice(name.length + 1);
  }
  return undefined;
}

function validateRunArguments(args: string[], secrets: string[]): void {
  if (!Array.isArray(args) || args.length > 256) fail('USAGE', 'Run arguments must be a bounded array');
  for (const argument of args) {
    if (typeof argument !== 'string' || argument.length > 32_768 || argument.includes('\0')) fail('USAGE', 'Invalid run argument');
    const option = argument.split('=', 1)[0]!.toLowerCase().replaceAll('_', '-');
    // Reject argparse long-option abbreviations too. Curated scripts also disable config overrides.
    if (option.startsWith('--') && ['--config', '--output', '--api-key', '--key', '--api-token', '--token', '--access-token', '--bearer', '--password', '--secret', '--client-secret', '--authorization', '--endpoint', '--base-url'].some((blocked) => option.length > 2 && blocked.startsWith(option))) fail('USAGE', 'Runtime configuration, credentials and output paths cannot be overridden through skill arguments');
    if (secrets.some((secret) => secret && argument.includes(secret))) fail('PERMISSION', 'Provider credentials must never be placed in process arguments');
  }
}

function requestedKinds(release: Release, args: string[], declared: readonly ProviderKind[]): { kinds: readonly ProviderKind[]; metadataOnly: boolean } {
  if (args.some((argument) => argument === '--help' || argument === '-h')) return { kinds: [], metadataOnly: true };
  if (release.id === 'skillshelf-web-search') return { kinds: ['search'], metadataOnly: false };
  const command = args[0];
  if (command === 'resources') return { kinds: declared, metadataOnly: true };
  if (command === 'image') return { kinds: ['image'], metadataOnly: false };
  if (command === 'video' || command === 'video-resume') return { kinds: ['video'], metadataOnly: false };
  fail('USAGE', 'Media run requires image, video, video-resume, resources or --help');
}

function runtimeConfig(config: ProviderConfig, kinds: readonly ProviderKind[], metadataOnly: boolean, args: string[]): { config: ProviderConfig; secrets: string[] } {
  let resources = config.resources.filter((row) => kinds.includes(row.kind));
  const engine = optionValue(args, '--engine');
  if (kinds.length === 1 && kinds[0] === 'search' && engine && engine !== 'auto') resources = resources.filter((row) => row.adapter === engine);
  const selected = optionValue(args, '--resource');
  if (selected) resources = resources.filter((row) => row.id === selected || row.model === selected);
  else if (!metadataOnly && kinds.length === 1 && kinds[0] !== 'search' && args[0] !== 'video-resume') {
    const defaultId = config.defaults[kinds[0]!];
    resources = [resources.find((row) => row.id === defaultId) ?? resources[0]].filter((row): row is ProviderResource => row !== undefined);
  }
  const secrets: string[] = [];
  const selectedResources: ProviderResource[] = [];
  for (const row of resources) {
    const { api_key_env: _environmentReference, api_key: _storedSecret, ...metadata } = row;
    if (metadataOnly) { selectedResources.push({ ...metadata, api_key: '' }); continue; }
    const secret = providerSecret(row);
    if (!secret) {
      if (selected || config.defaults[row.kind] === row.id) fail('DEPENDENCY', 'The selected provider environment key is not set');
      continue;
    }
    secrets.push(secret);
    selectedResources.push({ ...metadata, api_key: secret });
  }
  if (!metadataOnly && kinds.some((kind) => !selectedResources.some((row) => row.kind === kind))) fail('DEPENDENCY', 'Required local provider configuration or its environment key is missing');
  const defaults: ProviderConfig['defaults'] = {};
  for (const kind of kinds) {
    const id = config.defaults[kind];
    if (id && selectedResources.some((row) => row.id === id)) defaults[kind] = id;
  }
  return { config: { version: 1, resources: selectedResources, defaults }, secrets };
}

async function rewriteInputPaths(args: string[], project: string): Promise<string[]> {
  const rewritten = [...args];
  const flags = new Set(['--reference', '--mask', '--first-frame', '--last-frame', '--audio']);
  for (let index = 0; index < rewritten.length; index++) {
    const argument = rewritten[index]!;
    const eq = argument.indexOf('=');
    const flag = eq === -1 ? argument : argument.slice(0, eq);
    if (!flags.has(flag)) continue;
    const value = eq === -1 ? rewritten[index + 1] : argument.slice(eq + 1);
    if (!value) fail('USAGE', 'A local media input path is missing');
    const resolved = value.startsWith('https://') ? value : path.resolve(project, value);
    if (eq === -1) { rewritten[index + 1] = resolved; index++; }
    else rewritten[index] = `${flag}=${resolved}`;
  }
  if (rewritten[0] === 'video-resume' && rewritten[1]) rewritten[1] = path.resolve(project, rewritten[1]);
  return rewritten;
}

async function execute(python: PythonRuntime, entrypoint: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, secrets: string[], capture: boolean): Promise<{ exitCode: number; signal: NodeJS.Signals | null; stdout?: string; stderr?: string }> {
  return new Promise((resolve, reject) => {
    // Standard-library curated entrypoints need no site packages. -B also prevents immutable-store writes.
    // stdin is inherited by default. stdout/stderr relay live to inherited destinations through redaction.
    const child = spawn(python.executable, ['-B', '-E', '-s', '-S', entrypoint, ...args], { shell: false, windowsHide: true, cwd, env, stdio: [capture ? 'ignore' : 'inherit', 'pipe', 'pipe'] });
    const stdoutRedactor = new SecretRedactor(secrets); const stderrRedactor = new SecretRedactor(secrets);
    const stdoutDecoder = new StringDecoder('utf8'); const stderrDecoder = new StringDecoder('utf8');
    let stdout = ''; let stderr = ''; let oversized = false;
    const accept = (chunk: string, error: boolean): void => {
      if (capture) {
        if (error) stderr += chunk; else stdout += chunk;
        if (stdout.length + stderr.length > 4_194_304) { oversized = true; child.kill(); }
      } else if (error) process.stderr.write(chunk); else process.stdout.write(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => accept(stdoutRedactor.write(stdoutDecoder.write(chunk)), false));
    child.stderr.on('data', (chunk: Buffer) => accept(stderrRedactor.write(stderrDecoder.write(chunk)), true));
    const onInterrupt = (): void => { child.kill('SIGINT'); };
    const onTerminate = (): void => { child.kill('SIGTERM'); };
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
    const removeListeners = (): void => { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate); };
    child.once('error', () => { removeListeners(); failSpawn(); });
    const failSpawn = (): void => reject(new Error('Python process could not start; no automatic retry was attempted'));
    child.once('close', (code, signal) => {
      removeListeners();
      accept(stdoutRedactor.write(stdoutDecoder.end(), true), false);
      accept(stderrRedactor.write(stderrDecoder.end(), true), true);
      if (oversized) reject(new Error('Captured output limit reached; the task was not retried'));
      else resolve({ exitCode: code ?? (signal === 'SIGINT' ? 130 : 1), signal, ...(capture ? { stdout, stderr } : {}) });
    });
  });
}

export async function runSkill(ctx: Context, release: Release, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const declared = requireCurated(release);
  await validateHomeLocation(ctx,Object.values((await loadState(ctx)).targets),{projects:options.project?[options.project]:[]});
  const directory = await verifiedDirectory(ctx, release); // Check the entire immutable tree before any execution.
  const settings = await loadProviders(ctx);
  const allKnownSecrets = settings.resources.map((row) => row.api_key_env ? process.env[row.api_key_env] : row.api_key).filter((secret): secret is string => Boolean(secret));
  validateRunArguments(args, allKnownSecrets);
  const requested = requestedKinds(release, args, declared);
  const selected = runtimeConfig(settings, requested.kinds, requested.metadataOnly, args);
  if (ctx.offline && release.manifest.runtime.requiresNetwork && !requested.metadataOnly) fail('OFFLINE', 'This task needs a provider request; offline mode refuses network execution');
  const python = await findPython(release.manifest.runtime.minimumVersion ?? '3.10');
  if (!python) fail('DEPENDENCY', 'Python 3.10+ meeting the manifest version is required for this skill only; install it yourself or set SKILLSHELF_PYTHON to an absolute interpreter path');
  const project = await canonicalExistingDirectory(options.project ?? process.cwd());
  const preparedArgs = await rewriteInputPaths(args, project);
  const home = await canonicalStorageHome(ctx.home);
  await ensurePrivateDirectory(home);
  const runtimeRoot = path.join(home, 'runtime'); const outputsRoot = path.join(home, 'outputs');
  await ensurePrivateDirectory(runtimeRoot); await ensurePrivateDirectory(outputsRoot);
  const name = temporaryName('run');
  const workdir = path.join(runtimeRoot, name); const outputs = path.join(outputsRoot, name);
  await ensurePrivateDirectory(workdir);
  const temporaryConfig = path.join(workdir, 'providers.json');
  try {
    await ensurePrivateDirectory(outputs);
    await createPrivateFile(temporaryConfig, JSON.stringify(selected.config));
    const env = sanitizedEnvironment();
    env.HOME = workdir; env.USERPROFILE = workdir; env.TMPDIR = workdir; env.TMP = workdir; env.TEMP = workdir;
    env.SKILLSHELF_RUNTIME_CONFIG = temporaryConfig; env.SKILLSHELF_OUTPUTS = outputs;
    // Reverify immediately before spawn after preparation; same-user mutation is not a sandbox boundary.
    await verifyTree(directory, release.manifest);
    const result = await execute(python, path.join(directory, 'scripts', 'run.py'), preparedArgs, env, workdir, allKnownSecrets, options.capture === true);
    return { skill: release.id, outputs, workdir, ...result };
  } finally {
    // This UUID directory was created by this call; persistent outputs and all Agent roots are untouched.
    await rm(workdir, { recursive: true, force: true });
  }
}

export async function runtimeDoctor(ctx: Context, releases: Release[]): Promise<DoctorReport> {
  const report: DoctorReport = {
    node: { version: process.versions.node, ok: atLeast(process.versions.node, '22.20.0') },
    configuration: { ok: true, providerCount: 0, missingEnvironment: [] },
    permissions: { ok: true, issues: [] }, releases: [], network: 'not-requested',
    windows: process.platform === 'win32' ? 'local-acl-checks-only' : 'not-applicable',
  };
  let settings: ProviderConfig = { version: 1, resources: [], defaults: {} };
  try {
    settings = await loadProviders(ctx);
    report.configuration.providerCount = settings.resources.length;
    report.configuration.missingEnvironment = [...new Set(settings.resources.filter((row) => row.api_key_env && !process.env[row.api_key_env]).map((row) => row.api_key_env!))];
    report.configuration.ok = report.configuration.missingEnvironment.length === 0;
  } catch {
    report.configuration.ok = false;
    report.configuration.issue = 'Private configuration cannot be safely read; inspect file type, 0700/0600 modes (or Windows ACLs), and schema without printing secrets';
  }
  try {
    const home = await canonicalStorageHome(ctx.home);
    for (const relative of ['', 'config', 'runtime', 'outputs']) {
      const candidate = path.join(home, relative);
      try { await lstat(candidate); await assertPrivatePath(candidate, true); }
      catch (error) { if (!isMissing(error)) { report.permissions.ok = false; report.permissions.issues.push(`Unsafe private directory: ${relative || 'home'}`); } }
    }
    const root = path.join(home, 'runtime');
    try {
      const remaining = await readdir(root);
      if (remaining.some((entry) => /^run-/u.test(entry))) report.permissions.issues.push('Runtime work directories exist: active runs or interrupted-run remnants may contain private configuration; never delete an active run automatically');
    } catch (error) { if (!isMissing(error)) { report.permissions.ok = false; report.permissions.issues.push('Runtime directory cannot be inspected'); } }
  } catch { report.permissions.ok = false; report.permissions.issues.push('Data home is not a safe absolute non-link path'); }
  for (const release of releases) {
    if (release.manifest.runtime.kind === 'instructions') { report.releases.push({ skill: release.id, status: 'instructions', details: ['Instruction-only skill; Python is not needed'] }); continue; }
    let declared: readonly ProviderKind[];
    try { declared = requireCurated(release); }
    catch { report.releases.push({ skill: release.id, status: 'unsupported', details: ['Execution is not allowed for this release; only curated first-party entrypoints are supported'] }); continue; }
    const details: string[] = [];
    try { await verifiedDirectory(ctx, release); }
    catch { details.push('Stored skill tree is missing or fails integrity verification'); }
    let python: PythonRuntime | undefined;
    try { python = await findPython(release.manifest.runtime.minimumVersion ?? '3.10'); } catch { /* Local missing/invalid interpreter configuration. */ }
    report.python = python ? { available: true, version: python.version } : { available: false };
    if (!python) details.push('Required Python interpreter is unavailable; no installation was attempted');
    for (const kind of declared) if (!settings.resources.some((row) => {
      try { return row.kind === kind && Boolean(providerSecret(row)); } catch { return false; }
    })) details.push(`No usable ${kind} provider; configure it locally only if this capability is needed`);
    report.releases.push({ skill: release.id, status: details.length ? 'missing' : 'ok', details });
  }
  return report;
}
