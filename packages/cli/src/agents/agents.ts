import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentId, AgentTarget } from '../types.js';

export interface AgentOptions {
  home?: string;
  project?: string;
  /** An explicit skills directory, not an agent configuration file. */
  path?: string;
  label?: string;
  mode?: 'auto' | 'link' | 'copy';
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const AGENTS: AgentId[] = ['claude-code', 'codex', 'opencode', 'dsh', 'cursor', 'hermes', 'universal'];
const LABELS: Record<AgentId, string> = {
  'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', dsh: 'DSH',
  cursor: 'Cursor', hermes: 'Hermes', universal: 'Universal (.agents)', custom: 'Custom',
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Expands explicit environment references only; it never invokes a shell. */
export function expandAgentPath(value: string, home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (!value || /[\0-\x1f\x7f]/u.test(value)) throw new Error('Agent paths must be nonempty and contain no control characters');
  let expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/gu,
    (_match, a: string | undefined, b: string | undefined, c: string | undefined) => {
      const key = a ?? b ?? c ?? '';
      const resolved = env[key];
      if (!resolved || /[\0-\x1f\x7f]/u.test(resolved)) throw new Error(`Missing or invalid path environment variable: ${key}`);
      return resolved;
    });
  if (expanded === '~') expanded = home;
  else if (/^~[/\\]/u.test(expanded)) expanded = (platform === 'win32' ? path.win32 : path.posix).join(home, expanded.slice(2));
  else if (expanded.startsWith('~')) throw new Error('Named-user tilde paths are not supported');
  return expanded;
}

function absolutePath(value: string, platform: NodeJS.Platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!p.isAbsolute(value) || (platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u.test(value))) {
    throw new Error('Agent home, project and target paths must be absolute');
  }
  if (platform === 'win32') {
    if (/^\\\\[?.]\\/u.test(value)) throw new Error('Windows device paths are not supported');
    const rest = value.slice(p.parse(value).root.length);
    for (const segment of rest.split(/[\\/]/u)) {
      if (segment === '.' || segment === '..' || !segment) continue;
      if (/[<>:"|?*]/u.test(segment) || /[ .]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) {
        throw new Error('Ambiguous or reserved Windows path component');
      }
    }
  }
  return p.normalize(value);
}

/** Resolve every existing ancestor, without creating a directory or following a dangling link. */
export async function canonicalAgentPath(value: string, platform: NodeJS.Platform = process.platform): Promise<string> {
  const normalized = absolutePath(value, platform);
  // Cross-platform fixtures are lexical only. Never stat a Windows path as a POSIX relative path.
  if (platform !== process.platform && (platform === 'win32' || process.platform === 'win32')) return normalized;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const missing: string[] = [];
  let current = normalized;
  for (;;) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error('Agent path conflicts with an existing non-directory');
      const canonical = await realpath(current); // A dangling link fails closed.
      const resolvedInfo = await lstat(canonical);
      if (!resolvedInfo.isDirectory()) throw new Error('Agent path resolves to an existing non-directory');
      return p.join(canonical, ...missing.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      // ENOENT from realpath must not make a dangling link look like a missing directory.
      try {
        const existing = await lstat(current);
        if (existing.isSymbolicLink()) throw new Error('Agent path contains a dangling symbolic link');
      } catch (probeError) {
        if (!isMissing(probeError)) throw probeError;
      }
      const parent = p.dirname(current);
      if (parent === current) throw new Error('Cannot resolve the filesystem root of the Agent path');
      missing.push(p.basename(current));
      current = parent;
    }
  }
}

async function existsDirectory(value: string, platform: NodeJS.Platform): Promise<boolean> {
  if (platform !== process.platform && (platform === 'win32' || process.platform === 'win32')) return false;
  try { return (await lstat(await realpath(value))).isDirectory(); }
  catch (error) { if (isMissing(error)) return false; throw error; }
}

