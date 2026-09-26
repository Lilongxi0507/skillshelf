// GitHub fixed-commit acquisition adapter. This module is the only place that
// knows how codeload archives are fetched, bounded, scanned, and mapped; the
// result is a fully verified selected tree plus a transport receipt. It never
// writes SkillShelf state, the store, or Agent projections, and `origin:
// github` by itself never grants execution authority.

import { createHash } from 'node:crypto';
import { createGunzip, crc32 } from 'node:zlib';
import type { ArchiveReceipt, ExecutionAuthorization, GithubAcquisition, SourceFileEntry, SourceManifest, SourceMapping, SourceOverlay } from '../types.js';
import { validateSourceManifest } from './manifest.js';
import { ArchiveTree, pathWithin, validateArchivePath, validateLinkTarget } from './paths.js';

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

export interface GithubLimits {
  compressedBytes: number;
  expandedBytes: number;
  entries: number;
  selectedFiles: number;
  selectedFileBytes: number;
  selectedBytes: number;
  requestMs: number;
  idleMs: number;
}

const DEFAULT_LIMITS: GithubLimits = Object.freeze({
  compressedBytes: 128 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  entries: 100_000,
  selectedFiles: 2_000,
  selectedFileBytes: 16 * 1024 * 1024,
  selectedBytes: 64 * 1024 * 1024,
  requestMs: 180_000,
  idleMs: 30_000,
});

const MAX_PAX_BYTES = 65_536;
const PAX_ALLOWED_KEYS = new Set(['mtime', 'atime', 'ctime', 'comment', 'uname', 'gname', 'uid', 'gid', 'charset']);

export interface GithubCacheStaging {
  write(chunk: Uint8Array): Promise<void> | void;
  seal(): Promise<void> | void;
  publish(receipt: ArchiveReceipt): Promise<void> | void;
  abort(): Promise<void> | void;
}

export interface GithubCache {
  open(key: string): Promise<{ receipt: ArchiveReceipt; body: ReadableStream<Uint8Array> } | undefined>;
  discard(key: string): Promise<void> | void;
  stage(key: string): Promise<GithubCacheStaging>;
}

export interface GithubFetchResponse {
  status: number;
  redirected?: boolean;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export type GithubFetch = (address: string, options: {
  redirect: 'error';
  credentials: 'omit';
  signal: AbortSignal;
  headers: Record<string, string>;
}) => Promise<GithubFetchResponse>;

export interface GithubAcquisitionDeps {
  fetch: GithubFetch;
  cache: GithubCache;
  limits?: Partial<GithubLimits>;
  offline?: boolean;
}

export interface GithubAcquiredFile extends SourceFileEntry {
  data: Buffer;
}

export interface GithubAcquisitionResult {
  repository: string;
  commit: string;
  root: string;
  files: GithubAcquiredFile[];
  archiveReceipt: ArchiveReceipt;
  treeDigest: string;
  releaseDigest: string;
  authorization?: ExecutionAuthorization;
}

export class AcquisitionError extends Error {
  readonly code: string;
  readonly retryAfter?: string;

