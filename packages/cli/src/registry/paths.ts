// Pure archive path, root, and mapping-boundary policy for the GitHub
// fixed-commit acquisition adapter. Every helper validates decoded strings
// before any tar-library normalization and never performs I/O. The only
// consumer is the scanner inside `registry/github.ts`.

const MAX_TOTAL_SEGMENTS = 17; // archive root segment + up to 16 manifest segments
const MAX_SEGMENT_BYTES = 240;
const MAX_PATH_BYTES = 1024;
const RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;

function fail(reason: string): never {
  throw new Error(`Archive path policy rejected: ${reason}`);
}

/** Same folding as the schema-3 manifest identity: NFC -> NFKC -> en-US lowercase. */
export function foldPathKey(value: string): string {
  return value.normalize('NFC').normalize('NFKC').toLocaleLowerCase('en-US');
}

function validateSegment(segment: string): void {
  if (!segment || segment === '.' || segment === '..') fail('empty, dot, or dot-dot segment');
  if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) fail('segment exceeds 240 bytes');
  if (/[. ]$|^ /u.test(segment)) fail('leading space or trailing dot/space in segment');
  // A segment must not normalize into multiple path components (fullwidth
  // solidus, backslash look-alikes, or other NFKC separator aliases).
  const folded = segment.normalize('NFKC');
  if (folded.includes('/') || folded.includes('\\')) fail('Unicode alias for a path separator');
  if (foldPathKey(segment) === '.git') fail('.git segment');
  if (RESERVED_SEGMENT.test(foldPathKey(segment))) fail('platform-reserved segment');
}

/**
 * Validates one decoded full archive path (including the archive root
 * segment). Returns the input unchanged; throws on any unsafe spelling.
 */
export function validateArchivePath(value: string): string {
  if (typeof value !== 'string' || !value) fail('empty path');
  if (Buffer.byteLength(value) > MAX_PATH_BYTES) fail('path exceeds 1024 bytes');
  if (value !== value.normalize('NFC')) fail('non-NFC Unicode spelling');
  if (CONTROL.test(value) || /[\\<>:"|?*]/u.test(value)) fail('control or forbidden character');
  const parts = value.split('/');
  if (parts.length > MAX_TOTAL_SEGMENTS) fail('path exceeds the segment depth limit');
  for (const part of parts) validateSegment(part);
  return value;
}

/**
 * Lexically validates a symbolic link target of an unselected entry. The
 * target may contain `..` only while the resolved depth stays at or under
 * the link's own directory; it is never followed or materialized.
 */
export function validateLinkTarget(linkDirectory: string, target: string): string {
  if (typeof target !== 'string' || !target) fail('empty link target');
  if (target.startsWith('/') || target.includes('\\')) fail('absolute or backslash link target');
  if (target !== target.normalize('NFC') || CONTROL.test(target) || /[<>:"|?*]/u.test(target)) {
    fail('unsafe link target');
  }
  const folded = target.normalize('NFKC');
  if ((folded.includes('/') && !target.includes('/')) || folded.includes('\\')) {
    fail('Unicode alias in link target');
  }
  let depth = linkDirectory ? linkDirectory.split('/').length : 0;
  for (const segment of target.split('/')) {
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) fail('link target escapes the archive root');
      continue;
    }
    if (segment === '.') fail('dot segment in link target');
    validateSegment(segment);
    depth += 1;
  }
  return target;
}

/** Exact path-boundary containment; never a raw `startsWith` prefix match. */
export function pathWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export type ArchiveEntryKind = 'file' | 'directory';

/**
 * Incremental archive tree: establishes exactly one root segment, enforces
 * spelling consistency, and rejects duplicate, case/Unicode-colliding, or
 * file/directory-colliding entries across the whole archive (selected or
 * not). Metadata (PAX) entries are never added here.
 */
export class ArchiveTree {
  private rootSegment: string | null = null;
  private readonly spellings = new Map<string, string>();
  private readonly files = new Set<string>();
  private readonly dirs = new Set<string>();
  private readonly fileAncestors = new Set<string>();

  add(fullPath: string, kind: ArchiveEntryKind): void {
    const parts = fullPath.split('/');
    const root = parts[0] ?? '';
    if (!root) fail('archive entry outside the root segment');
    if (this.rootSegment === null) {
      if (parts.length === 1 && kind === 'file') fail('archive root declared as a regular file');
      this.rootSegment = root;
    } else if (this.rootSegment !== root) {
      fail('archive contains multiple roots');
    }
    const folded = foldPathKey(fullPath);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const prefix = parts.slice(0, depth).join('/');
      const key = foldPathKey(prefix);
      const seen = this.spellings.get(key);
      if (seen === undefined) this.spellings.set(key, prefix);
      else if (seen !== prefix) fail('case or Unicode collision in directory spelling');
    }
    if (this.files.has(folded) || this.dirs.has(folded)) fail('duplicate or case-colliding archive entry');
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (this.files.has(foldPathKey(parts.slice(0, depth).join('/')))) fail('file/directory collision');
    }
    if (kind === 'file') {
      if (this.fileAncestors.has(folded)) fail('file/directory collision');
      for (let depth = 1; depth < parts.length; depth += 1) this.fileAncestors.add(foldPathKey(parts.slice(0, depth).join('/')));
      this.files.add(folded);
    } else {
      this.dirs.add(folded);
    }
  }

  get root(): string {
    if (this.rootSegment === null) fail('archive root missing');
    return this.rootSegment;
  }

  get established(): boolean {
    return this.rootSegment !== null;
  }
}