export async function resolveAgentTarget(agent: AgentId, options: AgentOptions = {}): Promise<AgentTarget> {
  if (!Object.hasOwn(LABELS, agent)) throw new Error('Unknown Agent adapter');
  if (options.mode !== undefined && !['auto', 'link', 'copy'].includes(options.mode)) throw new Error('Unknown Agent projection mode');
  if (options.label !== undefined && (!options.label.trim() || options.label.length > 160 || /[\u0000-\u001f\u007f]/u.test(options.label))) throw new Error('Invalid Agent target label');
  const platform = options.platform ?? process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const env = options.env ?? process.env;
  const home = await canonicalAgentPath(options.home ?? (platform === 'win32' ? env.USERPROFILE ?? homedir() : env.HOME ?? homedir()), platform);
  const expand = (value: string): string => absolutePath(expandAgentPath(value, home, env, platform), platform);
  const project = options.project === undefined ? undefined : await canonicalAgentPath(expand(options.project), platform);
  const scope = project ?? 'global';
  const root = project ?? home;
  const envRoot = (key: string, fallback: string, compatibility = false): string => {
    if (!env[key]) return fallback;
    try { return expand(env[key]!); }
    catch (error) { if (compatibility || options.path) return fallback; throw error; }
  };
  const claude = project || agent !== 'claude-code' ? p.join(root, '.claude', 'skills') : p.join(envRoot('CLAUDE_CONFIG_DIR', p.join(home, '.claude')), 'skills');
  const universal = p.join(root, '.agents', 'skills');
  const dshAgents = project ? universal : p.join(envRoot('DSH_AGENTS_HOME', p.join(home, '.agents'), true), 'skills');
  let native: string;
  let compatibility: string[] = [];
  switch (agent) {
    case 'claude-code': native = claude; break;
    case 'codex':
      native = universal;
      compatibility = [project ? p.join(project, '.codex', 'skills') : p.join(envRoot('CODEX_HOME', p.join(home, '.codex')), 'skills')];
      break;
    case 'opencode':
      native = project ? p.join(project, '.opencode', 'skills') : p.join(env.OPENCODE_CONFIG_DIR
        ? envRoot('OPENCODE_CONFIG_DIR', p.join(home, '.config', 'opencode'))
        : p.join(envRoot('XDG_CONFIG_HOME', p.join(home, '.config')), 'opencode'), 'skills');
      compatibility = [claude, universal];
      break;
    case 'dsh':
      native = project ? p.join(project, '.dsh', 'skills') : p.join(envRoot('DSH_HOME', p.join(home, '.dsh')), 'skills');
      compatibility = [dshAgents];
      break;
    case 'cursor': native = p.join(root, '.cursor', 'skills'); compatibility = [claude, universal, p.join(root, '.codex', 'skills')]; break;
    case 'hermes': native = project ? p.join(project, '.hermes', 'skills') : p.join(envRoot('HERMES_HOME', p.join(home, '.hermes')), 'skills'); break;
    case 'universal': native = universal; break;
    case 'custom':
      if (!options.path) throw new Error('Custom Agent targets require an explicit absolute skills directory');
      native = expand(options.path);
      break;
  }
  const targetPath = await canonicalAgentPath(options.path ? expand(options.path) : native, platform);
  const scanRoots: string[] = [];
  // Preserve the native root as a hint for explicit secondary instances; no implicit write occurs.
  for (const candidate of [targetPath, ...(options.path ? [native] : []), ...compatibility]) {
    const canonical = await canonicalAgentPath(candidate, platform);
    const key = platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (!scanRoots.some((item) => (platform === 'win32' ? item.toLowerCase() : item) === key)) scanRoots.push(canonical);
  }
  const identity = [agent, scope, targetPath].map((item) => platform === 'win32' ? item.toLowerCase() : item).join('\0');
  return {
    id: `${agent}-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`,
    agent, label: options.label ?? LABELS[agent], scope, path: targetPath, mode: options.mode ?? 'auto', scanRoots,
    // Directory existence is only a suggestion; it cannot prove native loading/trust.
    discovery: 'unverified',
  };
}

export async function detectAgents(options: Pick<AgentOptions, 'home' | 'env' | 'platform'> = {}): Promise<AgentTarget[]> {
  const detected: AgentTarget[] = [];
  const platform = options.platform ?? process.platform;
  for (const agent of AGENTS) {
    try {
      const target = await resolveAgentTarget(agent, options);
      const p = platform === 'win32' ? path.win32 : path.posix;
      // A native config directory is a suggestion, not proof that a binary or skill loader exists.
      if (await existsDirectory(target.path, platform) || await existsDirectory(p.dirname(target.path), platform)) detected.push(target);
    } catch {
      // Broken/unreadable roots are not safe detection candidates. Explicit resolve reports errors.
    }
  }
  return detected;
}

export function agentHints(target: AgentTarget): string[] {
  const hints = [
    `Canonical skills directory: ${target.path}`,
    'Detection checks local directories only; verify native skill discovery in the Agent itself. No Agent configuration is created or rewritten.',
    target.scope === 'global' ? 'Global user scope; other OS users and remote Agents are separate targets.' : `Project scope: ${target.scope}. Native loaders may walk ancestor directories and require project trust.`,
  ];
  if (target.discovery === 'unverified') hints.push('Native loading is not verified on this host, even if the directory exists. Enabling a target requires explicit user action; detection never creates it.');
  if (target.scanRoots.length > 1) hints.push(`Native/compatibility scan roots (version-dependent, not additional install destinations): ${target.scanRoots.join(', ')}. Overlapping roots can expose the same skill twice; choose one physical destination.`);
  if (target.agent === 'codex') hints.push('Current Codex user/project skills live in ~/.agents/skills and <project>/.agents/skills; .codex/skills is a legacy compatibility location, not the primary target.');
  if (target.agent === 'dsh') hints.push('An explicit skills path wins over DSH_HOME/skills, then ~/.dsh/skills. DSH also scans DSH_AGENTS_HOME/skills (default ~/.agents/skills); confirm the actual instance home rather than guessing from the executable checkout.');
  if (target.agent === 'opencode') hints.push('Global OpenCode uses OPENCODE_CONFIG_DIR or XDG_CONFIG_HOME/opencode (default ~/.config/opencode); Claude and .agents compatibility scanning depends on native version/settings.');
  if (target.agent === 'cursor') hints.push('Cursor uses .cursor/skills and may also discover .claude/.agents/.codex compatibility roots. Check the installed Cursor version and restart/reload its Agent view.');
  if (target.agent === 'hermes') hints.push(target.scope === 'global' ? 'Hermes respects HERMES_HOME; restart/reload native skill discovery after changes.' : 'Hermes project skills require explicit project trust in Hermes; SkillShelf never grants trust or edits Hermes configuration.');
  if (target.agent === 'custom' || target.agent === 'universal') hints.push('This is a filesystem projection, not a guarantee that a particular Agent loads this directory. Configure native discovery yourself if needed.');
  hints.push('Windows path normalization is unit-testable; ACLs, native loading and symlink privileges require separate testing on a real Windows host.');
  return hints;
}
