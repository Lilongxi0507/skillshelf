import * as p from '@clack/prompts';
import pc from 'picocolors';
import { resolve } from 'node:path';
import type { Context, CatalogEntry, AgentId } from '../types.js';
import { loadCatalog } from '../catalog/catalog.js';
import { loadState } from '../store/state.js';
import { detectAgents, resolveAgentTarget, agentHints } from '../agents/agents.js';
import { addAgent, checkUpdates, doctor, installSkills, listSkills, localStatus, removeSkills, rollbackSkill, toggleSkills, updateSkills } from '../manager.js';
import { addProvider, listProviders, removeProvider, type ProviderInput } from '../runtime/runtime.js';
import { exportLibrary, importLibrary } from '../commands/portable.js';
import { SkillShelfError, errorMessage, fail } from '../errors.js';
import { formatResult } from './format.js';

export function cleanText(value:unknown):string{return String(value).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');}
function answer<T>(value:T):Exclude<T,symbol>{if(p.isCancel(value))throw new SkillShelfError('CANCELLED','操作已取消');return value as Exclude<T,symbol>;}
export function display(value:unknown,title='结果'):void{p.note(cleanText(formatResult(value)),title);}
export async function confirmation(message:string):Promise<boolean>{return answer(await p.confirm({message:cleanText(message),active:'确认',inactive:'取消',initialValue:false}));}
export async function providerWizard(ctx:Context):Promise<unknown>{
  const kind=answer(await p.select({message:'服务用途',options:[{value:'search',label:'联网搜索'},{value:'image',label:'图片生成'},{value:'video',label:'视频生成'}]}))as ProviderInput['kind'];
  const id=answer(await p.text({message:'本地配置编号（小写字母/数字/连字符）',validate:v=>/^[a-z0-9][a-z0-9-]*$/.test(v||'')?undefined:'请输入有效编号'}));
  const name=answer(await p.text({message:'显示名称',defaultValue:id}));
  const adapter=answer(await p.text({message:kind==='search'?'适配器：tavily 或 brave':'适配器（如 openai_images / agnes_videos / cogvideox）',validate:v=>v?undefined:'不能为空'}));
  const baseUrl=answer(await p.text({message:'服务商 HTTPS 根地址',placeholder:'https://api.example.com',validate:v=>{try{const u=new URL(v||'');return u.protocol==='https:'?undefined:'须使用HTTPS';}catch{return'地址无效';}}}));
  const endpoint=answer(await p.text({message:'完整 API endpoint',placeholder:baseUrl+'/v1/...',validate:v=>v?undefined:'不能为空'}));
  const model=kind==='search'?'search':answer(await p.text({message:'模型 ID',validate:v=>v?undefined:'不能为空'}));
  const credentialMode=answer(await p.select({message:'密钥来源',options:[{value:'env',label:'环境变量（推荐）'},{value:'file',label:'本机私有保存（明文，仅当前用户）'}]}));
  const input:ProviderInput={id,kind,name,adapter,baseUrl,endpoint,model,makeDefault:true};
  if(credentialMode==='env')input.apiKeyEnv=answer(await p.text({message:'环境变量名',placeholder:'TAVILY_API_KEY',validate:v=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(v||'')?undefined:'变量名无效'}));
  else{if(!await confirmation('确认把此Key仅保存在本机私有配置？不会上传、导出或加入技能包。'))return{cancelled:true};input.apiKey=answer(await p.password({message:'输入Key（不回显）'}));input.allowPlaintext=true;}
  return addProvider(ctx,input);
}
async function selectTargets(ctx:Context,project?:string):Promise<string[]>{
  const state=await loadState(ctx),scope=project?resolve(project):'global';const registered=Object.values(state.targets).filter(t=>t.scope===scope);
  const detected=await detectAgents();
  const choices=registered.map(t=>({value:t.id,label:t.label,hint:t.path}));
  for(const t of detected)if(!registered.some(r=>r.agent===t.agent))choices.push({value:t.agent,label:t.label,hint:'检测到 · 安装前确认路径'});
  for(const agent of['claude-code','codex','opencode','dsh','cursor','hermes','universal']as const)if(!choices.some(c=>c.value===agent)&&!registered.some(t=>t.agent===agent))choices.push({value:agent,label:agent,hint:'手动选择'});
  return answer(await p.multiselect({message:'选择共享技能的 Agent（空选只下载到本机仓库）',options:choices,required:false}));
}
export async function installWizard(ctx:Context,setup=false):Promise<void>{
  const catalog=await loadCatalog(ctx),state=await loadState(ctx);
  const scope=answer(await p.select({message:'安装范围',options:[{value:'global',label:'全局共享技能库（推荐）',hint:'同一系统用户的多个Agent共用'},{value:'project',label:'当前项目',hint:'固定项目版本，不改变全局'}]}));
  const project=scope==='project'?resolve(answer(await p.text({message:'项目目录',defaultValue:process.cwd()}))):undefined;
  const category=answer(await p.select({message:'浏览分类',options:[{value:'',label:'全部分类'},...catalog.categories.map(c=>({value:c.id,label:c.title}))]}));
  const entries=catalog.skills.filter(e=>!category||e.category===category);
  const selected=answer(await p.autocompleteMultiselect({message:'搜索并选择技能 · 空格多选，回车确认',options:entries.map(e=>({value:e.id,label:cleanText(e.title),hint:cleanText(`${e.id} · ${e.fileCount}文件 · ${e.status}${state.selections[e.id]?' · 已安装':''}`)})),required:true}));
  const targets=await selectTargets(ctx,project);
  const preview=await installSkills(ctx,selected,{agents:targets,project,dryRun:true});
  display(preview,'完整包与目标预览');
  p.log.info('共享目录可能同时被其他兼容Agent发现；不会自动重启会话或运行技能脚本。');
  if(!await confirmation('确认下载完整技能并接入以上目标？'))return;
  const spinner=p.spinner();spinner.start('下载、逐文件校验并接入…');
  try{const result=await installSkills(ctx,selected,{agents:targets,project,yes:true});spinner.stop('完整技能已保存到本机');display(result,'安装结果');}catch(e){spinner.stop('安装未完成');throw e;}
}
export async function menu(ctx:Context):Promise<void>{
  if(!process.stdin.isTTY||!process.stdout.isTTY){console.log('SkillShelf：请运行 skillshelf --help 查看命令；交互菜单需要终端。');return;}
  p.updateSettings({messages:{cancel:'已取消',error:'操作未完成'}});
  p.intro(pc.cyan('SkillShelf')+'  个人精选 · 本地共享');
  p.log.info('目录浏览与已安装技能使用本地数据；不依赖云面板。');
  for(;;){
    try{
      const state=await loadState(ctx);const choice=answer(await p.select({message:`全局库 ${Object.keys(state.selections).length} 项 · ${Object.keys(state.targets).length} 个Agent目标`,options:[
        {value:'install',label:'浏览与安装技能'},{value:'installed',label:'已安装技能'},{value:'agents',label:'Agent 接入管理'},
        {value:'updates',label:'检查更新与回滚'},{value:'portable',label:'导入 / 导出'},{value:'providers',label:'本地服务配置'},
        {value:'doctor',label:'诊断与校验'},{value:'exit',label:'退出'}]}));
      if(choice==='exit')break;
      if(choice==='install')await installWizard(ctx);
      if(choice==='installed'){
        display(await localStatus(ctx),'本机安装状态');const ids=Object.keys(state.selections);if(ids.length){const action=answer(await p.select({message:'技能操作',options:[{value:'back',label:'返回'},{value:'remove',label:'卸载全局选择与受管投影（保留历史内容）'},{value:'disable',label:'停用指定Agent中的技能'},{value:'enable',label:'接入其他Agent'}]}));if(action!=='back'){const selected=answer(await p.multiselect({message:'选择技能',options:ids.map(id=>({value:id,label:id})),required:true}));const agents=action==='remove'?undefined:await selectTargets(ctx);if(await confirmation('确认执行？只修改SkillShelf管理的内容。'))display(action==='remove'?await removeSkills(ctx,selected,{yes:true}):await toggleSkills(ctx,selected,action==='enable',{agents,yes:true}));}}
      }
      if(choice==='agents'){
        display(Object.values(state.targets).map(t=>({...t,hints:agentHints(t)})),'已注册Agent');
        const agent=answer(await p.select({message:'新增目标或返回',options:[{value:'back',label:'返回'},...(['claude-code','codex','opencode','dsh','cursor','hermes','universal','custom']as const).map(id=>({value:id,label:id}))]}));
        if(agent!=='back'){const path=answer(await p.text({message:'自定义技能目录（留空使用原生默认）',validate:v=>agent==='custom'&&!v?'自定义Agent必须指定目录':undefined}));const target=await resolveAgentTarget(agent as AgentId,{path:path||undefined});display(target,'目标预览');if(await confirmation('确认注册此目标？注册本身不安装技能。'))display(await addAgent(ctx,agent as AgentId,{path:path||undefined}));}
      }
      if(choice==='updates'){
        const action=answer(await p.select({message:'版本管理',options:[{value:'check',label:'只读检查更新'},{value:'update',label:'预览并更新未固定技能'},{value:'rollback',label:'回滚已保留版本'},{value:'back',label:'返回'}]}));
        if(action==='check')display(await checkUpdates(ctx));
        if(action==='update'){display(await checkUpdates(ctx),'更新预览');if(await confirmation('确认更新未固定的已安装技能？'))display(await updateSkills(ctx,[],{yes:true}));}
        if(action==='rollback'&&Object.keys(state.selections).length){const id=answer(await p.select({message:'选择技能',options:Object.keys(state.selections).map(id=>({value:id,label:id}))}));display(await rollbackSkill(ctx,id,undefined,{dryRun:true}));if(await confirmation('确认切换到保留的上一个版本？'))display(await rollbackSkill(ctx,id,undefined,{yes:true}));}
      }
      if(choice==='portable'){
        const action=answer(await p.select({message:'跨电脑迁移（不含密钥）',options:[{value:'bundle',label:'导出完整已安装技能'},{value:'export',label:'只导出选择清单'},{value:'import',label:'导入清单或完整目录'},{value:'back',label:'返回'}]}));
        if(action!=='back'){const path=answer(await p.text({message:action==='import'?'输入导入文件/目录':'输入新的导出文件/目录',validate:v=>v?undefined:'路径不能为空'}));if(await confirmation('确认执行？导入不会复制其他电脑的Agent绝对路径。'))display(action==='import'?await importLibrary(ctx,path,{yes:true}):await exportLibrary(ctx,path,{bundle:action==='bundle',yes:true}));}
      }
      if(choice==='providers'){
        display(await listProviders(ctx),'本地配置（不显示密钥）');const action=answer(await p.select({message:'服务配置',options:[{value:'add',label:'添加本地服务商'},{value:'remove',label:'删除本地配置'},{value:'back',label:'返回'}]}));if(action==='add')display(await providerWizard(ctx));if(action==='remove'){const id=answer(await p.text({message:'要删除的配置ID'}));if(await confirmation('只删除本机配置，确认？'))display(await removeProvider(ctx,id));}
      }
      if(choice==='doctor')display(await doctor(ctx),'本地诊断（不发计费请求）');
    }catch(e){if(e instanceof SkillShelfError&&e.code==='CANCELLED'){p.log.info('已取消，返回菜单');continue;}p.log.error(cleanText(errorMessage(e)));}
  }
  p.outro('本地技能保持可用，再见。');
}
