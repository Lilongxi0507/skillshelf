export interface FileEntry { path: string; size: number; sha256: string; executable: boolean }
export interface RuntimeDeclaration { kind: 'instructions' | 'python' | 'node'; entrypoint?: string; minimumVersion?: string; requiresNetwork: boolean; providers?: Array<'search' | 'image' | 'video'>; dependencies?: string[] }

/** A selected source file in the schema-3 manifest. Git modes are deliberately narrow. */
export interface SourceFileEntry { path: string; size: number; sha256: string; mode: 100644 | 100755; origin?: 'upstream' | 'authored' | 'license' }
export interface SourceMapping { sourcePath: string; destinationPath: string; repository?: string; commit?: string }
export interface SourceOverlay {
  origin: 'upstream' | 'authored' | 'license';
  repository: string;
  commit: string;
  sourcePath: string;
  destinationPath: string;
  sha256: string;
  size: number;
  mode: 100644 | 100755;
}
export interface GithubAcquisition {
  kind: 'github';
  repository: string;
  commit: string;
  mappings: SourceMapping[];
  overlays?: SourceOverlay[];
  manifestDigest?: string;
  receiptPolicy?: 'required' | 'optional';
}
export interface NpmAcquisition { kind: 'npm'; packageName: string; version: string; integrity: string }
export interface LocalAcquisition { kind: 'local'; purpose: 'fixture' | 'import'; path?: string }
export type Acquisition = GithubAcquisition | NpmAcquisition | LocalAcquisition;
export interface SourceProvenance {
  upstream?: string;
  repository?: string;
  commit?: string;
  path?: string;
  authors?: string[];
  license?: string;
  notice?: string;
  modified?: boolean;
  notes?: string;
}
export interface SourceMember { id: string; name?: string; path: string; files?: string[]; runtime?: RuntimeDeclaration }
export interface SourceLayout { memberId: string; path: string }
export interface ArchiveReceipt { compressedSha512: string; compressedBytes: number }
export interface ExecutionAuthorization {
  kind: 'first-party';
  issuer: string;
  tool?: string;
  skillId?: string;
  memberId?: string;
  repository: string;
  commit: string;
  mappingDigest?: string;
  treeDigest: string;
  releaseDigest: string;
  entrypoint: string;
  runtime?: RuntimeDeclaration;
  minimumVersion?: string;
  dependencies?: string[];
  providers?: Array<'search' | 'image' | 'video'>;
  requiresNetwork?: boolean;
}
export interface SourceManifest {
  schemaVersion: 3;
  id: string;
  name: string;
  packRevision: number;
  acquisition: Acquisition;
  provenance: SourceProvenance;
  files: SourceFileEntry[];
  treeDigest: string;
  releaseDigest: string;
  runtime: RuntimeDeclaration;
  members?: SourceMember[];
  layout?: SourceLayout[];
  archiveReceipt?: ArchiveReceipt;
  authorization?: ExecutionAuthorization;
}
export interface PackMember { id: string; name: string; path: string; legacyId: string; title: string; description: string; useWhen: string; examples: string[]; category: string; subcategory: string; tags: string[]; purpose: string; stack: string[]; dependencies: string[]; license: string; source: SkillSource; runtime: RuntimeDeclaration }
export interface SkillManifest { schemaVersion: 1 | 2; id: string; name: string; files: FileEntry[]; contentDigest: string; runtime: RuntimeDeclaration; members?: PackMember[] }
export interface PackExposure { all: boolean; enabled: string[]; disabled: string[] }
export interface SkillSource {
  repository?: string;
  commit?: string;
  path?: string;
  panelRevision?: string;
  url?: string;
  /** v0.3 acquisition/provenance identity; absent on legacy schema 1/2 entries. */
  acquisition?: Acquisition;
  provenance?: SourceProvenance;
  sourceManifest?: SourceManifest;
}
export interface CatalogEntry {
  id: string; name: string; title: string; description: string; useWhen: string; examples: string[];
  category: string; tags: string[]; collection: string; license: string; source: SkillSource;
  status: 'recommended' | 'stable' | 'legacy' | 'experimental'; runtime: RuntimeDeclaration;
  packageName: string; version: string; integrity: string; contentDigest: string; fileCount: number; unpackedSize: number;
  localArtifact?: string;
  /** v0.3 catalog identity; omitted by legacy npm catalog entries. */
  acquisition?: Acquisition;
  sourceManifest?: SourceManifest;
  packRevision?: number;
  kind?: 'pack'; members?: PackMember[]; matchedMembers?: Array<{ id: string; reasons: string[] }>;
}
export interface Catalog {
  schemaVersion: 1 | 2 | 3; catalogVersion: string; minCliVersion: string; scope: string;
  catalogRevision?: string;
  categories: Array<{ id: string; title: string; children?: Array<{ id: string; title: string }> }>;
  collections: Array<{ id: string; title: string; description: string; skills: string[] }>;
  skills: CatalogEntry[];
}
export type AgentId = 'claude-code' | 'codex' | 'opencode' | 'dsh' | 'cursor' | 'hermes' | 'universal' | 'custom';
export interface AgentTarget { id: string; agent: AgentId; label: string; scope: string; path: string; mode: 'auto' | 'link' | 'copy'; scanRoots: string[]; discovery: 'unverified' | 'verified'; }
export interface Release {
  key: string;
  id: string;
  name: string;
  version: string;
  packageName: string;
  integrity: string;
  contentDigest: string;
  manifest: SkillManifest;
  source: SkillSource;
  installedAt: string;
  origin: 'npm' | 'local' | 'panel' | 'github';
  catalogEntry?: CatalogEntry;
  /** v0.3 identity fields; absent on legacy releases. */
  acquisition?: Acquisition;
  sourceManifest?: SourceManifest;
  packRevision?: number;
}
export interface Selection { releaseKey: string; pinned: boolean; history: string[]; }
export interface Projection { key: string; path: string; releaseKey: string; mode: 'link' | 'copy'; targetIds: string[]; memberId?: string; memberPath?: string; }
export interface ProjectRecord { root: string; specPath: string; lockPath: string; selections: Record<string, Selection>; specHash?: string; lockHash?: string; }
export interface State {
  schemaVersion: 1 | 2; generation: number; lastTransactionId: string | null;
  releases: Record<string, Release>; selections: Record<string, Selection>; targets: Record<string, AgentTarget>;
  projections: Record<string, Projection>; projects: Record<string, ProjectRecord>;
  exposures?: Record<string, Record<string, PackExposure>>;
  preferences?: Record<string, { favorite?: boolean; tags?: string[]; category?: string; subcategory?: string }>;
}
export interface ProjectSpec { schemaVersion: 1 | 2; skills: Record<string, { version?: string; pinned?: boolean }>; agents: Array<{ agent: AgentId; relativePath?: string; mode?: 'auto' | 'link' | 'copy'; skills?: string[]; exposures?: Record<string, PackExposure> }> }
export interface ProjectLock { schemaVersion: 1 | 2; catalogVersion: string; skills: Array<{ id: string; name: string; packageName: string; version: string; integrity: string; contentDigest: string; entry?: CatalogEntry; manifest?: SkillManifest; source?: SkillSource; origin?: Release['origin'] }>; agents: ProjectSpec['agents']; }
export interface Context { home: string; offline: boolean; catalogPath?: string; json?: boolean; }
export interface MutationOptions { dryRun?: boolean; yes?: boolean; project?: string; agents?: string[]; mode?: 'auto' | 'link' | 'copy'; }
export interface OperationResult { [key: string]: unknown }
