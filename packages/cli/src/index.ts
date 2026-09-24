#!/usr/bin/env node
import { Command } from 'commander';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import type { AgentId, Context, MutationOptions } from './types.js';
import { defaultHome } from './store/fs.js';
import { getRelease, loadState } from './store/state.js';
import { canonicalProjectPath } from './agents/agents.js';
import { addAgent, checkUpdates, doctor, forkSkill, installSkills, listAgents, listSkills, localStatus, pinSkills, readSkill, removeAgent, removeSkills, rollbackSkill, syncFrozen, toggleSkills, updateSkills, verifyInstalled } from './manager.js';
import { loadCatalog, refreshCatalog } from './catalog/catalog.js';
import { addProvider, listProviders, removeProvider, runSkill, type ProviderInput } from './runtime/runtime.js';
import { recoverTransactions } from './transactions/transaction.js';
import { exportLibrary, importLibrary, migratePanel } from './commands/portable.js';
import { garbageCollect, migrateHome, uninstallSkillShelf } from './commands/maintenance.js';
import { connectMessage, enrollAgent, listEnrollments, verifyEnrolledAgent, scanTarget, applyDedupe, restoreDedupe } from './agents/onboarding.js';
import { createDraft, listDrafts, validateDraft, publishDraft, removeDraft } from './authoring.js';
import { listProfiles, saveProfile, removeProfile, applyProfile } from './profiles.js';
import { addMcp, listMcp, removeMcp, setMcpEnabled, diagnoseMcp, mcpConfigPreview } from './mcp/manager.js';
import { menu, installWizard, providerWizard, confirmation, display, cleanText } from './tui/ui.js';
import { formatResult } from './tui/format.js';
import { SkillShelfError, fail, errorMessage, exitCodes, classifyError } from './errors.js';
import { CLI_PACKAGE, resolveNpmRelease } from './registry/http.js';
import { CLI_VERSION, RELEASE_CHANNEL } from './release.js';

