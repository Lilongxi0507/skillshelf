import { ALLOWED_SCOPE, EXACT_VERSION, LIMITS, validateIntegrity } from '../validation.js';
import { RELEASE_CHANNEL } from '../release.js';

export const NPM_REGISTRY = 'https://registry.npmjs.org';
export const CATALOG_PACKAGE = `${ALLOWED_SCOPE}/skillshelf-catalog`;
export const CLI_PACKAGE = `${ALLOWED_SCOPE}/skillshelf`;
export interface NpmRelease { name: string; version: string; integrity: string; tarball: string }
export function assertRegistryUrl(value: string): URL {
  const url = new URL(value);
  if (url.origin !== NPM_REGISTRY || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[\\\x00-\x20]/.test(value)) throw new Error('Only the fixed public npm registry is allowed');
  return url;
}
export async function fetchRegistryBytes(url: string, maximum: number): Promise<Buffer> {
  assertRegistryUrl(url);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { Accept: 'application/json, application/octet-stream', 'User-Agent': 'SkillShelf/0.1 (data-only)' } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Public npm registry returned HTTP ${response.status}`); }
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) { await response.body?.cancel(); throw new Error('Registry response exceeds byte limit'); }
  if (!response.body) throw new Error('Empty registry response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const row = await reader.read(); if (row.done) break; total += row.value.byteLength; if (total > maximum) throw new Error('Registry response exceeds byte limit'); chunks.push(row.value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function resolveNpmRelease(packageName: string, version: string, allowReleaseChannel = false): Promise<NpmRelease> {
  if (!packageName.startsWith(ALLOWED_SCOPE + '/') || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(packageName.slice(ALLOWED_SCOPE.length + 1))) throw new Error('Package outside fixed SkillShelf namespace');
  const channelRequest = allowReleaseChannel && [CATALOG_PACKAGE, CLI_PACKAGE].includes(packageName) && version === RELEASE_CHANNEL;
  if (!EXACT_VERSION.test(version) && !channelRequest) throw new Error('An exact npm version or the fixed release channel is required');
  const bytes = await fetchRegistryBytes(`${NPM_REGISTRY}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`, LIMITS.catalogBytes);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('Invalid npm release metadata'); }
  const row = value as { name?: unknown; version?: unknown; dist?: { integrity?: unknown; tarball?: unknown } };
  if (!row || row.name !== packageName || typeof row.version !== 'string' || !EXACT_VERSION.test(row.version) || (!channelRequest && row.version !== version) || !row.dist || typeof row.dist.tarball !== 'string') throw new Error('npm release identity/version mismatch');
  const integrity = validateIntegrity(row.dist.integrity), tarball = assertRegistryUrl(row.dist.tarball);
  const basename = packageName.slice(ALLOWED_SCOPE.length + 1);
  if (decodeURIComponent(tarball.pathname) !== `/${packageName}/-/${basename}-${row.version}.tgz`) throw new Error('npm tarball is not for the exact allowed package/version');
  return { name: packageName, version: row.version, integrity, tarball: tarball.href };
}
