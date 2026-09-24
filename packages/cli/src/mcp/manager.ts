import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context, OperationResult } from '../types.js';
import { ensurePrivateDir, exists, readJson, writeJson } from '../store/fs.js';
import { fail } from '../errors.js';

export type McpTransport = 'stdio' | 'http';
export interface McpDefinition { id: string; name: string; transport: McpTransport; command?: string; args?: string[]; url?: string; env?: Record<string, string>; enabled: boolean; source?: string; installedAt: string; updatedAt: string }
interface McpFile { schemaVersion: 1; definitions: Record<string, McpDefinition> }
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
function checkId(id: string): string { if (!ID.test(id) || id.length > 80) fail('USAGE', 'MCP ID 无效：' + id); return id; }
async function filePath(ctx: Context): Promise<string> { return join(ctx.home, 'config', 'mcp.json'); }
async function readFile(ctx: Context): Promise<McpFile> {
  const path = await filePath(ctx); if (!(await exists(path))) return { schemaVersion: 1, definitions: {} };
  const value = await readJson<unknown>(path);
  if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== 1 || typeof (value as { definitions?: unknown }).definitions !== 'object') fail('INTEGRITY', 'MCP 定义文件格式无效');
  return value as McpFile;
}
async function saveFile(ctx: Context, value: McpFile): Promise<void> { await ensurePrivateDir(join(ctx.home, 'config')); await writeJson(await filePath(ctx), value); }
function redacted(definition: McpDefinition): OperationResult { return { ...definition, env: definition.env ? Object.fromEntries(Object.keys(definition.env).map(key => [key, '<env-ref>'])) : undefined }; }

export async function listMcp(ctx: Context): Promise<OperationResult> { return { definitions: Object.values((await readFile(ctx)).definitions).map(redacted) }; }
export async function addMcp(ctx: Context, input: { id: string; name?: string; transport: McpTransport; command?: string; args?: string[]; url?: string; env?: Record<string, string>; source?: string; enabled?: boolean }): Promise<OperationResult> {
  const id = checkId(input.id); if (input.transport === 'stdio' && !input.command) fail('USAGE', 'stdio MCP 需要 command');
  if (input.transport === 'http') { if (!input.url) fail('USAGE', 'HTTP MCP 需要 URL'); let url: URL; try { url = new URL(input.url); } catch { fail('USAGE', 'MCP URL 无效'); } if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('USAGE', 'MCP URL 必须是无凭据 HTTP(S) 地址'); }
  const file = await readFile(ctx), prior = file.definitions[id], now = new Date().toISOString();
  const definition: McpDefinition = { id, name: input.name?.trim() || id, transport: input.transport, command: input.command, args: input.args || [], url: input.url, env: input.env, enabled: input.enabled ?? true, source: input.source, installedAt: prior?.installedAt || now, updatedAt: now };
  file.definitions[id] = definition; await saveFile(ctx, file); return { definition: redacted(definition), replaced: !!prior, credentials: 'environment references only' };
}
export async function removeMcp(ctx: Context, id: string): Promise<OperationResult> { const file = await readFile(ctx), key = checkId(id); if (!file.definitions[key]) return { id: key, removed: false }; delete file.definitions[key]; await saveFile(ctx, file); return { id: key, removed: true, agentsNeedReload: true }; }
export async function setMcpEnabled(ctx: Context, id: string, enabled: boolean): Promise<OperationResult> { const file = await readFile(ctx), key = checkId(id), item = file.definitions[key]; if (!item) fail('USAGE', 'MCP 不存在：' + key); item.enabled = enabled; item.updatedAt = new Date().toISOString(); await saveFile(ctx, file); return { definition: redacted(item), enabled, agentsNeedReload: true }; }
export async function diagnoseMcp(ctx: Context, id?: string): Promise<OperationResult> {
  const items = Object.values((await readFile(ctx)).definitions).filter(item => !id || item.id === id); if (id && !items.length) fail('USAGE', 'MCP 不存在：' + id);
  const results = items.map(item => { const details: string[] = []; let status: 'ready' | 'disabled' | 'invalid' = item.enabled ? 'ready' : 'disabled'; if (item.transport === 'stdio' && !item.command) { status = 'invalid'; details.push('缺少 command'); } if (item.transport === 'http' && !item.url) { status = 'invalid'; details.push('缺少 url'); } if (item.env) for (const [key, variable] of Object.entries(item.env)) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) { status = 'invalid'; details.push(`环境变量引用无效：${key}`); } else if (!process.env[variable]) details.push(`环境变量未设置：${variable}`); } return { id: item.id, transport: item.transport, status, details }; });
  return { networkRequested: false, protocolProbe: 'not-run', results };
}
export async function mcpConfigPreview(ctx: Context, targetId?: string): Promise<OperationResult> { const list = await listMcp(ctx); return { targetId: targetId || null, entries: (list.definitions as OperationResult[]).filter(item => item.enabled).map(item => ({ id: item.id, transport: item.transport, command: item.command, args: item.args, url: item.url, env: item.env ? Object.keys(item.env) : [] })), write: 'preview-only; native Agent configuration is not modified' }; }