  constructor(code: string, message: string, retryAfter?: string) {
    super(message);
    this.name = 'AcquisitionError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function archiveFail(message: string): never {
  throw new AcquisitionError('ARCHIVE', `Archive rejected: ${message}`);
}

function limitFail(message: string): never {
  throw new AcquisitionError('ARCHIVE', `Archive ${message}`);
}

// ---------------------------------------------------------------------------
// URL construction (only from validated repository/commit fields)
// ---------------------------------------------------------------------------

function codeloadUrl(repository: string, commit: string): string {
  // `repository` matches /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ and `commit` is a
  // lower-case 40-character SHA at this point (enforced by validateSourceManifest).
  return `https://codeload.github.com/${repository}/tar.gz/${commit}`;
}

// ---------------------------------------------------------------------------
// Tuple planning: one verified acquisition per distinct repository@commit
// ---------------------------------------------------------------------------

interface TupleScanPlan {
  key: string;
  repository: string;
  commit: string;
  expected: Map<string, SourceFileEntry>;
  mappingRoots: string[];
}

function tupleKey(repository: string, commit: string): string {
  return `${repository}@${commit}`;
}

function planTupleScans(validated: SourceManifest): TupleScanPlan[] {
  const acquisition = validated.acquisition as GithubAcquisition;
  const plans = new Map<string, TupleScanPlan>();
  const planFor = (repository: string, commit: string): TupleScanPlan => {
    const key = tupleKey(repository, commit);
    let plan = plans.get(key);
    if (!plan) {
      plan = { key, repository, commit, expected: new Map(), mappingRoots: [] };
      plans.set(key, plan);
    }
    return plan;
  };
  const primary = planFor(acquisition.repository, acquisition.commit);
  primary.mappingRoots = acquisition.mappings.map((mapping) => mapping.sourcePath);
  const overlays = acquisition.overlays ?? [];
  const overlayByDestination = new Map<string, SourceOverlay>(overlays.map((overlay) => [overlay.destinationPath, overlay]));
  for (const file of validated.files) {
    const overlay = overlayByDestination.get(file.path);
    if (overlay) {
      planFor(overlay.repository, overlay.commit).expected.set(overlay.sourcePath, file);
      continue;
    }
    const owner = acquisition.mappings.find((mapping) => pathWithin(file.path, mapping.destinationPath));
    if (!owner) archiveFail('selected file has no unique mapping ownership');
    primary.expected.set(mappingSource(owner, file.path), file);
  }
  return [...plans.values()];
}

function mappingSource(mapping: SourceMapping, destinationPath: string): string {
  return `${mapping.sourcePath}${destinationPath.slice(mapping.destinationPath.length)}`;
}

// ---------------------------------------------------------------------------
// Raw tar header parsing (before any library normalization)
// ---------------------------------------------------------------------------

const DECODER = new TextDecoder('utf-8', { fatal: true });

interface RawHeader {
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'pax-local' | 'pax-global';
  size: number;
  rawMode: number;
  linkname: string;
}

function decodeField(block: Buffer, start: number, end: number, label: string): string {
  const field = block.subarray(start, end);
  const terminator = field.indexOf(0);
  if (terminator === -1) {
    // POSIX tar allows a name to fill the entire 100-byte field with no NUL
    // terminator (exactly-100-character paths). Any other field with no NUL
    // is malformed: mode/size/etc. always pad with NUL or space.
    if (start !== 0 || end !== 100) archiveFail(`${label} field is not NUL-terminated`);
  } else {
    for (let index = terminator; index < field.length; index += 1) {
      if (field[index] !== 0) archiveFail(`${label} field has nonzero bytes after its NUL terminator`);
    }
  }
  try {
    return DECODER.decode(field.subarray(0, terminator === -1 ? field.length : terminator));
  } catch {
    archiveFail(`${label} field is not valid UTF-8`);
  }
}

function octalField(block: Buffer, start: number, end: number, label: string): number {
  const field = block.subarray(start, end);
  if (field[0] !== undefined && (field[0] & 0x80) !== 0) archiveFail(`${label} field uses an unsupported binary encoding`);
  let value = 0;
  let seen = false;
  for (const byte of field) {
    if (byte === 0x00 || byte === 0x20) continue;
    if (byte < 0x30 || byte > 0x37) archiveFail(`${label} field is not clean octal`);
    value = value * 8 + (byte - 0x30);
    seen = true;
  }
  if (!Number.isSafeInteger(value)) archiveFail(`${label} field overflows`);
  return seen ? value : 0;
}

function parseTarHeader(block: Buffer): RawHeader {
  const field = block.subarray(148, 156);
  const stored = (() => {
    let textOut = '';
    for (const byte of field) {
      if (byte === 0x00 || byte === 0x20) continue;
      if (byte < 0x30 || byte > 0x37) archiveFail('header checksum field is not clean octal');
      textOut += String.fromCharCode(byte);
    }
    return textOut ? Number.parseInt(textOut, 8) : NaN;
  })();
  if (!Number.isFinite(stored)) archiveFail('header checksum is missing');
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < 512; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : block[index]!;
    unsigned += byte;
    signed += byte < 0x80 ? byte : byte - 256;
  }
  if (stored !== unsigned && stored !== signed) archiveFail('header checksum mismatch');

  const name = decodeField(block, 0, 100, 'name');
  const prefix = decodeField(block, 345, 500, 'prefix');
  let path = prefix ? `${prefix}/${name}` : name;
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (!path) archiveFail('entry has an empty name');

