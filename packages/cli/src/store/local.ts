import { chmod, cp, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context, SkillManifest } from '../types.js';
import { canonicalJson, validateManifest, validateSkillDocument, verifyTree } from '../validation.js';
import { readRegularFile } from '../registry/files.js';
import { ensurePrivateDir, exists } from './fs.js';
import { storePath, initHome } from './state.js';
import { fail } from '../errors.js';

export async function chmodTree(root:string,readonly:boolean):Promise<void>{
  const s=await lstat(root);if(s.isSymbolicLink())fail('INTEGRITY','不允许处理内容树中的链接');
  if(process.platform!=='win32')await chmod(root,s.isDirectory()?(readonly?0o555:0o700):(s.mode&0o111?(readonly?0o555:0o700):(readonly?0o444:0o600)));
  if(s.isDirectory())for(const name of await readdir(root))await chmodTree(join(root,name),readonly);
}
export async function importTree(ctx:Context,source:string,input:SkillManifest):Promise<string>{
  const manifest=validateManifest(input);await verifyTree(source,manifest);validateSkillDocument(await readRegularFile(join(source,'SKILL.md'),1024*1024),manifest.name);await initHome(ctx);
  const directory=storePath(ctx,manifest.contentDigest),object=join(ctx.home,'store',manifest.contentDigest);
  if(await exists(object)){await verifyTree(directory,manifest);return directory;}
  await ensurePrivateDir(join(ctx.home,'store'));const staging=await mkdtemp(join(ctx.home,'store','.local-'));
  try{
    await cp(source,join(staging,'skill'),{recursive:true,dereference:false,errorOnExist:true,force:false});
    await verifyTree(join(staging,'skill'),manifest);await writeFile(join(staging,'manifest.json'),canonicalJson(manifest)+'\n',{flag:'wx',mode:0o444});
    await chmodTree(staging,true);
    try{await rename(staging,object);}catch(e){if(!['EEXIST','ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code||''))throw e;await verifyTree(directory,manifest);}
  }finally{if(await exists(staging)){await chmodTree(staging,false);await rm(staging,{recursive:true});}}
  return directory;
}
