"""Standalone image/video execution using bundled provider protocol modules."""
import argparse
import base64
import json
from pathlib import Path
import sys
import time
import uuid
from urllib.parse import urlsplit
from direct import config, choose, request, download, file_data, image_mime, output_folder, save_json, report_error
from protocols.media_profiles import (image_resource_profile, video_resource_profile, validate_image_request,
    validate_video_request, build_image_payload, detect_openai_videos_adapter, build_openai_video_payload,
    parse_openai_video_submission, parse_openai_video_poll)
from protocols.video_protocol import (VideoResource, VideoGenerationRequest, detect_cogvideox_adapter,
    build_generation_payload, parse_submission_response, parse_poll_response)


def multipart(payload, images, mask=None):
    boundary='skillshelf-local-'+uuid.uuid4().hex
    chunks=[]
    for name,value in payload.items():
        chunks.append(('--'+boundary+'\r\nContent-Disposition: form-data; name="'+name+'"\r\n\r\n'+str(value)+'\r\n').encode())
    for index,(field,value) in enumerate([('image',v) for v in images]+([('mask',mask)] if mask else [])):
        if not value.startswith('data:image/'):
            raise ValueError('图片编辑请使用本地参考图；远程参考图请先下载到本地')
        header,encoded=value.split(',',1)
        mime=header[5:].split(';')[0]
        raw=base64.b64decode(encoded,validate=True)
        if image_mime(raw)!=mime: raise ValueError('参考图格式无效')
        if field=='mask' and mime!='image/png': raise ValueError('蒙版必须是 PNG')
        chunks.append(('--'+boundary+'\r\nContent-Disposition: form-data; name="'+field+'"; filename="reference-'+str(index)+'"\r\nContent-Type: '+mime+'\r\n\r\n').encode()+raw+b'\r\n')
    chunks.append(('--'+boundary+'--\r\n').encode())
    body=b''.join(chunks)
    if len(body)>40*1024*1024: raise ValueError('参考图合计超过大小限制')
    return body,'multipart/form-data; boundary='+boundary


