import type { CatalogEntry } from '../types.js';
const statuses:Record<string,string>={recommended:'推荐',stable:'稳定',legacy:'旧版兼容',experimental:'实验'};
export function humanBytes(value:number):string{if(value<1024)return value+' B';if(value<1024*1024)return (value/1024).toFixed(1)+' KiB';return(value/1024/1024).toFixed(1)+' MiB';}
function rows(value:unknown):Record<string,unknown>[] {return Array.isArray(value)?value.filter(x=>x&&typeof x==='object')as Record<string,unknown>[]:[];}
function text(value:unknown):string{return value===undefined||value===null?'':String(value);}
function section(title:string,items:string[]):string{return title+'\n'+(items.length?items.join('\n'):'  暂无');}
/** Compact human output; the separate --json envelope retains all machine fields. */
export function formatResult(value:unknown):string{
  if(typeof value==='string')return value;
  if(!value||typeof value!=='object')return String(value);
  if(Array.isArray(value))return value.map(item=>formatResult(item)).join('\n\n');
  const v=value as Record<string,unknown>;
  if('skills'in v&&Array.isArray(v.skills)){
    const skills=rows(v.skills);const heading=(v.dryRun?'安装预览':'精选目录')+(v.catalogVersion?' · '+v.catalogVersion:'')+(v.scope?' · '+v.scope:'');
    return section(heading,skills.map(s=>'  '+text(s.title||s.id)+'  '+text(s.version)+(s.status?' · '+(statuses[text(s.status)]||s.status):'')+'\n    '+text(s.id)+(s.fileCount||s.files?' · '+text(s.fileCount||s.files)+' 个文件':'')+(s.unpackedSize||s.bytes?' · '+humanBytes(Number(s.unpackedSize||s.bytes)):'')+(s.installed?' · 已安装':'')+(s.description?'\n    '+s.description:'')))+(v.targets?'\n\n'+section('接入目标',rows(v.targets).map(t=>'  '+text(t.label||t.id)+'  ['+text(t.mode)+']\n    '+text(t.path))):'')+(v.downloadOnly?'\n\n只保存完整包，不接入Agent。':'')+(v.dryRun?'\n\n此步尚未写入文件。':'');
  }
  if('resources'in v){return section('本机服务配置',rows(v.resources).map(r=>'  '+text(r.name||r.id)+' · '+text(r.kind)+' · '+text(r.adapter)+(r.isDefault?' · 默认':'')+'\n    '+text(r.baseUrl)+'\n    '+text(r.model)+' · Key：'+text((r.key as Record<string,unknown>)?.source)+((r.key as Record<string,unknown>)?.env?' '+text((r.key as Record<string,unknown>).env):'')));}
  if('updates'in v){return section('版本检查'+(v.offline?' · 本地目录':' · 最新目录'),rows(v.updates).map(r=>'  '+text(r.id)+'  '+text(r.from)+' → '+text(r.to)+(r.pinned?' · 已固定，不更新':'')))+(rows(v.updates).length?'':'\n已安装技能与所比较的目录一致。');}
  if('home'in v&&'generation'in v){return'本机技能库\n  '+text(v.home)+'\n  状态代际 '+text(v.generation)+'\n\n'+section('全局已安装',rows(v.installed).map(r=>'  '+text(r.id)+' · '+text(r.version)+(r.pinned?' · 已固定':'')))+'\n\n'+section('Agent目标',rows(v.targets).map(r=>'  '+text(r.label||r.id)+'\n    '+text(r.path)))+'\n\n项目 '+rows(v.projects).length+' 个 · 受管投影 '+rows(v.projections).length+' 个'+(Array.isArray(v.pendingRecovery)&&v.pendingRecovery.length?'\n存在中断事务，请运行 repair --recover':'');}
  if('registered'in v){return section('已注册Agent目标',rows(v.registered).map(t=>'  '+text(t.label)+'  ['+text(t.mode)+']\n    '+text(t.id)+'\n    '+text(t.path)))+(v.detected?'\n\n'+section('检测候选（不代表已加载）',rows(v.detected).map(t=>'  '+text(t.label)+'\n    '+text(t.path))):'');}
  if('title'in v&&'useWhen'in v){const e=v as unknown as CatalogEntry;return e.title+' · '+(statuses[e.status]||e.status)+'\n'+e.id+' @ '+e.version+'\n\n'+e.description+'\n\n适用场景\n  '+e.useWhen+'\n\n示例\n'+e.examples.map(s=>'  • '+s).join('\n')+'\n\n完整内容\n  '+e.fileCount+' 文件 · '+humanBytes(e.unpackedSize)+' · '+e.license+'\n  '+e.packageName+'\n  '+(e.source.repository||'第一方授权快照')+(e.source.commit?' @ '+e.source.commit.slice(0,12):'')+'\n  运行方式：'+e.runtime.kind+(e.runtime.requiresNetwork?' · 需要网络':' · 安装后可本地读取');}
  return JSON.stringify(value,null,2);
}
