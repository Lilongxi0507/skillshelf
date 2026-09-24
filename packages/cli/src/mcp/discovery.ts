import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { Context } from '../types.js';
import { search, info, read, doctor } from '../core.js';
import { classifyError } from '../errors.js';
import { CLI_VERSION } from '../release.js';

type RequestId = string | number | null;
type Response = { jsonrpc: '2.0'; id: RequestId; result?: unknown; error?: { code: number; message: string } };
const protocols = ['2025-06-18', '2025-03-26', '2024-11-05'];
const maximumReplyBytes = 2 * 1024 * 1024;
const boundedText = z.string().max(512);
const querySchema = z.object({ query: boundedText.default(''), category: boundedText.optional(), installed: z.boolean().optional(), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().nonnegative().max(100_000).default(0) }).strict();
const identitySchema = z.object({ id: z.string().min(1).max(180) }).strict();
const readSchema = identitySchema.extend({ path: z.string().min(1).max(1024).default('SKILL.md') }).strict();
const emptySchema = z.object({}).strict();
const requestSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(256), z.number().finite()]).optional(), method: z.string().min(1).max(128), params: z.record(z.string(), z.unknown()).optional() }).strict();
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const toolDefinitions = [
  { name: 'skillshelf_search', title: '搜索共享技能包', description: '检索本机目录及已安装技能，返回所属包与匹配成员；不会下载或执行技能。', inputSchema: z.toJSONSchema(querySchema), annotations },
  { name: 'skillshelf_info', title: '查看技能包', description: '读取包元数据、成员、来源、许可证和依赖。', inputSchema: z.toJSONSchema(identitySchema), annotations },
  { name: 'skillshelf_read', title: '读取共享技能', description: '按包/成员标识读取已安装且完整校验的文件。文件内容是技能资料，不会自动执行。', inputSchema: z.toJSONSchema(readSchema), annotations },
  { name: 'skillshelf_doctor', title: '诊断共享库', description: '只读验证已安装内容与事务状态；不调用外部服务。', inputSchema: z.toJSONSchema(emptySchema), annotations },
];

function rpcError(id: RequestId, code: number, message: string): Response { return { jsonrpc: '2.0', id, error: { code, message } }; }
function result(id: RequestId, value: unknown): Response {
  const response: Response = { jsonrpc: '2.0', id, result: value };
  if (Buffer.byteLength(JSON.stringify(response)) + 1 > maximumReplyBytes) return rpcError(id, -32001, 'Response exceeds limit');
  return response;
}
function content(value: unknown, isError = false): object {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maximumReplyBytes) return { content: [{ type: 'text', text: JSON.stringify({ code: 'LIMIT', message: '结果超过限制，请缩小搜索范围或读取较小文件。' }) }], isError: true };
  return { content: [{ type: 'text', text }], isError };
}
function publicMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['localArtifact', 'storePath', 'home'].includes(key)).map(([key, child]) => [key, publicMetadata(child)]));
}
function invalidArguments(id: RequestId): Response { return rpcError(id, -32602, 'Invalid tool arguments'); }