export const VERSION=CLI_VERSION;
function optionContext(cmd:Command):Context{const o=cmd.optsWithGlobals();return{home:resolve(o.home||defaultHome()),offline:!!o.offline,json:!!o.json,catalogPath:o.catalog?resolve(o.catalog):undefined};}
async function mutationOptions(cmd:Command):Promise<MutationOptions>{const o=cmd.optsWithGlobals();return{dryRun:!!o.dryRun,yes:!!o.yes,project:o.project?await canonicalProjectPath(o.project):undefined,agents:o.agent,mode:o.mode};}
function emit(cmd:Command,data:unknown):void{
  if(cmd.optsWithGlobals().json)console.log(JSON.stringify({schemaVersion:1,command:cmd.name(),status:'ok',data}));
  else console.log(cleanText(formatResult(data)));
}
async function mutate(cmd:Command,preview:()=>Promise<unknown>,apply:()=>Promise<unknown>):Promise<void>{
  const o=cmd.optsWithGlobals();if(o.dryRun){emit(cmd,await preview());return;}
  if(!o.yes){if(!process.stdin.isTTY||!process.stdout.isTTY||o.json)fail('USAGE','非交互写操作需要 --yes，或使用 --dry-run 预览');display(await preview(),'变更预览');if(!await confirmation('确认以上变更？'))fail('CANCELLED','操作已取消');}
  emit(cmd,await apply());
}
/** JSON 错误报告：全局选项的值绝不会被当作命令名回显。 */
export function errorCommandName(program:Command,argv:string[]):string{
  const valued=new Set(['--home','--catalog']);
  const positional:string[]=[];
  for(let index=2;index<argv.length;index++){
    const token=argv[index]!;
    if(token==='--')break;
    if(token.startsWith('-')&&token!=='-'){if(valued.has(token))index++;continue;}
    positional.push(token);
  }
  const paths=new Set<string>();
  const walk=(parent:Command,prefix:string):void=>{for(const child of parent.commands)for(const name of [child.name(),...child.aliases()]){const value=prefix?prefix+' '+name:name;paths.add(value);walk(child,value);}};
  walk(program,'');
  for(let length=positional.length;length>0;length--){const candidate=positional.slice(0,length).join(' ');if(paths.has(candidate))return candidate;}
  return positional[0]||'skillshelf';
}
function writing(command:Command,project=true):Command{command.option('-y, --yes','确认执行').option('--dry-run','只预览，不修改');if(project)command.option('--project <directory>','显式项目范围，默认全局');return command;}
function targeting(command:Command):Command{return command.option('-a, --agent <targets...>','Agent ID或已注册目标ID').option('--mode <mode>','auto/link/copy');}
export function buildProgram():Command{
  const program=new Command().name('skillshelf').description('个人精选 · 完整本地包 · 多Agent共享').version(VERSION)
    .option('--home <directory>','独立SkillShelf数据目录').option('--catalog <file>','显式使用本地目录快照（开发/离线包）')
    .option('--offline','禁止SkillShelf启动后联网').option('--json','稳定机器可读JSON输出').showHelpAfterError().enablePositionalOptions().exitOverride();
  program.action(async()=>{const ctx=optionContext(program);if(ctx.json)emit(program,await localStatus(ctx));else await menu(ctx);});
  program.command('setup').description('中文首次安装向导').action(async(_,cmd)=>{if(!process.stdin.isTTY)fail('USAGE','setup需要交互终端；自动化使用install --yes');await installWizard(optionContext(cmd),true);});
  const listing=program.command('list').description('浏览本地精选目录，不自动联网').option('--category <id>','主分类').option('--collection <id>','来源系列').option('--installed','仅全局已安装').option('-q, --query <text>','关键词','');
  listing.action(async(_,cmd)=>emit(cmd,await listSkills(optionContext(cmd),cmd.opts().query,cmd.opts())));
  program.command('search <query>').description('中英文关键词检索本地目录').option('--category <id>','主分类').action(async(query,_,cmd)=>emit(cmd,await listSkills(optionContext(cmd),query,cmd.opts())));
  program.command('info <id>').description('技能用途、来源、许可证与依赖').action(async(id,_,cmd)=>{const catalog=await loadCatalog(optionContext(cmd));const entry=catalog.skills.find(e=>e.id===id||e.name===id);if(!entry)fail('USAGE','技能不存在');emit(cmd,entry);});
  const catalog=program.command('catalog').description('精选目录管理');
  writing(catalog.command('refresh').description('联网更新目录，不更新技能'),false).action(async(_,cmd)=>mutate(cmd,async()=>({action:'刷新npm精选目录',skillsUnchanged:true}),async()=>refreshCatalog(optionContext(cmd))));
  const install=targeting(writing(program.command('install [ids...]').alias('add').description('按需下载完整技能并接入所选Agent'))).option('--collection <id>','选择精选组合');
  install.action(async(ids,_,cmd)=>{const ctx=optionContext(cmd),opts={...await mutationOptions(cmd),collection:cmd.opts().collection};await mutate(cmd,()=>installSkills(ctx,ids,{...opts,dryRun:true}),()=>installSkills(ctx,ids,opts));});
  for(const enable of[true,false])targeting(writing(program.command((enable?'enable':'disable')+' <ids...>').description(enable?'把已装技能接入Agent':'停用指定Agent投影，保留完整内容'))).action(async(ids,_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>toggleSkills(ctx,ids,enable,{...opts,dryRun:true}),()=>toggleSkills(ctx,ids,enable,opts));});
  targeting(writing(program.command('remove <ids...>').description('卸载当前范围选择，其他引用不受影响'))).action(async(ids,_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>removeSkills(ctx,ids,{...opts,dryRun:true}),()=>removeSkills(ctx,ids,opts));});
  program.command('read <id>').description('读取已安装技能的本地文件').option('--path <relative>','包内相对路径','SKILL.md').option('--project <directory>','项目范围').option('--raw','文本直接输出').action(async(id,_,cmd)=>{const data=await readSkill(optionContext(cmd),id,cmd.opts().path,cmd.opts().project);if(cmd.opts().raw&&!cmd.optsWithGlobals().json)console.log(data.content);else emit(cmd,data);});
  program.command('files <id>').description('完整文件清单与摘要').option('--project <directory>','项目范围').action(async(id,_,cmd)=>{const state=await loadState(optionContext(cmd));emit(cmd,(await getRelease(state,id,cmd.opts().project)).manifest.files);});
  program.command('status').description('本机状态，不联网').action(async(_,cmd)=>emit(cmd,await localStatus(optionContext(cmd))));
  program.command('check').description('只读比较版本，不更新文件或目录缓存').option('--project <directory>','项目范围').action(async(_,cmd)=>emit(cmd,await checkUpdates(optionContext(cmd),await mutationOptions(cmd))));
  writing(program.command('update [ids...]').description('预览后更新未固定的已安装技能')).action(async(ids,_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>updateSkills(ctx,ids,{...opts,dryRun:true}),()=>updateSkills(ctx,ids,opts));});
  for(const pinned of[true,false])writing(program.command((pinned?'pin':'unpin')+' <ids...>').description(pinned?'固定当前技能版本':'允许后续显式更新')).action(async(ids,_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>pinSkills(ctx,ids,pinned,{...opts,dryRun:true}),()=>pinSkills(ctx,ids,pinned,opts));});
  writing(program.command('rollback <id>').description('切换回保留的旧版本')).option('--version <version>','保留的版本，默认上一个').action(async(id,_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>rollbackSkill(ctx,id,cmd.opts().version,{...opts,dryRun:true}),()=>rollbackSkill(ctx,id,cmd.opts().version,opts));});
  writing(program.command('sync').description('按项目锁定版本恢复，不升级')).requiredOption('--frozen','严格恢复锁文件').action(async(_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>syncFrozen(ctx,{...opts,dryRun:true}),()=>syncFrozen(ctx,opts));});
  const agents=program.command('agents').description('同机多Agent原生目录管理');
  agents.command('list').action(async(_,cmd)=>emit(cmd,await listAgents(optionContext(cmd))));
  agents.command('detect').description('只读检测安装候选，不创建目录').action(async(_,cmd)=>emit(cmd,await listAgents(optionContext(cmd),true)));
  writing(agents.command('add <agent>').description('确认并注册原生目录')).option('--path <directory>','自定义技能根').option('--label <name>','实例显示名称').option('--mode <mode>','auto/link/copy').action(async(agent,_,cmd)=>{const ctx=optionContext(cmd),opts={...await mutationOptions(cmd),path:cmd.opts().path,label:cmd.opts().label};await mutate(cmd,()=>addAgent(ctx,agent as AgentId,{...opts,dryRun:true}),()=>addAgent(ctx,agent as AgentId,opts));});
  writing(agents.command('remove <target>').description('移除目标及自身引用，不影响其他Agent'),false).action(async(id,_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>removeAgent(ctx,id,{...opts,dryRun:true}),()=>removeAgent(ctx,id,opts));});
  agents.command('status').description('查看接入登记与原生验证证据').action(async(_,cmd)=>emit(cmd,await listEnrollments(optionContext(cmd))));
  agents.command('connect [agent]').description('生成可复制的 Agent 自助接入消息').action(async(agent,_,cmd)=>emit(cmd,connectMessage(agent as AgentId|undefined)));
  writing(agents.command('enroll <agent>').description('幂等登记并配置一个 Agent 目标')).option('--path <directory>','实际技能目录').option('--label <name>','实例显示名称').action(async(agent,_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd),extra={path:cmd.opts().path,label:cmd.opts().label};await mutate(cmd,()=>enrollAgent(ctx,agent as AgentId,{...opts,...extra,dryRun:true}),()=>enrollAgent(ctx,agent as AgentId,{...opts,...extra}));});
  agents.command('verify <target>').description('记录实际目录读取证据').action(async(id,_,cmd)=>emit(cmd,await verifyEnrolledAgent(optionContext(cmd),id)));
  agents.command('inventory <target>').description('只读扫描实际技能目录').action(async(id,_,cmd)=>{const ctx=optionContext(cmd),state=await loadState(ctx),target=state.targets[id];if(!target)fail('USAGE','未注册此 Agent 目标：'+id);emit(cmd,await scanTarget(target));});
  writing(agents.command('dedupe <target>').description('预览并在确认后替换完全重复的私有技能')).action(async(id,_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>applyDedupe(ctx,id,{dryRun:true}),()=>applyDedupe(ctx,id,{yes:opts.yes}));});
  writing(agents.command('dedupe-restore <backup>').description('从去重备份恢复私有技能'),false).action(async(backup,_,cmd)=>{const ctx=optionContext(cmd);await mutate(cmd,async()=>({backup,dryRun:true}),()=>restoreDedupe(ctx,backup));});
  program.command('connect [agent]').description('输出可复制的 SkillShelf 接入消息').action(async(agent,_,cmd)=>emit(cmd,connectMessage(agent as AgentId|undefined)));
  writing(program.command('export').description('导出无密钥选择清单或完整离线目录')).requiredOption('--output <path>','新的输出位置').option('--bundle','携带全部已装内容').option('--skill <ids...>','仅导出指定技能').action(async(_,cmd)=>{const ctx=optionContext(cmd),opts={...await mutationOptions(cmd),bundle:!!cmd.opts().bundle,ids:cmd.opts().skill};await mutate(cmd,()=>exportLibrary(ctx,cmd.opts().output,{...opts,dryRun:true}),()=>exportLibrary(ctx,cmd.opts().output,opts));});
  writing(program.command('import <path>').description('导入前核验内容，不复制其他电脑的目录配置')).action(async(path,_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>importLibrary(ctx,path,{...opts,dryRun:true}),()=>importLibrary(ctx,path,opts));});
  writing(program.command('fork <id>').description('生成独立可编辑副本')).requiredOption('--output <path>','必须是新目录').action(async(id,_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,async()=>({id,output:resolve(cmd.opts().output),managed:false}),()=>forkSkill(ctx,id,cmd.opts().output,opts.project));});
  program.command('doctor').description('本地文件、依赖与权限诊断；不调用服务商').action(async(_,cmd)=>{const data=await doctor(optionContext(cmd));emit(cmd,data);if(!data.ok)process.exitCode=5;});
  program.command('verify').description('验证所有本地文件和受管投影').action(async(_,cmd)=>{const data=await verifyInstalled(optionContext(cmd));emit(cmd,data);if(!data.ok)process.exitCode=5;});
  writing(program.command('repair').description('安全恢复中断事务'),false).requiredOption('--recover','恢复写前日志').action(async(_,cmd)=>mutate(cmd,async()=>({pending:(await localStatus(optionContext(cmd))).pendingRecovery}),()=>recoverTransactions(optionContext(cmd))));
  writing(program.command('gc').description('预览并清理无引用孤立对象，保留历史'),false).action(async(_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>garbageCollect(ctx,{dryRun:true}),()=>garbageCollect(ctx,{...opts,yes:true}));});
  const providers=program.command('providers').description('本地服务配置，不同步面板');
  providers.command('list').action(async(_,cmd)=>emit(cmd,await listProviders(optionContext(cmd))));
  const providerAdd=writing(providers.command('add').description('无参数打开向导；自动化仅支持环境变量Key'),false).option('--id <id>','本地配置ID').option('--kind <kind>','search/image/video').option('--name <name>','显示名称').option('--adapter <adapter>','协议适配器').option('--model <model>','模型ID').option('--base-url <url>','HTTPS服务根').option('--endpoint <url>','完整API地址').option('--key-env <variable>','只保存环境变量名，不是Key值').option('--default','作为该类默认资源');
  providerAdd.action(async(_,cmd)=>{const o=cmd.opts(),ctx=optionContext(cmd);if(!o.id){if(!process.stdin.isTTY||ctx.json)fail('USAGE','自动化请指定id/kind/base-url/key-env等参数');emit(cmd,await providerWizard(ctx));return;}const input:ProviderInput={id:o.id,kind:o.kind,name:o.name,adapter:o.adapter,model:o.model,baseUrl:o.baseUrl,endpoint:o.endpoint,apiKeyEnv:o.keyEnv,makeDefault:o.default};if(!o.keyEnv)fail('USAGE','自动化配置必须使用 --key-env，不接受命令行明文Key');await mutate(cmd,async()=>({provider:input,noProviderRequest:true}),()=>addProvider(ctx,input));});
  writing(providers.command('remove <id>').description('删除本机资源配置'),false).action(async(id,_,cmd)=>mutate(cmd,async()=>({id,localOnly:true}),()=>removeProvider(optionContext(cmd),id)));
  program.command('run <id> [arguments...]').description('显式执行已审核本地工具，可能调用服务商计费').option('--project <directory>','项目范围/媒体输入相对根').allowUnknownOption(true).passThroughOptions().action(async(id,args,_,cmd)=>{const ctx=optionContext(cmd),project=cmd.opts().project?await canonicalProjectPath(cmd.opts().project):undefined,r=await getRelease(await loadState(ctx),id,project);const forwarded=args[0]==='--'?args.slice(1):args;const result=await runSkill(ctx,r,forwarded,{project,capture:ctx.json});emit(cmd,result);if(typeof result==='object'&&result&&'exitCode'in result)process.exitCode=Number(result.exitCode)||0;});
  const author=program.command('author').description('创作、校验和入库本机技能包');
  author.command('list').action(async(_,cmd)=>emit(cmd,await listDrafts(optionContext(cmd))));
  author.command('create <id>').option('--description <text>','技能简介').option('--member <ids...>','多成员套件的成员 ID').action(async(id,_,cmd)=>{const o=cmd.opts(),members=o.member?.map((member:string)=>({id:member}));emit(cmd,await createDraft(optionContext(cmd),id,{description:o.description,members}));});
  author.command('validate <id>').action(async(id,_,cmd)=>emit(cmd,await validateDraft(optionContext(cmd),id)));
  writing(author.command('publish <id>').description('把已校验草稿写入本机共享库')).option('--version <version>','本地版本号').action(async(id,_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>publishDraft(ctx,id,{version:cmd.opts().version,dryRun:true}),()=>publishDraft(ctx,id,{version:cmd.opts().version,yes:opts.yes}));});
  writing(author.command('remove <id>'),false).action(async(id,_,cmd)=>{const ctx=optionContext(cmd);await mutate(cmd,()=>removeDraft(ctx,id,{dryRun:true}),()=>removeDraft(ctx,id));});
  const profiles=program.command('profiles').description('任务组合与项目偏好');
  profiles.command('list').action(async(_,cmd)=>emit(cmd,await listProfiles(optionContext(cmd))));
  writing(profiles.command('save <id>').requiredOption('--name <name>','组合显示名称').requiredOption('--packs <ids...>','完整技能包 ID').option('--description <text>','组合说明'),false).action(async(id,_,cmd)=>{const ctx=optionContext(cmd),input={id,name:cmd.opts().name,description:cmd.opts().description,packs:cmd.opts().packs};await mutate(cmd,()=>saveProfile(ctx,input,{dryRun:true}),()=>saveProfile(ctx,input));});
  writing(profiles.command('apply <id>').description('预览并应用任务组合')).action(async(id,_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>applyProfile(ctx,id,{...opts,dryRun:true}),()=>applyProfile(ctx,id,opts));});
  writing(profiles.command('remove <id>').description('删除组合定义'),false).action(async(id,_,cmd)=>mutate(cmd,async()=>({id,dryRun:true}),()=>removeProfile(optionContext(cmd),id)));
  const mcp=program.command('mcp').description('共享 MCP 定义与连接诊断');
  mcp.command('list').action(async(_,cmd)=>emit(cmd,await listMcp(optionContext(cmd))));
  mcp.command('diagnose [id]').action(async(id,_,cmd)=>emit(cmd,await diagnoseMcp(optionContext(cmd),id)));
  mcp.command('preview [target]').action(async(target,_,cmd)=>emit(cmd,await mcpConfigPreview(optionContext(cmd),target)));
  writing(mcp.command('add <id>').description('登记一个 stdio 或 HTTP MCP')).requiredOption('--transport <transport>','stdio 或 http').option('--name <name>','显示名称').option('--command <command>','stdio 命令').option('--arg <args...>','stdio 参数').option('--url <url>','HTTP MCP 地址').option('--env <refs...>','环境变量引用 KEY=VAR').action(async(id,_,cmd)=>{const o=cmd.opts(),env=Object.fromEntries((o.env||[]).map((item:string)=>{const [key,value]=item.split('=',2);return[key,value];}));await mutate(cmd,async()=>({id,transport:o.transport,dryRun:true}),()=>addMcp(optionContext(cmd),{id,name:o.name,transport:o.transport,command:o.command,args:o.arg,url:o.url,env,enabled:true}));});
  writing(mcp.command('remove <id>').description('移除共享 MCP 定义'),false).action(async(id,_,cmd)=>mutate(cmd,async()=>({id,dryRun:true}),()=>removeMcp(optionContext(cmd),id)));
  writing(mcp.command('enable <id>').description('启用 MCP'),false).action(async(id,_,cmd)=>mutate(cmd,async()=>({id,enabled:true,dryRun:true}),()=>setMcpEnabled(optionContext(cmd),id,true)));
  writing(mcp.command('disable <id>').description('停用 MCP'),false).action(async(id,_,cmd)=>mutate(cmd,async()=>({id,enabled:false,dryRun:true}),()=>setMcpEnabled(optionContext(cmd),id,false)));
  const migrate=program.command('migrate').description('旧系统只读迁移');
  writing(migrate.command('panel').description('只读导入旧Python管理的内容，不读Key')).requiredOption('--from <directory>','旧客户端home').action(async(_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>migratePanel(ctx,cmd.opts().from,{...opts,dryRun:true}),()=>migratePanel(ctx,cmd.opts().from,opts));});
  writing(migrate.command('home').description('迁移 SkillShelf 共享目录')).requiredOption('--to <directory>','新的共享目录').action(async(_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>migrateHome(ctx,cmd.opts().to,{...opts,dryRun:true}),()=>migrateHome(ctx,cmd.opts().to,opts));});
  writing(program.command('uninstall').description('导出后完整移除 SkillShelf 受管内容')).option('--keep-home','保留共享库数据').action(async(_,cmd)=>{const ctx=optionContext(cmd),opts=await mutationOptions(cmd);await mutate(cmd,()=>uninstallSkillShelf(ctx,{...opts,removeHome:!cmd.opts().keepHome,dryRun:true}),()=>uninstallSkillShelf(ctx,{...opts,removeHome:!cmd.opts().keepHome}));});
  program.command('self-update').description('检查CLI程序版本，由npm管理升级').requiredOption('--check','只读检查').action(async(_,cmd)=>{const ctx=optionContext(cmd);if(ctx.offline){emit(cmd,{current:VERSION,latest:null,channel:RELEASE_CHANNEL,offline:true});return;}const latest=await resolveNpmRelease(CLI_PACKAGE,RELEASE_CHANNEL,true);emit(cmd,{current:VERSION,latest:latest.version,channel:RELEASE_CHANNEL,command:'npm install -g '+CLI_PACKAGE+'@'+latest.version});});
  return program;
}
export async function main(argv=process.argv):Promise<void>{
  const program=buildProgram();
  try{const[major,minor]=process.versions.node.split('.').map(Number);if(major!<22||(major===22&&minor!<20))fail('DEPENDENCY','SkillShelf需要Node.js >=22.20.0');await program.parseAsync(argv);}
  catch(error){
    if((error as {code?:string}).code==='commander.helpDisplayed'||(error as {code?:string}).code==='commander.version')return;
    const code=classifyError(error);
    const message=cleanText(errorMessage(error));if(program.opts().json||argv.includes('--json'))console.log(JSON.stringify({schemaVersion:1,command:errorCommandName(program,argv),status:'error',error:{code,message}}));else console.error('SkillShelf：'+message);
    process.exitCode=exitCodes[code];
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(resolve(process.argv[1]))).href)await main();