  const magic = DECODER.decode(block.subarray(257, 263));
  const version = DECODER.decode(block.subarray(263, 265));
  const posixUstar = magic === 'ustar\0' && version === '00';
  const gnuUstar = magic === 'ustar ' && version === ' \0';
  if (!posixUstar && !gnuUstar) archiveFail('unsupported tar format magic/version');

  const typeByte = String.fromCharCode(block[156]!);
  const rawMode = octalField(block, 100, 108, 'mode');
  const size = octalField(block, 124, 136, 'size');
  const linkname = decodeField(block, 157, 257, 'linkname');
  switch (typeByte) {
    case '0':
    case '\0':
      return { path, type: 'file', size, rawMode, linkname };
    case '5':
      return { path, type: 'directory', size, rawMode, linkname };
    case '2':
      return { path, type: 'symlink', size, rawMode, linkname };
    case 'x':
      return { path, type: 'pax-local', size, rawMode, linkname };
    case 'g':
      return { path, type: 'pax-global', size, rawMode, linkname };
    default:
      archiveFail(`unsupported tar entry type '${typeByte}'`);
  }
}

function validateFileMode(rawMode: number): void {
  if ((rawMode & 0o7000) !== 0) archiveFail('special permission bits in entry mode');
  const typeBits = rawMode & 0o170000;
  if (typeBits !== 0 && typeBits !== 0o100000) archiveFail('unsupported entry mode');
}

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1\n';

function isLfsPointer(data: Buffer): boolean {
  return data.length >= LFS_POINTER_PREFIX.length && data.subarray(0, LFS_POINTER_PREFIX.length).toString('utf8') === LFS_POINTER_PREFIX;
}

// ---------------------------------------------------------------------------
// PAX record validation (explicit harmless allowlist only)
// ---------------------------------------------------------------------------

function validatePaxRecords(content: Buffer, label: string): void {
  if (content.length === 0) archiveFail(`${label} record is empty`);
  let offset = 0;
  const seenKeys = new Set<string>();
  while (offset < content.length) {
    let digits = '';
    let cursor = offset;
    while (cursor < content.length && content[cursor]! >= 0x30 && content[cursor]! <= 0x39 && digits.length < 20) {
      digits += String.fromCharCode(content[cursor]!);
      cursor += 1;
    }
    if (!digits || content[cursor] !== 0x20) archiveFail(`${label} record has a malformed length`);
    const declared = Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(declared) || declared < 2) archiveFail(`${label} record length is out of bounds`);
    if (declared > content.length - offset) archiveFail(`${label} record length exceeds the record data`);
    const end = offset + declared;
    if (content[end - 1] !== 0x0a) archiveFail(`${label} record is not newline-terminated`);
    const payloadEnd = end - 1;
    const keyStart = cursor + 1;
    const separator = content.indexOf(0x3d, keyStart);
    if (separator === -1 || separator >= payloadEnd) archiveFail(`${label} record has no key=value separator`);
    const key = DECODER.decode(content.subarray(keyStart, separator));
    if (!/^[\x21-\x7e]+$/u.test(key)) archiveFail(`${label} record key is not printable ASCII`);
    const valueBytes = content.subarray(separator + 1, payloadEnd);
    if (valueBytes.includes(0x00)) archiveFail(`${label} record value contains a NUL byte`);
    const value = DECODER.decode(valueBytes);
    if (!PAX_ALLOWED_KEYS.has(key)) archiveFail(`${label} record key is not allowed: ${key}`);
    if (seenKeys.has(key)) archiveFail(`${label} record repeats the key ${key}`);
    seenKeys.add(key);
    if (key === 'mtime' || key === 'atime' || key === 'ctime') {
      if (!/^-?\d+(?:\.\d+)?$/u.test(value)) archiveFail(`${label} record ${key} value is not numeric`);
    } else if (key === 'uid' || key === 'gid') {
      if (!/^\d+$/u.test(value)) archiveFail(`${label} record ${key} value is not a non-negative integer`);
    } else if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) {
      archiveFail(`${label} record ${key} value contains control characters`);
    }
    offset = end;
  }
}

// ---------------------------------------------------------------------------
// Incremental tar block scanner
// ---------------------------------------------------------------------------