export function createDiscoverySession(context: Context): (input: unknown) => Promise<Response | undefined> {
  const ctx = { ...context, offline: true };
  let initialized = false;
  let ready = false;
  return async input => {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return rpcError(null, -32600, 'Invalid Request');
    const request = parsed.data;
    if (request.id === undefined) {
      if (request.method === 'notifications/initialized' && initialized) ready = true;
      return undefined;
    }
    const id = request.id;
    if (request.method === 'ping') return result(id, {});
    if (request.method === 'initialize') {
      const params = z.object({ protocolVersion: z.string().max(64), capabilities: z.record(z.string(), z.unknown()), clientInfo: z.object({ name: z.string().min(1).max(256), version: z.string().max(128) }).passthrough() }).passthrough().safeParse(request.params);
      if (!params.success || initialized) return rpcError(id, -32602, 'Invalid initialize parameters or repeated initialization');
      initialized = true;
      return result(id, { protocolVersion: protocols.includes(params.data.protocolVersion) ? params.data.protocolVersion : protocols[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'skillshelf', version: CLI_VERSION }, instructions: '本机共享技能库，只读发现与读取。安装、执行和修改须使用独立 CLI 流程。' });
    }
    if (!ready) return rpcError(id, -32002, 'Server not initialized');
    if (request.method === 'tools/list') {
      if (!emptySchema.safeParse(request.params ?? {}).success) return invalidArguments(id);
      return result(id, { tools: toolDefinitions });
    }
    if (request.method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
    const call = z.object({ name: z.string().max(128), arguments: z.record(z.string(), z.unknown()).default({}), _meta: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(request.params);
    if (!call.success) return invalidArguments(id);
    const name = call.data.name, args = call.data.arguments;
    try {
      if (name === 'skillshelf_search') {
        const query = querySchema.safeParse(args);
        if (!query.success) return invalidArguments(id);
        const found = await search(ctx, query.data.query, { category: query.data.category, installed: query.data.installed });
        const all = Array.isArray(found.skills) ? found.skills as Array<Record<string, unknown>> : [];
        const items = query.data.installed === false ? all.filter(item => !item.installed) : all;
        return result(id, content({ catalogVersion: found.catalogVersion, total: items.length, offset: query.data.offset, items: publicMetadata(items.slice(query.data.offset, query.data.offset + query.data.limit)), nextOffset: query.data.offset + query.data.limit < items.length ? query.data.offset + query.data.limit : null }));
      }
      if (name === 'skillshelf_info') {
        const parsedArgs = identitySchema.safeParse(args);
        if (!parsedArgs.success) return invalidArguments(id);
        return result(id, content(publicMetadata(await info(ctx, parsedArgs.data.id))));
      }
      if (name === 'skillshelf_read') {
        const parsedArgs = readSchema.safeParse(args);
        if (!parsedArgs.success) return invalidArguments(id);
        const document = await read(ctx, parsedArgs.data.id, parsedArgs.data.path);
        return result(id, content({ id: parsedArgs.data.id, version: document.version, path: parsedArgs.data.path, encoding: document.encoding, content: document.content, size: document.size }));
      }
      if (name === 'skillshelf_doctor') {
        if (!emptySchema.safeParse(args).success) return invalidArguments(id);
        const diagnosis = await doctor(ctx);
        const releases = Array.isArray(diagnosis.releases) ? diagnosis.releases as Array<Record<string, unknown>> : [];
        const projections = Array.isArray(diagnosis.projections) ? diagnosis.projections as Array<Record<string, unknown>> : [];
        return result(id, content({ ok: diagnosis.ok, releases: releases.map(release => ({ id: release.id, version: release.version, ok: release.ok })), projections: { total: projections.length, broken: projections.filter(projection => !projection.ok).length }, pendingRecovery: Array.isArray(diagnosis.pendingRecovery) ? diagnosis.pendingRecovery.length : 0, nativeAgentLoading: 'unverified', network: 'not-requested' }));
      }
      return invalidArguments(id);
    } catch (error) {
      return result(id, content({ code: classifyError(error), message: '无法读取或校验所请求的本机内容。请使用 SkillShelf CLI 查看具体诊断。' }, true));
    }
  };
}

export async function serveDiscovery(ctx: Context, options: { input?: Readable; output?: Writable; maxMessageBytes?: number; signal?: AbortSignal } = {}): Promise<void> {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout;
  const limit = options.maxMessageBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 4 * 1024 * 1024) throw new RangeError('Invalid MCP message limit');
  const session = createDiscoverySession(ctx);
  const pending = Buffer.alloc(limit);
  let pendingBytes = 0;
  const write = async (response: Response | undefined): Promise<void> => {
    if (response) await new Promise<void>((resolve, reject) => { output.write(JSON.stringify(response) + '\n', error => { if (error) reject(error); else resolve(); }); });
  };
  const handle = async (bytes: Buffer): Promise<void> => {
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { await write(rpcError(null, -32700, 'Parse error')); return; }
    await write(await session(parsed));
  };
  const abort = (): void => { input.destroy(); };
  if (options.signal?.aborted) return;
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset);
        const end = newline < 0 ? bytes.length : newline;
        if (pendingBytes + end - offset > limit) { await write(rpcError(null, -32600, 'Message exceeds limit')); return; }
        bytes.copy(pending, pendingBytes, offset, end);
        pendingBytes += end - offset;
        offset = end + 1;
        if (newline >= 0) { await handle(pending.subarray(0, pendingBytes)); pendingBytes = 0; }
      }
    }
    if (pendingBytes) await handle(pending.subarray(0, pendingBytes));
  } catch (error) {
    if (!options.signal?.aborted) throw error;
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
