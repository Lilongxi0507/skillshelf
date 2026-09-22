import path from 'node:path';
import type { AgentId, AgentTarget, Context } from '../types.js';
import { fail } from '../errors.js';
import { canonicalAgentPath, resolveAgentTarget } from './agents.js';

export interface HomeLocationOptions {
  /** OS user home, never the SkillShelf data home; injectable for isolated fixtures. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Include explicit projects even when no Agent target has been registered yet. */
  projects?: readonly string[];
}
const NATIVE_AGENTS: readonly AgentId[] = ['claude-code', 'codex', 'opencode', 'dsh', 'cursor', 'hermes', 'universal'];
const ROOT_VARIABLES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'HERMES_HOME'] as const;

function overlaps(left: string, right: string, platform: NodeJS.Platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const a = platform === 'win32' ? left.toLowerCase() : left;
  const b = platform === 'win32' ? right.toLowerCase() : right;
  const contains = (parent: string, child: string): boolean => {
    const relative = p.relative(parent, child);
    return relative === '' || relative !== '..' && !relative.startsWith('..' + p.sep) && !p.isAbsolute(relative);
  };
  return contains(a, b) || contains(b, a);
}

/**
 * Read-only, cycle-free preflight. Must be called before creating a home or registering a target.
 * Pass the complete registered targets plus any proposed targets; this module never reads state,
 * creates directories, changes ACLs, invokes an Agent, or assumes that an absent root is safe.
 */
export async function validateHomeLocation(ctx: Pick<Context, 'home'>, targets: readonly AgentTarget[] = [], options: HomeLocationOptions = {}): Promise<void> {
  if (!Array.isArray(targets) || targets.length > 10_000 || (options.projects?.length ?? 0) > 1000) fail('USAGE', 'Too many Agent targets or project roots for storage validation');
  const platform = options.platform ?? process.platform;
  const home = await canonicalAgentPath(ctx.home, platform);
  const env = options.env ?? process.env;
  // Active instance overrides do not turn common compatibility/default locations into data roots.
  const fallback: NodeJS.ProcessEnv = { ...env };
  for (const variable of ROOT_VARIABLES) delete fallback[variable];
  const roots = new Set<string>();
  const projects = new Set<string>(options.projects ?? []);
  const add = async (candidate: string): Promise<void> => {
    const canonical = await canonicalAgentPath(candidate, platform);
    roots.add(platform === 'win32' ? canonical.toLowerCase() : canonical);
  };
  for (const target of targets) {
    if (!target || typeof target.path !== 'string' || !Array.isArray(target.scanRoots) || target.scanRoots.length > 32 || typeof target.scope !== 'string') fail('INTEGRITY', 'Invalid Agent target in storage-boundary preflight');
    await add(target.path); // Do not rely on scanRoots containing the actual target.
    for (const root of target.scanRoots) { if (typeof root !== 'string') fail('INTEGRITY', 'Invalid Agent scan root'); await add(root); }
    if (target.scope !== 'global') projects.add(await canonicalAgentPath(target.scope, platform));
  }
  const scopes: Array<string | undefined> = [undefined, ...projects];
  if (scopes.length > 1001) fail('USAGE', 'Too many distinct projects for storage validation');
  for (const project of scopes) {
    for (const agent of NATIVE_AGENTS) {
      for (const environment of project ? [env] : [env, fallback]) {
        // Never use detectAgents here: detection omits absent roots that still must be protected.
        const target = await resolveAgentTarget(agent, { home: options.home, project, env: environment, platform });
        for (const root of [target.path, ...target.scanRoots]) await add(root);
      }
    }
  }
  for (const root of roots) {
    if (overlaps(home, root, platform)) fail('CONFLICT', 'SkillShelf data home and Agent skill scan roots must be disjoint; choose a separate private data directory', { home, scanRoot: root });
  }
}