interface ActiveBody {
  kind: 'file' | 'pax';
  repoPath: string;
  selected: SourceFileEntry | null;
  remaining: number;
  chunks: Buffer[];
  rawMode: number;
  label: string;
}

type ScanMode = 'header' | 'body' | 'pad' | 'term1' | 'tail';

class ArchiveScanner {
  private buffer: Buffer = Buffer.alloc(0);
  private mode: ScanMode = 'header';
  private entry: ActiveBody | null = null;
  private padRemaining = 0;
  private entryCount = 0;
  private pendingLocalPax = false;
  private readonly tree = new ArchiveTree();
  private selectedTotal = 0;
  readonly collected = new Map<string, { data: Buffer; mode: 100644 | 100755 }>();

  constructor(
    private readonly plan: TupleScanPlan,
    private readonly limits: GithubLimits,
  ) {}

  get root(): string {
    return this.tree.root;
  }

  feed(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.mode === 'tail') {
        for (const byte of this.buffer) {
          if (byte !== 0) archiveFail('nonzero bytes after the end-of-archive marker');
        }
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.mode === 'body') {
        const active = this.entry!;
        const take = Math.min(active.remaining, this.buffer.length);
        if (take > 0) {
          const slice = this.buffer.subarray(0, take);
          if (active.kind === 'pax' || (active.kind === 'file' && active.selected !== null)) active.chunks.push(Buffer.from(slice));
          active.remaining -= take;
          this.buffer = this.buffer.subarray(take);
        }
        if (active.remaining === 0) {
          this.finishBody();
        } else if (this.buffer.length === 0) {
          return;
        }
        continue;
      }
      if (this.mode === 'pad') {
        const take = Math.min(this.padRemaining, this.buffer.length);
        for (let index = 0; index < take; index += 1) {
          if (this.buffer[index] !== 0) archiveFail('nonzero padding after an entry body');
        }
        this.padRemaining -= take;
        this.buffer = this.buffer.subarray(take);
        if (this.padRemaining === 0) this.mode = 'header';
        else if (this.buffer.length === 0) return;
        continue;
      }
      if (this.buffer.length < 512) return;
      const block = this.buffer.subarray(0, 512);
      this.buffer = this.buffer.subarray(512);
      if (this.mode === 'term1') {
        if (block.every((byte) => byte === 0)) {
          this.mode = 'tail';
        } else {
          archiveFail('data blocks after the end-of-archive marker');
        }
        continue;
      }
      if (block.every((byte) => byte === 0)) {
        this.mode = 'term1';
        continue;
      }
      this.processHeader(block);
    }
  }

  private processHeader(block: Buffer): void {
    this.entryCount += 1;
    if (this.entryCount > this.limits.entries) limitFail(`entry limit exceeded (${this.limits.entries} entries)`);
    const header = parseTarHeader(block);
    if (header.type === 'pax-local' || header.type === 'pax-global') {
      if (this.pendingLocalPax) archiveFail('PAX record applied to another metadata entry');
      if (header.type === 'pax-local') this.pendingLocalPax = true;
      if (header.size > MAX_PAX_BYTES) limitFail(`PAX record exceeds the metadata limit (${MAX_PAX_BYTES} bytes)`);
      this.entry = { kind: 'pax', repoPath: '', selected: null, remaining: header.size, chunks: [], rawMode: 0, label: header.type === 'pax-global' ? 'global PAX' : 'local PAX' };
      this.beginBodyOrFinish();
      return;
    }
    this.pendingLocalPax = false;
    const fullPath = validateArchivePath(header.path);
    const isFile = header.type === 'file';
    if (isFile || header.type === 'directory') {
      if (header.linkname) archiveFail('link field set on a non-link entry');
    }
    this.tree.add(fullPath, isFile ? 'file' : 'directory');
    const root = this.tree.root;
    const repoPath = fullPath.length > root.length ? fullPath.slice(root.length + 1) : '';
    if (header.type === 'file') {
      validateFileMode(header.rawMode);
      const expected = this.plan.expected.get(repoPath);
      if (expected) {
        if (header.size !== expected.size) archiveFail(`selected file size mismatch for ${repoPath}`);
      } else if (this.plan.mappingRoots.some((mappingRoot) => pathWithin(repoPath, mappingRoot))) {
        archiveFail(`unexpected selected file inside a mapping root: ${repoPath}`);
      }
      if (expected && header.size > this.limits.selectedFileBytes) {
        limitFail(`selected file size limit exceeded (${this.limits.selectedFileBytes} bytes)`);
      }
      this.entry = { kind: 'file', repoPath, selected: expected ?? null, remaining: header.size, chunks: [], rawMode: header.rawMode, label: 'file' };
      this.beginBodyOrFinish();
      return;
    }
    if (header.type === 'directory') {
      if (header.size !== 0) archiveFail('directory entry declares a data body');
      return;
    }
    // Unselected symbolic link: validate raw encoding and lexical containment,
    // then discard it without following or materializing the target.
    if (header.size !== 0) archiveFail('symbolic link entry declares a data body');
    if (this.plan.mappingRoots.some((mappingRoot) => pathWithin(mappingRoot, repoPath) || pathWithin(repoPath, mappingRoot))) {
      archiveFail('symbolic link touches a selected mapping root');
    }
    if (this.plan.expected.has(repoPath)) archiveFail('selected path is a symbolic link');
    const linkDirectory = repoPath.includes('/') ? repoPath.slice(0, repoPath.lastIndexOf('/')) : '';
    validateLinkTarget(linkDirectory, header.linkname);
  }

  private beginBodyOrFinish(): void {
    const active = this.entry!;
    this.padRemaining = (512 - (active.remaining % 512)) % 512;
    if (active.remaining === 0) {
      this.finishBody();
    } else {
      this.mode = 'body';
    }
  }

  private finishBody(): void {
    const active = this.entry!;
    this.entry = null;
    if (active.kind === 'pax') {
      const content = Buffer.concat(active.chunks);
      validatePaxRecords(content, active.label);
      this.mode = this.padRemaining === 0 ? 'header' : 'pad';
      return;
    }
    const data = Buffer.concat(active.chunks);
    if (active.selected !== null) {
      const expected = active.selected;
      if (data.length !== expected.size) archiveFail(`selected file size mismatch for ${active.repoPath}`);
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (sha256 !== expected.sha256) archiveFail(`selected file SHA-256 mismatch for ${active.repoPath}`);
      const mode: 100644 | 100755 = (active.rawMode & 0o111) !== 0 ? 100755 : 100644;
      if (mode !== expected.mode) archiveFail(`selected file mode mismatch for ${active.repoPath}`);
      if (isLfsPointer(data)) archiveFail(`selected file ${active.repoPath} is an LFS pointer, which is unsupported`);
      this.selectedTotal += data.length;
      if (this.selectedTotal > this.limits.selectedBytes) {
        limitFail(`selected total size limit exceeded (${this.limits.selectedBytes} bytes)`);
      }
      this.collected.set(active.repoPath, { data, mode });
    }
    this.mode = this.padRemaining === 0 ? 'header' : 'pad';
  }

  finish(): void {
    if (this.mode === 'body' || this.mode === 'pad') archiveFail('truncated archive: an entry body continues past the end of the stream');
    if (this.mode === 'header') archiveFail('truncated archive: missing end-of-archive marker');
    if (this.mode === 'term1') archiveFail('truncated archive: incomplete end-of-archive marker');
    if (this.pendingLocalPax) archiveFail('truncated archive: local PAX record without a following entry');
    if (!this.tree.established) archiveFail('archive root missing');
    for (const archivePath of this.plan.expected.keys()) {
      if (!this.collected.has(archivePath)) archiveFail(`selected file missing from the archive: ${archivePath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Gzip framing: streaming decode with counters plus a single-member tail check
// ---------------------------------------------------------------------------

async function decodeAndScan(bytes: Buffer, plan: TupleScanPlan, limits: GithubLimits): Promise<{ root: string; collected: ArchiveScanner['collected'] }> {
  const scanner = new ArchiveScanner(plan, limits);
  let expanded = 0;
  let crc = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const gunzip = createGunzip();
    const failOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      gunzip.destroy();
      reject(error);
    };
    gunzip.on('data', (chunk: Buffer) => {
      try {
        expanded += chunk.length;
        if (expanded > limits.expandedBytes) {
          limitFail(`expanded byte limit exceeded (${limits.expandedBytes} bytes)`);
        }
        crc = crc32(chunk, crc);
        scanner.feed(chunk);
      } catch (error) {
        failOnce(error);
      }
    });
    gunzip.on('error', (error) => {
      failOnce(new AcquisitionError('ARCHIVE', `Archive gzip stream rejected: ${error instanceof Error ? error.message : String(error)}`));
    });
    gunzip.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        scanner.finish();
        verifyGzipTail(bytes, expanded, crc);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    gunzip.end(bytes);
  });
  return { root: scanner.root, collected: scanner.collected };
}

/**
 * A gzip member ends with CRC32 + ISIZE(mod 2^32) of its own output. When the
 * decoded stream is longer (or shorter) than the trailer's ISIZE, the input
 * contains concatenated members or trailing bytes. Node's zlib silently
 * accepts both, so this check is load-bearing.
 */
function verifyGzipTail(bytes: Buffer, expandedTotal: number, crc: number): void {
  if (bytes.length < 8) archiveFail('gzip stream is too small to contain a member trailer');
  const trailer = bytes.subarray(bytes.length - 8);
  const storedCrc = trailer.readUInt32LE(0);
  const storedIsize = trailer.readUInt32LE(4);
  if (storedIsize !== (expandedTotal % 4294967296)) archiveFail('gzip stream contains concatenated members or trailing data');
  if (storedCrc !== (crc >>> 0)) archiveFail('gzip stream CRC-32 mismatch');
}

// ---------------------------------------------------------------------------
// Transport: fetch with classification, deadlines, and cancellation
// ---------------------------------------------------------------------------

function classifyTransportError(error: unknown, signal: AbortSignal | undefined, timedOut: boolean): AcquisitionError {
  if (signal?.aborted) return new AcquisitionError('ABORTED', 'GitHub acquisition aborted');
  if (timedOut) return new AcquisitionError('TIMEOUT', 'GitHub acquisition timed out');
  if (error instanceof AcquisitionError) return error;
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  const causeCode = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : cause;
  if (typeof causeCode === 'string' && /CERT|SSL|TLS/i.test(causeCode)) {
    return new AcquisitionError('TLS', `GitHub acquisition TLS failure: ${causeCode}`);
  }
  return new AcquisitionError('INTERRUPTED', `GitHub acquisition transport interrupted: ${error instanceof Error ? error.message : String(error)}`);
}

async function fetchArchiveBytes(
  url: string,
  staging: GithubCacheStaging,
  deps: GithubAcquisitionDeps,
  limits: GithubLimits,
  signal: AbortSignal | undefined,
): Promise<{ bytes: Buffer; receipt: ArchiveReceipt }> {
  const controller = new AbortController();
  const state = { timedOut: false };
  let body: ReadableStream<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let gateReject: ((error: unknown) => void) | undefined;
  const gate = new Promise<never>((_, reject) => {
    gateReject = reject;
  });
  const cancelBody = () => {
    const target = reader ?? body;
    if (target) void target.cancel().catch(() => {});
  };
  const fireTimeout = () => {
    state.timedOut = true;
    controller.abort();
    cancelBody();
    // Defer the rejection one microtask so a fetch that has already resolved
    // can run its post-fetch abort branch first and cancel the body stream.
    queueMicrotask(() => gateReject?.(new AcquisitionError('TIMEOUT', 'GitHub acquisition timed out')));
  };
  const onAbort = () => {
    controller.abort();
    cancelBody();
    queueMicrotask(() => gateReject?.(new AcquisitionError('ABORTED', 'GitHub acquisition aborted')));
  };

  const work = (async () => {
    let totalTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    try {
      if (signal?.aborted) {
        // The signal aborted before the fetch began (for example between cache
        // staging and transport start). The fetch still runs so the response
        // body can be cancelled; the post-fetch abort branch rejects next.
        controller.abort();
      } else if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      totalTimer = setTimeout(fireTimeout, limits.requestMs);
      const response = await deps.fetch(url, { redirect: 'error', credentials: 'omit', signal: controller.signal, headers: {} });
      if (signal?.aborted) {
        if (response.body) await response.body.cancel().catch(() => {});
        throw new AcquisitionError('ABORTED', 'GitHub acquisition aborted');
      }
      if (response.redirected === true) throw new AcquisitionError('REDIRECT', 'GitHub acquisition received a redirected response');
      const status = response.status;
      if (status >= 300 && status < 400) throw new AcquisitionError('REDIRECT', `GitHub acquisition received HTTP ${status}`);
      if (status === 404) throw new AcquisitionError('NOT_FOUND', 'GitHub source commit archive not found');
      if (status === 403) throw new AcquisitionError('FORBIDDEN', 'GitHub source commit archive request was forbidden');
      if (status === 429) throw new AcquisitionError('RATE_LIMIT', 'GitHub acquisition rate limited', response.headers.get('retry-after') ?? undefined);
      if (status < 200 || status >= 300) throw new AcquisitionError('HTTP', `GitHub acquisition failed with HTTP ${status}`);
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limits.compressedBytes)) {
        throw new AcquisitionError('HTTP', `invalid or oversized Content-Length header: ${declared}`);
      }
      if (response.body == null) throw new AcquisitionError('HTTP', 'GitHub acquisition response has no body');
      body = response.body;
      reader = body.getReader();
      const chunks: Buffer[] = [];
      const hash = createHash('sha512');
      let total = 0;
      for (;;) {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = setTimeout(fireTimeout, limits.idleMs);
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } finally {
          if (idleTimer !== undefined) clearTimeout(idleTimer);
        }
        if (read.done) break;
        const chunk = Buffer.from(read.value);
        total += chunk.length;
        if (total > limits.compressedBytes) {
          limitFail(`compressed byte limit exceeded (${limits.compressedBytes} bytes)`);
        }
        hash.update(chunk);
        await staging.write(chunk);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      return { bytes, receipt: { compressedSha512: hash.digest('hex'), compressedBytes: bytes.length } };
    } catch (error) {
      throw classifyTransportError(error, signal, state.timedOut);
    } finally {
      if (totalTimer !== undefined) clearTimeout(totalTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onAbort);
    }
  })();
  work.catch(() => {});
  const result = await Promise.race([work, gate]);
  // A cancelled body stream resolves its pending read as `done`, so a timed-out
  // or aborted fetch can still "succeed" with partial bytes; reject it here
  // before any partial archive can reach the scanner.
  if (state.timedOut) throw new AcquisitionError('TIMEOUT', 'GitHub acquisition timed out');
  if (signal?.aborted) throw new AcquisitionError('ABORTED', 'GitHub acquisition aborted');
  await staging.seal();
  return result;
}

// ---------------------------------------------------------------------------
// Cache-aware tuple acquisition with per-cache single-flight
// ---------------------------------------------------------------------------

interface ObtainedTuple {
  key: string;
  bytes: Buffer;
  receipt: ArchiveReceipt;
  staging: GithubCacheStaging | null;
  owner: boolean;
}

const inflightByCache = new WeakMap<GithubCache, Map<string, Promise<ObtainedTuple>>>();

async function readCacheBody(body: ReadableStream<Uint8Array>, limits: GithubLimits): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limits.compressedBytes) {
      limitFail(`compressed byte limit exceeded (${limits.compressedBytes} bytes)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function obtainTuple(plan: TupleScanPlan, deps: GithubAcquisitionDeps, limits: GithubLimits, signal: AbortSignal | undefined): Promise<ObtainedTuple> {
  let registry = inflightByCache.get(deps.cache);
  if (!registry) {
    registry = new Map();
    inflightByCache.set(deps.cache, registry);
  }
  const existing = registry.get(plan.key);
  if (existing) {
    const shared = await existing;
    return { key: shared.key, bytes: shared.bytes, receipt: shared.receipt, staging: shared.staging, owner: false };
  }
  const promise = (async (): Promise<ObtainedTuple> => {
    const opened = await deps.cache.open(plan.key);
    if (opened) {
      const bytes = await readCacheBody(opened.body, limits);
      const sha512 = createHash('sha512').update(bytes).digest('hex');
      if (sha512 !== opened.receipt.compressedSha512 || bytes.length !== opened.receipt.compressedBytes) {
        await deps.cache.discard(plan.key);
        if (deps.offline) {
          throw new AcquisitionError('OFFLINE_MISS', 'Offline acquisition found no verified cache for the requested source');
        }
      } else {
        return { key: plan.key, bytes, receipt: opened.receipt, staging: null, owner: false };
      }
    }
    if (deps.offline) {
      throw new AcquisitionError('OFFLINE_MISS', 'Offline acquisition found no verified cache for the requested source');
    }
    if (signal?.aborted) throw new AcquisitionError('ABORTED', 'GitHub acquisition aborted');
    const staging = await deps.cache.stage(plan.key);
    try {
      const fetched = await fetchArchiveBytes(codeloadUrl(plan.repository, plan.commit), staging, deps, limits, signal);
      return { key: plan.key, bytes: fetched.bytes, receipt: fetched.receipt, staging, owner: true };
    } catch (error) {
      await staging.abort();
      throw error;
    }
  })();
  registry.set(plan.key, promise);
  promise.catch(() => {}).finally(() => {
    registry.delete(plan.key);
  });
  return promise;
}

// ---------------------------------------------------------------------------
// Deep entry point
// ---------------------------------------------------------------------------

export async function acquireGithubSource(
  request: { manifest: SourceManifest; signal?: AbortSignal },
  deps: GithubAcquisitionDeps,
): Promise<GithubAcquisitionResult> {
  if (!request || typeof request !== 'object' || !request.manifest) {
    throw new Error('acquireGithubSource requires a request with a manifest');
  }
  const validated = validateSourceManifest(request.manifest);
  if (validated.acquisition.kind !== 'github') {
    throw new Error('acquireGithubSource requires a GitHub acquisition manifest');
  }
  const limits: GithubLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  if (validated.files.length > limits.selectedFiles) {
    limitFail(`selected file limit exceeded (${limits.selectedFiles} files)`);
  }
  for (const file of validated.files) {
    if (file.size > limits.selectedFileBytes) {
      limitFail(`selected file size limit exceeded (${limits.selectedFileBytes} bytes)`);
    }
  }
  const selectedTotal = validated.files.reduce((sum, file) => sum + file.size, 0);
  if (selectedTotal > limits.selectedBytes) {
    limitFail(`selected total size limit exceeded (${limits.selectedBytes} bytes)`);
  }

  const plans = planTupleScans(validated);
  const obtained = new Map<string, ObtainedTuple>();
  try {
    for (const plan of plans) {
      obtained.set(plan.key, await obtainTuple(plan, deps, limits, request.signal));
    }
    const collected = new Map<string, { root: string; collected: ArchiveScanner['collected'] }>();
    for (const plan of plans) {
      collected.set(plan.key, await decodeAndScan(obtained.get(plan.key)!.bytes, plan, limits));
    }
    const acquisition = validated.acquisition as GithubAcquisition;
    const overlays = acquisition.overlays ?? [];
    const overlayByDestination = new Map<string, SourceOverlay>(overlays.map((overlay) => [overlay.destinationPath, overlay]));
    const primaryPlan = plans.find((plan) => plan.repository === acquisition.repository && plan.commit === acquisition.commit)!;
    const files: GithubAcquiredFile[] = validated.files.map((file) => {
      const overlay = overlayByDestination.get(file.path);
      let data: Buffer | undefined;
      if (overlay) {
        data = collected.get(tupleKey(overlay.repository, overlay.commit))?.collected.get(overlay.sourcePath)?.data;
      } else {
        const owner = acquisition.mappings.find((mapping) => pathWithin(file.path, mapping.destinationPath));
        if (owner) {
          data = collected.get(primaryPlan.key)?.collected.get(mappingSource(owner, file.path))?.data;
        }
      }
      if (!data) archiveFail(`selected file content was not materialized for ${file.path}`);
      return { ...file, data };
    });
    for (const obtainedTuple of obtained.values()) {
      if (obtainedTuple.owner && obtainedTuple.staging) await obtainedTuple.staging.publish(obtainedTuple.receipt);
    }
    const primary = obtained.get(primaryPlan.key)!;
    const result: GithubAcquisitionResult = {
      repository: acquisition.repository,
      commit: acquisition.commit,
      root: collected.get(primaryPlan.key)!.root,
      files,
      archiveReceipt: primary.receipt,
      treeDigest: validated.treeDigest,
      releaseDigest: validated.releaseDigest,
    };
    if (validated.authorization) result.authorization = validated.authorization;
    return result;
  } catch (error) {
    for (const obtainedTuple of obtained.values()) {
      if (obtainedTuple.owner && obtainedTuple.staging) {
        try {
          await obtainedTuple.staging.abort();
        } catch {
          // Staging cleanup is best-effort; the acquisition error is the real failure.
        }
      }
    }
    throw error;
  }
}
