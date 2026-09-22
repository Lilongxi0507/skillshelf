export type ErrorCode = 'USAGE' | 'CONFLICT' | 'NETWORK' | 'OFFLINE' | 'INTEGRITY' | 'DEPENDENCY' | 'CANCELLED' | 'PERMISSION' | 'RECOVERY' | 'UNAVAILABLE';
export const exitCodes: Record<ErrorCode, number> = { USAGE: 2, CONFLICT: 3, NETWORK: 4, OFFLINE: 4, INTEGRITY: 5, DEPENDENCY: 6, CANCELLED: 130, PERMISSION: 7, RECOVERY: 8, UNAVAILABLE: 9 };
export class SkillShelfError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown) { super(message); this.name = 'SkillShelfError'; }
}
export function fail(code: ErrorCode, message: string, details?: unknown): never { throw new SkillShelfError(code, message, details); }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function classifyError(error:unknown):ErrorCode{
  if(error instanceof SkillShelfError)return error.code;
  const message=errorMessage(error),code=(error as NodeJS.ErrnoException)?.code;
  if(code?.startsWith('commander.'))return 'USAGE';
  if(code==='EACCES'||code==='EPERM')return 'PERMISSION';
  if(/offline/i.test(message))return 'OFFLINE';
  if(/fetch failed|registry returned HTTP|network|timeout/i.test(message))return 'NETWORK';
  if(/requires SkillShelf CLI/i.test(message))return 'DEPENDENCY';
  if(/unsafe package|integrity|SRI|manifest|invalid|untrusted|mismatch|catalog|collision|limit|forbidden|links?\/special/i.test(message))return 'INTEGRITY';
  return 'UNAVAILABLE';
}