def image(resource, args):
    if not args.prompt.strip(): raise ValueError('提示词不能为空')
    profile=image_resource_profile(resource['base_url'],'image',resource['model'])
    if profile is None: raise ValueError('所选模型缺少图片能力')
    references=tuple(file_data(path) for path in args.reference)
    size=args.size or profile.sizes[0]
    validate_image_request(profile,prompt=args.prompt,size=size,ratio=args.ratio,reference_images=references)
    payload=build_image_payload(profile,upstream_model=resource['model'],prompt=args.prompt,size=size,ratio=args.ratio,reference_images=references)
    for field,allowed in (('quality',profile.qualities),('output_format',profile.output_formats),('background',profile.backgrounds)):
        value=getattr(args,field)
        if value is not None:
            if value not in allowed: raise ValueError('所选模型不支持 '+field)
            payload[field]=value
    if args.background=='transparent' and args.output_format=='jpeg': raise ValueError('透明背景不能使用 JPEG')
    endpoint=resource['endpoint']
    body=content_type=None
    if args.mask and (not profile.mask or not references): raise ValueError('当前输入不支持蒙版')
    if references and profile.edit_transport=='multipart':
        if not endpoint.endswith('/images/generations'): raise ValueError('未配置图片编辑端点')
        endpoint=endpoint[:-len('generations')]+'edits'
        body,content_type=multipart(payload,references,file_data(args.mask) if args.mask else None)
    destination=output_folder(args.output)
    job=destination/'job.json'
    record={'kind':'image','resource_id':resource['id'],'model':resource['model'],'state':'submission_unknown'}
    save_json(job,record)
    print('本地任务记录：'+str(job),flush=True)
    raw=request(resource,endpoint,method='POST',data=payload if body is None else None,body=body,content_type=content_type,timeout=600)
    items=raw.get('data',[])
    if not items or not isinstance(items[0],dict): raise ValueError('服务商未返回图片')
    temporary=destination/'image.download'
    if items[0].get('b64_json'):
        content=base64.b64decode(items[0]['b64_json'],validate=True)
        if len(content)>16*1024*1024: raise ValueError('图片超过大小限制')
        temporary.write_bytes(content)
    elif items[0].get('url'):
        download(items[0]['url'],temporary,limit=16*1024*1024)
    else: raise ValueError('服务商未返回可读取的图片内容')
    with temporary.open('rb') as stream: mime=image_mime(stream.read(16))
    if not mime: raise ValueError('生成结果不是支持的图片格式，任务已提交，请勿自动重放')
    path=destination/('image.'+{'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[mime])
    temporary.rename(path)
    record.update(state='completed',file=str(path))
    save_json(job,record)
    return record


def video_submit(resource,args):
    if not args.prompt.strip(): raise ValueError('提示词不能为空')
    profile=video_resource_profile(resource['base_url'],'video',resource['model'])
    if profile is None: raise ValueError('所选模型缺少视频能力')
    size=args.size or profile.sizes[0]
    duration=args.seconds if args.seconds is not None else profile.durations[0]
    images=tuple(file_data(p) for p in args.reference)
    audios=tuple(file_data(p) for p in args.audio)
    first=file_data(args.first_frame) if args.first_frame else None
    last=file_data(args.last_frame) if args.last_frame else None
    validate_video_request(profile,prompt=args.prompt,mode=args.mode,size=size,duration=duration,aspect_ratio=args.ratio,first_frame=first,last_frame=last,images=images,audios=audios)
    specification=VideoResource(resource['base_url'],'video',resource['model'])
    if profile.adapter=='cogvideox':
        if args.seed is not None: raise ValueError('此模型不支持 seed')
        adapter=detect_cogvideox_adapter(specification)
        payload=build_generation_payload(adapter,VideoGenerationRequest(prompt=args.prompt,size=size,duration=duration,first_frame=first,last_frame=last,fps=args.fps if args.fps is not None else 30,quality=args.quality,with_audio=args.with_audio))
        endpoint=adapter.generations_url
    else:
        if args.fps or args.quality or args.with_audio is not None: raise ValueError('此模型不支持 fps/quality/with-audio')
        # Export preserves the configured endpoint, including version prefixes.
        endpoint_address=urlsplit(resource['endpoint'])
        adapter=detect_openai_videos_adapter(VideoResource('https://'+endpoint_address.netloc,'video',resource['model']),endpoint_address.path)
        if args.seed is not None and adapter.poll_style!='agnes': raise ValueError('此模型不支持 seed')
        payload=build_openai_video_payload(adapter,prompt=args.prompt,mode=args.mode,seconds=duration,size=size,aspect_ratio=args.ratio,first_frame=first,last_frame=last,images=images,audios=audios,seed=args.seed)
        endpoint=adapter.submit_url
    destination=output_folder(args.output)
    job=destination/'job.json'
    record={'kind':'video','resource_id':resource['id'],'model':resource['model'],'state':'submission_unknown'}
    save_json(job,record)
    print('本地任务记录：'+str(job),flush=True)
    raw=request(resource,endpoint,method='POST',data=payload,timeout=90)
    if profile.adapter=='cogvideox':
        task=parse_submission_response(raw)
        task_id,poll_url=task.task_id,adapter.async_result_url(task.task_id)
    else:
        task=parse_openai_video_submission(raw)
        task_id,poll_url=task.video_id,adapter.poll_url(task.video_id)
    record.update(state='submitted',task_id=task_id,poll_url=poll_url,adapter=profile.adapter)
    if profile.adapter=='openai_videos': record['content_url']=adapter.content_url(task_id)
    save_json(job,record)
    return video_wait(resource,job,args.wait)


def video_wait(resource,job,seconds):
    job=Path(job).expanduser().resolve()
    record=json.loads(job.read_text(encoding='utf-8'))
    if record.get('state')=='completed' and record.get('file') and Path(record['file']).is_file(): return record
    if not record.get('task_id'): raise ValueError('未取得服务商任务号，提交结果未知，请在服务商后台核实')
    deadline=time.monotonic()+max(0,seconds)
    while True:
        raw=request(resource,record['poll_url'])
        if record['adapter']=='cogvideox':
            task=parse_poll_response(raw,record['task_id'])
            state={'SUCCESS':'completed','FAIL':'failed','PROCESSING':'in_progress'}[task.status.value]
            url=next(iter(task.video_urls),None)
        else:
            task=parse_openai_video_poll(raw,record['task_id'])
            state,url=task.status,task.video_url
        record['state']=state
        save_json(job,record)
        if state=='failed': raise ValueError('服务商任务失败，已保留任务号，未重新提交')
        if state=='completed':
            destination=job.parent/('video-'+uuid.uuid4().hex+'.mp4')
            if url: download(url,destination)
            elif record.get('content_url'): download(record['content_url'],destination,resource=resource)
            else: raise ValueError('任务已完成但服务商未返回下载地址')
            with destination.open('rb') as stream: header=stream.read(16)
            if header[4:8]!=b'ftyp': raise ValueError('生成结果不是 MP4，请检查服务商结果；不要重新提交')
            record['file']=str(destination)
            save_json(job,record)
            return record
        if time.monotonic()>=deadline:
            record['resume_file']=str(job)
            return record
        time.sleep(min(5,max(0,deadline-time.monotonic())))


def main():
    parser=argparse.ArgumentParser(description='本地直连图片／视频服务，配置、任务、成品均在本机')
    parser.add_argument('--config',help='本地 providers.json')
    commands=parser.add_subparsers(dest='command',required=True)
    commands.add_parser('resources',help='离线查看可用模型和参数，不显示密钥')
    for kind in ('image','video'):
        command=commands.add_parser(kind,help='生成图片' if kind=='image' else '生成视频')
        command.add_argument('prompt',help='生成描述')
        command.add_argument('--resource',help='模型 ID 或名称，省略使用本地默认资源')
        command.add_argument('--size',help='尺寸或清晰度档位')
        command.add_argument('--ratio',help='宽高比')
        command.add_argument('--reference',action='append',default=[],help='参考图本地路径，可重复')
        command.add_argument('--output',help='输出根目录，默认 CLI 的 outputs 目录')
        command.add_argument('--quality',help='模型支持的质量档位')
        if kind=='image':
            command.add_argument('--mask',help='本地 PNG 蒙版')
            command.add_argument('--output-format',choices=['png','jpeg','webp'])
            command.add_argument('--background',choices=['auto','opaque','transparent'])
        else:
            command.add_argument('--mode',choices=['text','keyframe','reference'],default='text')
            command.add_argument('--seconds',type=int)
            command.add_argument('--first-frame')
            command.add_argument('--last-frame')
            command.add_argument('--audio',action='append',default=[])
            command.add_argument('--seed',type=int)
            command.add_argument('--fps',type=int)
            command.add_argument('--with-audio',action=argparse.BooleanOptionalAction,default=None)
            command.add_argument('--wait',type=int,default=600,help='本次等待秒数；超时保留任务号')
    resume=commands.add_parser('video-resume',help='继续查询本地任务记录，绝不重新提交')
    resume.add_argument('job',help='job.json 路径')
    resume.add_argument('--wait',type=int,default=600)
    args=parser.parse_args()
    settings=config(args.config)
    if args.command=='resources':
        result=[{k:v for k,v in r.items() if k not in ('api_key','api_key_env')} for r in settings['resources'] if r['kind'] in ('image','video')]
    elif args.command=='video-resume':
        record=json.loads(Path(args.job).read_text(encoding='utf-8'))
        result=video_wait(choose(settings,'video',record['resource_id']),args.job,args.wait)
    else:
        resource=choose(settings,args.command,args.resource)
        result=image(resource,args) if args.command=='image' else video_submit(resource,args)
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':
    try: main()
    except Exception as error:
        report_error(error)
        sys.exit(1)
