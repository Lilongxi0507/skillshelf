"""Standalone standard-library IO. Never calls a panel endpoint."""
import base64
from contextlib import contextmanager
import http.client
import ipaddress
import json
import os
from pathlib import Path
import socket
import ssl
import urllib.parse
import uuid


class ServiceError(ValueError):
    def __init__(self, message, status=None):
        self.status = status
        super().__init__(message)


def config(path=None):
    path = path or os.environ.get('SKILLSHELF_RUNTIME_CONFIG')
    if not path: raise ValueError('请通过 skillshelf run 启动，或用 --config 指定本地 providers.json')
    value = json.loads(Path(path).expanduser().read_text(encoding='utf-8'))
    if value.get('version') != 1 or not isinstance(value.get('resources'), list):
        raise ValueError('不支持的本地服务配置')
    for row in value['resources']:
        if not isinstance(row, dict): raise ValueError('无效的本地服务配置')
        reference = row.get('api_key_env')
        if reference:
            import re
            if not isinstance(reference, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', reference):
                raise ValueError('无效的服务商环境变量引用')
            row['api_key'] = os.environ.get(reference, '')
        for field in ('endpoint', 'base_url'):
            if row.get(field): origin(row[field])
    return value


def choose(settings, kind, identifier=None):
    rows = [row for row in settings['resources'] if row['kind'] == kind and row.get('api_key')]
    selected = identifier if identifier is not None else settings.get('defaults', {}).get(kind)
    if selected is not None:
        found = next((r for r in rows if str(r['id']) == str(selected) or r['model'] == str(selected)), None)
        if found: return found
        if identifier is not None: raise ValueError('本地配置中没有此资源，请先查看 resources')
    if not rows: raise ValueError('未配置此类服务，请先使用 skillshelf providers 配置服务')
    return rows[0]


def origin(url):
    address = urllib.parse.urlsplit(url)
    if address.scheme != 'https' or not address.hostname or address.username or address.password or address.fragment or address.port not in (None,443):
        raise ValueError('服务及媒体地址必须是无凭据的 HTTPS 地址')
    return address.hostname.lower(), 443


class PinnedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        addresses = list(dict.fromkeys(row[4][0] for row in socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)))
        if not addresses or any(not ipaddress.ip_address(ip).is_global for ip in addresses):
            raise ValueError('拒绝访问本地或私有网络地址')
        # Connect to the validated IP, but verify the original provider hostname.
        raw = socket.create_connection((addresses[0], self.port), timeout=self.timeout)
        try: self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


@contextmanager
def response(url, *, method='GET', body=None, headers=None, timeout=60):
    hostname, port = origin(url)
    address = urllib.parse.urlsplit(url)
    connection = PinnedHTTPS(hostname, port, timeout=timeout, context=ssl.create_default_context())
    try:
        connection.request(method, urllib.parse.urlunsplit(('', '', address.path or '/', address.query, '')), body=body, headers=headers or {})
        result = connection.getresponse()
        yield result
    except (OSError, http.client.HTTPException):
        raise ServiceError('服务连接中断或超时；生成请求结果可能未知，请勿自动重复提交') from None
    finally: connection.close()


def auth(resource, url):
    if origin(url) != origin(resource['endpoint']): raise ValueError('拒绝向其他服务发送凭据')
    return {'X-Subscription-Token':resource['api_key']} if resource['adapter']=='brave' else {'Authorization':'Bearer '+resource['api_key']}


def request(resource, url=None, *, method='GET', data=None, body=None, content_type=None, timeout=60):
    url = url or resource['endpoint']
    headers = {'Accept':'application/json', **auth(resource,url)}
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        content_type = 'application/json'
    if content_type: headers['Content-Type'] = content_type
    with response(url, method=method, body=body, headers=headers, timeout=timeout) as result:
        if result.status >= 300:
            raise ServiceError('服务商返回 HTTP '+str(result.status)+'；未自动重试', result.status)
        raw = result.read(24*1024*1024+1)
        if len(raw)>24*1024*1024: raise ServiceError('服务响应超过大小限制')
        try: return json.loads(raw)
        except (ValueError, UnicodeError): raise ServiceError('服务商未返回有效 JSON') from None


def download(url, destination, *, resource=None, limit=256*1024*1024):
    # Signed result URLs get no credentials. Provider content routes are explicit.
    headers = auth(resource,url) if resource else {}
    current = url
    for _ in range(5):
        with response(current, headers=headers, timeout=180) as result:
            if result.status in (301,302,303,307,308):
                if resource: raise ServiceError('认证下载地址发生重定向，未发送凭据')
                current=urllib.parse.urljoin(current,result.getheader('Location',''))
                origin(current)
                continue
            if result.status != 200: raise ServiceError('媒体下载失败 HTTP '+str(result.status), result.status)
            total=0
            created=False
            try:
                with Path(destination).open('xb') as stream:
                    created=True
                    while block:=result.read(65536):
                        total+=len(block)
                        if total>limit: raise ServiceError('媒体文件超过大小限制')
                        stream.write(block)
                if not total: raise ServiceError('媒体文件为空')
                return
            except BaseException:
                if created: Path(destination).unlink(missing_ok=True)
                raise
    raise ServiceError('媒体下载重定向过多')


def save_json(path, value):
    temporary=Path(path).with_name('.'+Path(path).name+'.'+uuid.uuid4().hex)
    try:
        descriptor=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(descriptor,'w',encoding='utf-8') as stream: json.dump(value,stream,ensure_ascii=False,indent=2)
        os.replace(temporary,path)
    finally: temporary.unlink(missing_ok=True)


def output_folder(value=None):
    root=Path(value or os.environ.get('SKILLSHELF_OUTPUTS') or Path.cwd()/'outputs').expanduser().resolve()
    skill_root=Path(__file__).resolve().parents[1]
    store_root=skill_root.parent.parent if skill_root.name == 'skill' and skill_root.parent.parent.name == 'store' else skill_root
    if root == store_root or store_root in root.parents:
        raise ValueError('成品目录必须在只读技能 store 外')
    root.mkdir(parents=True,exist_ok=True)
    destination=root/uuid.uuid4().hex
    destination.mkdir(mode=0o700)
    return destination


def file_data(value):
    if value.startswith('https://'):
        origin(value)
        return value
    source=Path(value).expanduser()
    if source.stat().st_size>8*1024*1024: raise ValueError('参考文件超过 8 MiB')
    raw=source.read_bytes()
    mime=image_mime(raw)
    if not mime:
        mime={'.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4'}.get(source.suffix.lower())
    if not mime: raise ValueError('参考文件格式无法识别')
    return 'data:'+mime+';base64,'+base64.b64encode(raw).decode()


def image_mime(raw):
    if raw.startswith(b'\x89PNG\r\n\x1a\n'): return 'image/png'
    if raw.startswith(b'\xff\xd8\xff'): return 'image/jpeg'
    if raw[:4]==b'RIFF' and raw[8:12]==b'WEBP': return 'image/webp'
    return None


def report_error(error):
    if isinstance(error, ServiceError) and isinstance(error.status, int):
        print('服务商返回 HTTP '+str(error.status)+'；未自动重试')
    else:
        print('操作未完成，请检查本地 providers、参数和文件；未输出配置或远端响应，未自动重复提交')
