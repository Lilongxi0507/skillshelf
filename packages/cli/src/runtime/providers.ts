import { lstat, rename, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import type { Context } from '../types.js';
import { fail } from '../errors.js';
import { validateStoredHomeLocation } from '../store/state.js';
import { assertPrivatePath, canonicalStorageHome, createPrivateFile, ensurePrivateDirectory, readPrivateFile, temporaryName, PRIVATE_CONFIG_MAX_BYTES } from './privacy.js';

export type ProviderKind = 'search' | 'image' | 'video';
export interface ProviderInput {
  id: string;
  kind: ProviderKind;
  name?: string;
  model?: string;
  baseUrl: string;
  endpoint?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  /** Required to persist a literal key. Prefer apiKeyEnv and a user-owned environment. */
  allowPlaintext?: boolean;
  adapter?: string;
  profile?: Record<string, unknown>;
  makeDefault?: boolean;
}
export interface ProviderResource {
  id: string; kind: ProviderKind; name: string; model: string; base_url: string; endpoint: string;
  adapter: string; profile?: Record<string, unknown>; api_key_env?: string; api_key?: string;
}
export interface ProviderConfig { version: 1; resources: ProviderResource[]; defaults: Partial<Record<ProviderKind, string>> }
export interface ProviderMetadata {
  id: string; kind: ProviderKind; name: string; model: string; baseUrl: string; endpoint: string; adapter: string;
  key: { source: 'env' | 'plaintext'; env?: string; configured: boolean }; isDefault: boolean;
}
export interface ProvidersView { version: 1; resources: ProviderMetadata[]; defaults: Partial<Record<ProviderKind, string>> }

const KINDS: ProviderKind[] = ['search', 'image', 'video'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const blank = (): ProviderConfig => ({ version: 1, resources: [], defaults: {} });
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function text(value: unknown, field: string, max = 512, empty = false): string {
  if (typeof value !== 'string' || (!empty && value.trim().length === 0) || value.length > max || /[\0-\x1f\x7f]/u.test(value)) fail('USAGE', `Invalid provider ${field}`);
  return value;
}

/** No DNS requests during management; the first-party transport rechecks DNS before each request. */
export function providerUrl(value: unknown): string {
  const raw = text(value, 'HTTPS URL', 2048);
  let url: URL;
  try { url = new URL(raw); } catch { fail('USAGE', 'Provider URLs must be valid HTTPS URLs'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) {
    fail('USAGE', 'Provider URLs require HTTPS on port 443 without credentials, queries or fragments');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (host === 'localhost' || /\.(?:localhost|local|internal)$/u.test(host) || !host.includes('.') && !host.includes(':')) fail('USAGE', 'Local/private provider addresses are not allowed');
  if (isIP(host) === 4) {
    const octets = host.split('.').map(Number);
    const a = octets[0] ?? 0; const b = octets[1] ?? 0;
    if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19)) fail('USAGE', 'Local/private provider addresses are not allowed');
  }
  if (isIP(host) === 6 && !/^[23][0-9a-f]{3}:/u.test(host)) fail('USAGE', 'Non-global IPv6 provider addresses are not allowed');
  return url.toString();
}

function profileValue(value: unknown, depth = 0): unknown {
  if (depth > 8) fail('USAGE', 'Provider profile is too deeply nested');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return text(value, 'profile value', 2048, true);
  if (Array.isArray(value)) { if (value.length > 128) fail('USAGE', 'Provider profile array is too large'); return value.map((entry) => profileValue(entry, depth + 1)); }
  if (record(value)) {
    if (Object.keys(value).length > 128) fail('USAGE', 'Provider profile has too many fields');
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!/^[A-Za-z0-9_-]{1,80}$/u.test(key) || /^(?:__proto__|prototype|constructor|api[-_]?key|token|secret|password|authorization|headers|cookies?|credentials?)$/iu.test(key)) fail('USAGE', 'Provider profile cannot contain credentials or unsafe field names');
      result[key] = profileValue(entry, depth + 1);
    }
    return result;
  }
  fail('USAGE', 'Provider profile must contain only JSON data');
}

