"""Direct Tavily/Brave search; standard library only."""
import argparse
import json
import sys
import urllib.parse
from direct import config, request, ServiceError, report_error


def search(settings, query, *, engine='auto', intent='research', count=5):
    if not query.strip() or len(query)>400 or not 1<=count<=10: raise ValueError('查询需 1–400 字，数量需 1–10')
    rows={}
    for row in settings['resources']:
        if row['kind']=='search' and row['adapter'] in {'tavily','brave'} and row.get('api_key'):
            if row['adapter'] not in rows or row['id']==settings.get('defaults',{}).get('search'):
                rows[row['adapter']]=row
    order=[engine] if engine!='auto' else (['brave','tavily'] if intent=='lookup' else ['tavily','brave'])
    available=[item for item in order if item in rows]
    if not available: raise ValueError('本地没有所需搜索引擎的配置，请使用 skillshelf providers 配置服务')
    for index,name in enumerate(available):
        resource=rows[name]
        try:
            if name=='brave':
                raw=request(resource,resource['endpoint']+'?'+urllib.parse.urlencode({'q':query,'count':count}))
                items=raw.get('web',{}).get('results',[])
                results=[{'title':x.get('title',''),'url':x.get('url',''),'content':x.get('description','')} for x in items]
                answer=None
            else:
                raw=request(resource,method='POST',data={'query':query,'max_results':count,'search_depth':'basic','include_answer':True})
                results=[{key:x.get(key,'') for key in ('title','url','content')} for x in raw.get('results',[])]
                answer=raw.get('answer')
            return {'provider':name,'answer':answer,'results':results[:count],'execution':'local-direct'}
        except ServiceError as error:
            if error.status not in (502,503,504) or index+1==len(available): raise


def main():
    parser=argparse.ArgumentParser(description='本地直连搜索：精确查找优先 Brave，主题研究优先 Tavily')
    parser.add_argument('query',help='搜索内容')
    parser.add_argument('--config',help='本地服务配置文件')
    parser.add_argument('--engine',choices=['auto','tavily','brave'],default='auto',help='指定搜索引擎')
    parser.add_argument('--intent',choices=['research','lookup'],default='research',help='research 主题调研；lookup 官网和文档定位')
    parser.add_argument('--count',type=int,default=5,help='结果数量，1–10')
    args=parser.parse_args()
    print(json.dumps(search(config(args.config),args.query,engine=args.engine,intent=args.intent,count=args.count),ensure_ascii=False,indent=2))


if __name__=='__main__':
    try: main()
    except Exception as error:
        report_error(error)
        sys.exit(1)
