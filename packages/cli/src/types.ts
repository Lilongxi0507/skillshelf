export interface FileEntry { path: string; size: number; sha256: string; executable: boolean }
export interface RuntimeDeclaration { kind: 'instructions' | 'python' | 'node'; entrypoint?: string; minimumVersion?: string; requiresNetwork: boolean; providers?: Array<'search' | 'image' | 'video'>; dependencies?: string[] }
export interface SkillManifest { schemaVersion: 1; id: string; name: string; files: FileEntry[]; contentDigest: string; runtime: RuntimeDeclaration }
export interface SkillSource { repository?: string; commit?: string; path?: string; panelRevision?: string; url?: string }
export interface CatalogEntry {
  id: string; name: string; title: string; description: string; useWhen: string; examples: string[];
  category: string; tags: string[]; collection: string; license: string; source: SkillSource;
  status: 'recommended' | 'stable' | 'legacy' | 'experimental'; runtime: RuntimeDeclaration;
  packageName: string; version: string; integrity: string; contentDigest: string; fileCount: number; unpackedSize: number;
  localArtifact?: string;
}
export interface Catalog {
  schemaVersion: 1; catalogVersion: string; minCliVersion: string; scope: string;
  categories: Array<{ id: string; title: string }>;
  collections: Array<{ id: string; title: string; description: string; skills: string[] }>;
  skills: CatalogEntry[];
}
export type AgentId = 'claude-code' | 'codex' | 'opencode' | 'dsh' | 'cursor' | 'hermes' | 'universal' | 'custom';
export interface AgentTarget { id: string; agent: AgentId; label: string; scope: string; path: string; mode: 'auto' | 'link' | 'copy'; scanRoots: string[]; discovery: 'unverified' | 'verified'; }
export interface Release { key: string; id: string; name: string; version: string; packageName: string; integrity: string; contentDigest: string; manifest: SkillManifest; source: SkillSource; installedAt: string; origin: 'npm' | 'local' | 'panel'; catalogEntry?: CatalogEntry; }
export interface Selection { releaseKey: string; pinned: boolean; history: string[]; }
export interface Projection { key: string; path: string; releaseKey: string; mode: 'link' | 'copy'; targetIds: string[]; }
export interface ProjectRecord { root: string; specPath: string; lockPath: string; selections: Record<string, Selection>; specHash?: string; lockHash?: string; }
export interface State {
  schemaVersion: 1; generation: number; lastTransactionId: string | null;
  releases: Record<string, Release>; selections: Record<string, Selection>; targets: Record<string, AgentTarget>;
  projections: Record<string, Projection>; projects: Record<string, ProjectRecord>;
}
export interface ProjectSpec { schemaVersion: 1; skills: Record<string, { version?: string; pinned?: boolean }>; agents: Array<{ agent: AgentId; relativePath?: string; mode?: 'auto' | 'link' | 'copy'; skills?: string[] }> }
export interface ProjectLock { schemaVersion: 1; catalogVersion: string; skills: Array<{ id: string; name: string; packageName: string; version: string; integrity: string; contentDigest: string; entry?: CatalogEntry }>; agents: ProjectSpec['agents']; }
export interface Context { home: string; offline: boolean; catalogPath?: string; json?: boolean; }
export interface MutationOptions { dryRun?: boolean; yes?: boolean; project?: string; agents?: string[]; mode?: 'auto' | 'link' | 'copy'; }
export interface OperationResult { [key: string]: unknown }