function buildResource(input: ProviderInput): ProviderResource {
  if (!record(input) || typeof input.id !== 'string' || !ID.test(input.id) || !KINDS.includes(input.kind)) fail('USAGE', 'Provider requires a safe id and search/image/video kind');
  if (Object.keys(input).some((key) => !['id', 'kind', 'name', 'model', 'baseUrl', 'endpoint', 'apiKeyEnv', 'apiKey', 'allowPlaintext', 'adapter', 'profile', 'makeDefault'].includes(key))) fail('USAGE', 'Unknown provider input field');
  if (input.makeDefault !== undefined && typeof input.makeDefault !== 'boolean' || input.allowPlaintext !== undefined && typeof input.allowPlaintext !== 'boolean') fail('USAGE', 'Provider authorization and default flags must be booleans');
  if (input.id === '__proto__' || input.id === 'constructor' || input.id === 'prototype') fail('USAGE', 'Reserved provider id');
  const base = providerUrl(input.baseUrl);
  const adapter = text(input.adapter ?? (input.kind === 'search' ? '' : 'openai'), 'adapter', 80);
  if (!ID.test(adapter)) fail('USAGE', 'Invalid provider adapter');
  if (input.kind === 'search' && adapter !== 'tavily' && adapter !== 'brave') fail('USAGE', 'Search providers require the tavily or brave adapter');
  const suffix = input.kind === 'image' ? 'images/generations' : input.kind === 'video' ? 'videos' : adapter === 'brave' ? 'res/v1/web/search' : 'search';
  const endpoint = providerUrl(input.endpoint ?? `${base.replace(/\/$/u, '')}/${suffix}`);
  if (new URL(base).origin !== new URL(endpoint).origin) fail('USAGE', 'Provider endpoint must share the configured HTTPS origin');
  const resource: ProviderResource = {
    id: input.id, kind: input.kind, name: text(input.name ?? input.id, 'name', 160),
    model: text(input.model ?? (input.kind === 'search' ? adapter : ''), 'model', 160), base_url: base, endpoint, adapter,
  };
  if (input.profile !== undefined) {
    if (!record(input.profile)) fail('USAGE', 'Provider profile must be a JSON object');
    resource.profile = profileValue(input.profile) as Record<string, unknown>;
    if (JSON.stringify(resource.profile).length > 32_768) fail('USAGE', 'Provider profile is too large');
  }
  if (input.apiKeyEnv !== undefined) {
    if (typeof input.apiKeyEnv !== 'string' || !ENV_NAME.test(input.apiKeyEnv)) fail('USAGE', 'Provider apiKeyEnv must be an environment variable name');
    resource.api_key_env = input.apiKeyEnv; // Never resolve an environment reference while saving.
  } else {
    if (!input.apiKey || input.allowPlaintext !== true) fail('PERMISSION', 'Use apiKeyEnv, or explicitly authorize plaintext key storage with allowPlaintext');
    resource.api_key = text(input.apiKey, 'key', 8192);
  }
  if (input.apiKey && JSON.stringify({ ...resource, api_key: undefined }).includes(input.apiKey)) fail('USAGE', 'Credentials cannot appear in public provider metadata');
  return resource;
}

function validateConfig(value: unknown): ProviderConfig {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.resources) || value.resources.length > 256 || !record(value.defaults) || Object.keys(value).some((key) => !['version', 'resources', 'defaults'].includes(key))) fail('INTEGRITY', 'Unrecognized private providers configuration; refusing to overwrite');
  const resources: ProviderResource[] = [];
  const ids = new Set<string>();
  try {
    for (const row of value.resources) {
      if (!record(row) || Object.keys(row).some((key) => !['id', 'kind', 'name', 'model', 'base_url', 'endpoint', 'adapter', 'profile', 'api_key_env', 'api_key'].includes(key)) || row.api_key_env !== undefined && row.api_key !== undefined) fail('INTEGRITY', 'Invalid private resource');
      const resource = buildResource({
        id: row.id as string, kind: row.kind as ProviderKind, name: row.name as string, model: row.model as string,
        baseUrl: row.base_url as string, endpoint: row.endpoint as string, adapter: row.adapter as string,
        ...(row.profile === undefined ? {} : { profile: row.profile as Record<string, unknown> }),
        ...(row.api_key_env === undefined ? { apiKey: row.api_key as string, allowPlaintext: true } : { apiKeyEnv: row.api_key_env as string }),
      });
      if (ids.has(resource.id)) fail('INTEGRITY', 'Duplicate private provider id');
      ids.add(resource.id); resources.push(resource);
    }
  } catch { fail('INTEGRITY', 'Invalid private providers configuration; refusing to read or overwrite'); }
  const defaults: Partial<Record<ProviderKind, string>> = {};
  for (const [kind, id] of Object.entries(value.defaults)) {
    if (!KINDS.includes(kind as ProviderKind) || typeof id !== 'string' || !resources.some((item) => item.id === id && item.kind === kind)) fail('INTEGRITY', 'Invalid provider default');
    defaults[kind as ProviderKind] = id;
  }
  return { version: 1, resources, defaults };
}

export async function providerConfigPath(ctx: Context): Promise<string> {
  return path.join(await canonicalStorageHome(ctx.home), 'config', 'providers.json');
}

export async function loadProviders(ctx: Context): Promise<ProviderConfig> {
  const file = await providerConfigPath(ctx);
  for (const directory of [path.dirname(path.dirname(file)), path.dirname(file)]) {
    try { await assertPrivatePath(directory, true); }
    catch (error) { if (absent(error)) return blank(); throw error; }
  }
  try { await lstat(file); } catch (error) { if (absent(error)) return blank(); throw error; }
  const serialized = await readPrivateFile(file);
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { fail('INTEGRITY', 'Invalid JSON in private providers configuration'); }
  return validateConfig(parsed);
}

function view(config: ProviderConfig): ProvidersView {
  const secrets = config.resources.map((row) => row.api_key_env ? process.env[row.api_key_env] : row.api_key).filter((secret): secret is string => Boolean(secret));
  const redact = (value: string): string => {
    let safe = value;
    for (const secret of secrets) for (const representation of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) safe = safe.replaceAll(representation, '[REDACTED]');
    return safe;
  };
  const defaults: ProviderConfig['defaults'] = {};
  for (const kind of KINDS) if (config.defaults[kind]) defaults[kind] = redact(config.defaults[kind]!);
  return {
    version: 1, defaults,
    resources: config.resources.map((row) => ({
      id: redact(row.id), kind: row.kind, name: redact(row.name), model: redact(row.model), baseUrl: redact(row.base_url), endpoint: redact(row.endpoint), adapter: redact(row.adapter),
      key: row.api_key_env ? { source: 'env', env: redact(row.api_key_env), configured: Boolean(process.env[row.api_key_env]) } : { source: 'plaintext', configured: Boolean(row.api_key) },
      isDefault: config.defaults[row.kind] === row.id,
    })),
  };
}

export async function listProviders(ctx: Context): Promise<ProvidersView> { return view(await loadProviders(ctx)); }

async function mutate(ctx: Context, change: (config: ProviderConfig) => void): Promise<ProvidersView> {
  await validateStoredHomeLocation(ctx);
  const file = await providerConfigPath(ctx);
  await ensurePrivateDirectory(path.dirname(path.dirname(file)));
  await ensurePrivateDirectory(path.dirname(file));
  const lock = path.join(path.dirname(file), '.providers.lock');
  try { await createPrivateFile(lock, ''); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('CONFLICT', 'Providers configuration is locked; inspect the other local operation before retrying'); throw error; }
  const temporary = path.join(path.dirname(file), temporaryName('.providers'));
  try {
    const current = await loadProviders(ctx);
    change(current);
    const serialized = JSON.stringify(current, null, 2) + '\n';
    if (Buffer.byteLength(serialized, 'utf8') > PRIVATE_CONFIG_MAX_BYTES) fail('USAGE', 'Providers configuration exceeds the 1 MiB private-file limit; no configuration was changed');
    await createPrivateFile(temporary, serialized);
    try { await assertPrivatePath(file, false); } catch (error) { if (!absent(error)) throw error; }
    await rename(temporary, file);
    await assertPrivatePath(file, false);
    return view(current);
  } finally {
    await unlink(temporary).catch((error: unknown) => { if (!absent(error)) throw error; });
    await unlink(lock);
  }
}

export async function addProvider(ctx: Context, input: ProviderInput): Promise<ProvidersView> {
  const resource = buildResource(input); // Authorization/validation before creating anything.
  return mutate(ctx, (config) => {
    if (config.resources.some((row) => row.id === resource.id)) fail('CONFLICT', 'Provider id already exists; remove it explicitly before adding a replacement');
    if (config.resources.length >= 256) fail('USAGE', 'Provider limit reached');
    config.resources.push(resource);
    if (input.makeDefault === true || config.defaults[resource.kind] === undefined) config.defaults[resource.kind] = resource.id;
  });
}

export async function removeProvider(ctx: Context, id: string): Promise<ProvidersView> {
  if (typeof id !== 'string' || !ID.test(id)) fail('USAGE', 'Invalid provider id');
  const existing = await loadProviders(ctx);
  if (!existing.resources.some((row) => row.id === id)) fail('USAGE', 'No provider with this id');
  return mutate(ctx, (config) => {
    config.resources = config.resources.filter((row) => row.id !== id);
    for (const kind of KINDS) if (config.defaults[kind] === id) delete config.defaults[kind];
  });
}

export function providerSecret(resource: ProviderResource, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const secret = resource.api_key_env ? env[resource.api_key_env] : resource.api_key;
  if (!secret) return undefined;
  return text(secret, 'key', 8192);
}
