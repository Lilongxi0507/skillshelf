"""Strict CogVideoX asynchronous video-generation protocol adapter.

This module only constructs and parses the provider protocol. In particular,
``video_result[].url`` remains an untrusted string: callers must perform their
own SSRF-safe URL validation before fetching any generated video.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import json
import re
from typing import Any, Mapping, Protocol
from urllib.parse import quote, urlsplit, urlunsplit

COGVIDEOX_PROVIDER_HOST = "open.bigmodel.cn"
COGVIDEOX_V4_PATH_SEGMENT = "v4"
DEFAULT_DURATION_SECONDS = 5
MAX_PROMPT_LENGTH = 512
MAX_TASK_ID_LENGTH = 128
MAX_RESPONSE_BYTES = 1024 * 1024
V3_SIZES = frozenset({"1280x720", "720x1280", "1024x1024", "1920x1080", "1080x1920", "2048x1080", "3840x2160"})
ALLOWED_SIZES = frozenset({"720x480", "1024x1024", "1280x960", "960x1280", "1920x1080", "1080x1920", "2048x1080", "3840x2160"})
ALLOWED_FPS = frozenset({30, 60})
_TASK_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")

class VideoProtocolError(ValueError):
    """Base exception for invalid protocol configuration or data."""

class UnsupportedVideoProvider(VideoProtocolError):
    """The configured resource cannot use this provider adapter."""

class UnsupportedVideoRequest(VideoProtocolError):
    """The request is outside the documented provider contract."""

class MalformedVideoResponse(VideoProtocolError):
    """The upstream JSON did not satisfy the expected response contract."""

class UpstreamVideoHTTPError(VideoProtocolError):
    """The upstream returned a non-successful HTTP response."""
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        super().__init__(f"video provider returned HTTP {status_code}")

class CogVideoXModel(str, Enum):
    FLASH = "cogvideox-flash"
    V2 = "cogvideox-2"
    V3 = "cogvideox-3"

class VideoTaskStatus(str, Enum):
    PROCESSING = "PROCESSING"
    SUCCESS = "SUCCESS"
    FAIL = "FAIL"

@dataclass(frozen=True, slots=True)
class VideoResource:
    """The non-secret resource attributes required to select an adapter."""
    provider_base_url: str
    kind: str
    upstream_model_id: str

@dataclass(frozen=True, slots=True)
class CogVideoXAdapter:
    """A validated CogVideoX V4 endpoint configuration."""
    base_url: str
    upstream_model: CogVideoXModel
    @property
    def generations_url(self) -> str:
        return _append_provider_path(self.base_url, "videos/generations")
    def async_result_url(self, task_id: str) -> str:
        return _append_provider_path(self.base_url, f"async-result/{quote(validate_task_id(task_id), safe='')}")

@dataclass(frozen=True, slots=True)
class VideoGenerationRequest:
    prompt: str
    size: str
    fps: int = 30
    duration: int | None = DEFAULT_DURATION_SECONDS
    first_frame: str | None = None
    last_frame: str | None = None
    quality: str | None = None
    with_audio: bool | None = None

@dataclass(frozen=True, slots=True)
class VideoTaskSubmission:
    task_id: str
    status: VideoTaskStatus

@dataclass(frozen=True, slots=True)
class VideoTaskResult:
    task_id: str
    status: VideoTaskStatus
    # Tainted provider strings: the integration layer must SSRF-validate before fetching.
    video_urls: tuple[str, ...] = ()
    failure_message: str | None = None

class _AsyncResponse(Protocol):
    status_code: int
    content: bytes

class _AsyncHTTPClient(Protocol):
    async def post(self, url: str, **kwargs: Any) -> _AsyncResponse: ...
    async def get(self, url: str, **kwargs: Any) -> _AsyncResponse: ...

@dataclass(slots=True)
class CogVideoXClient:
    """Small async transport wrapper using an injected httpx-compatible client."""
    adapter: CogVideoXAdapter
    http_client: _AsyncHTTPClient
    api_key: str = field(repr=False)
    timeout: float = 60.0
    @property
    def _headers(self) -> dict[str, str]:
        if not isinstance(self.api_key, str) or not self.api_key:
            raise UnsupportedVideoRequest("video provider API key is required")
        return {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"}
    async def submit(self, request: VideoGenerationRequest) -> VideoTaskSubmission:
        response = await self.http_client.post(self.adapter.generations_url, headers=self._headers, json=build_generation_payload(self.adapter, request), timeout=self.timeout)
        return parse_submission_response(_response_json(response))
    async def poll(self, task_id: str) -> VideoTaskResult:
        task_id = validate_task_id(task_id)
        response = await self.http_client.get(self.adapter.async_result_url(task_id), headers=self._headers, timeout=self.timeout)
        return parse_poll_response(_response_json(response), task_id)

def detect_cogvideox_adapter(resource: VideoResource) -> CogVideoXAdapter | None:
    """Return an adapter only for documented BigModel V4 video resources."""
    if not isinstance(resource, VideoResource) or not isinstance(resource.kind, str) or resource.kind.strip().lower() != "video":
        return None
    try:
        model = CogVideoXModel(resource.upstream_model_id.strip().lower())
        base_url = _normalise_cogvideox_base_url(resource.provider_base_url)
    except (AttributeError, TypeError, ValueError):
        return None
    return CogVideoXAdapter(base_url=base_url, upstream_model=model)

def require_cogvideox_adapter(resource: VideoResource) -> CogVideoXAdapter:
    adapter = detect_cogvideox_adapter(resource)
    if adapter is None:
        raise UnsupportedVideoProvider("only open.bigmodel.cn V4 CogVideoX video resources are supported")
    return adapter

def normalise_generation_request(request: VideoGenerationRequest) -> VideoGenerationRequest:
    if not isinstance(request, VideoGenerationRequest):
        raise UnsupportedVideoRequest("video generation request is invalid")
    if not isinstance(request.prompt, str):
        raise UnsupportedVideoRequest("prompt must be text")
    prompt = request.prompt.strip()
    if not prompt:
        raise UnsupportedVideoRequest("prompt must not be blank")
    if len(prompt) > MAX_PROMPT_LENGTH:
        raise UnsupportedVideoRequest(f"prompt must be at most {MAX_PROMPT_LENGTH} characters")
    if any(ord(char) < 32 and char not in "\n\t" for char in prompt):
        raise UnsupportedVideoRequest("prompt contains unsupported control characters")
    if not isinstance(request.size, str) or request.size not in (ALLOWED_SIZES | V3_SIZES):
        raise UnsupportedVideoRequest("size is not supported by CogVideoX")
    if isinstance(request.fps, bool) or not isinstance(request.fps, int) or request.fps not in ALLOWED_FPS:
        raise UnsupportedVideoRequest("fps must be 30 or 60")
    # Flash's documented schema has no duration property. Preserve the panel's
    # default while rejecting attempts to change it, and never send it upstream.
    if request.duration is not None and (isinstance(request.duration, bool) or not isinstance(request.duration, int) or request.duration not in {5, 10}):
        raise UnsupportedVideoRequest("CogVideoX does not support a custom duration")
    if request.quality is not None and request.quality not in {"speed", "quality"}:
        raise UnsupportedVideoRequest("unsupported quality")
    if request.with_audio is not None and not isinstance(request.with_audio, bool):
        raise UnsupportedVideoRequest("with_audio must be boolean")
    return VideoGenerationRequest(prompt=prompt, size=request.size, fps=int(request.fps), duration=request.duration,
                                  first_frame=request.first_frame, last_frame=request.last_frame,
                                  quality=request.quality, with_audio=request.with_audio)

def build_generation_payload(adapter: CogVideoXAdapter, request: VideoGenerationRequest) -> dict[str, str | int]:
    if not isinstance(adapter, CogVideoXAdapter):
        raise UnsupportedVideoProvider("CogVideoX adapter is required")
    normalized = normalise_generation_request(request)
    allowed_sizes = V3_SIZES if adapter.upstream_model is CogVideoXModel.V3 else ALLOWED_SIZES
    if normalized.size not in allowed_sizes:
        raise UnsupportedVideoRequest("size is not supported by this CogVideoX model")
    payload = {"model": adapter.upstream_model.value, "prompt": normalized.prompt, "size": normalized.size, "fps": normalized.fps}
    if adapter.upstream_model is not CogVideoXModel.V3 and (normalized.last_frame or normalized.duration not in (None, 5)):
        raise UnsupportedVideoRequest("this CogVideoX model does not support last-frame or custom duration")
    if normalized.last_frame and not normalized.first_frame:
        raise UnsupportedVideoRequest("CogVideoX-3 last-frame control also needs a first frame")
    if normalized.first_frame:
        payload["image_url"] = ([normalized.first_frame, normalized.last_frame] if normalized.last_frame else normalized.first_frame)
    if adapter.upstream_model is CogVideoXModel.V3 and normalized.duration is not None:
        payload["duration"] = normalized.duration
    if normalized.quality is not None:
        payload["quality"] = normalized.quality
    if normalized.with_audio is not None:
        payload["with_audio"] = normalized.with_audio
    return payload

def validate_task_id(value: object) -> str:
    if not isinstance(value, str) or not _TASK_ID_RE.fullmatch(value):
        raise MalformedVideoResponse("video task id is invalid")
    return value

def parse_submission_response(payload: object) -> VideoTaskSubmission:
    data = _json_object(payload)
    return VideoTaskSubmission(task_id=validate_task_id(data.get("id")), status=_task_status(data.get("task_status")))

def parse_poll_response(payload: object, task_id: str) -> VideoTaskResult:
    task_id = validate_task_id(task_id)
    data = _json_object(payload)
    response_id = data.get("id")
    if response_id is not None and validate_task_id(response_id) != task_id:
        raise MalformedVideoResponse("video result task id does not match request")
    status = _task_status(data.get("task_status"))
    if status is VideoTaskStatus.SUCCESS:
        return VideoTaskResult(task_id=task_id, status=status, video_urls=_video_urls(data))
    if status is VideoTaskStatus.FAIL:
        return VideoTaskResult(task_id=task_id, status=status, failure_message=_failure_message(data))
    return VideoTaskResult(task_id=task_id, status=status)

def _normalise_cogvideox_base_url(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("provider base URL is invalid")
    parsed = urlsplit(value.strip())
    if parsed.scheme.lower() != "https" or parsed.username or parsed.password:
        raise ValueError("provider base URL is invalid")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("provider base URL is invalid") from exc
    if parsed.hostname is None or parsed.hostname.lower().rstrip(".") != COGVIDEOX_PROVIDER_HOST:
        raise ValueError("provider host is unsupported")
    if port not in (None, 443) or parsed.query or parsed.fragment:
        raise ValueError("provider base URL is invalid")
    path_parts = [part for part in parsed.path.split("/") if part]
    if not path_parts or path_parts[-1].lower() != COGVIDEOX_V4_PATH_SEGMENT or any(part in {".", ".."} or "%" in part for part in path_parts):
        raise ValueError("provider base URL must end in /v4")
    return urlunsplit(("https", COGVIDEOX_PROVIDER_HOST, "/" + "/".join(path_parts), "", ""))

def _append_provider_path(base_url: str, suffix: str) -> str:
    # Inputs are constants or validated IDs; urljoin could discard the V4 path.
    return f"{base_url.rstrip('/')}/{suffix.lstrip('/')}"

def _json_object(payload: object) -> Mapping[str, Any]:
    if not isinstance(payload, Mapping):
        raise MalformedVideoResponse("video provider response must be a JSON object")
    return payload

def _task_status(value: object) -> VideoTaskStatus:
    if not isinstance(value, str):
        raise MalformedVideoResponse("video task_status is missing or invalid")
    try:
        return VideoTaskStatus(value)
    except ValueError as exc:
        raise MalformedVideoResponse("video task_status is unknown") from exc

def _video_urls(data: Mapping[str, Any]) -> tuple[str, ...]:
    entries = data.get("video_result")
    if not isinstance(entries, list) or not entries:
        raise MalformedVideoResponse("successful video response has no video_result")
    urls: list[str] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise MalformedVideoResponse("video_result entries must be objects")
        url = entry.get("url")
        if not isinstance(url, str) or not url or len(url) > 4096 or any(ord(char) < 32 for char in url):
            raise MalformedVideoResponse("video_result URL is invalid")
        # No URL/scheme/host validation: callers must use an SSRF-safe fetcher.
        urls.append(url)
    return tuple(urls)

def _failure_message(data: Mapping[str, Any]) -> str | None:
    for key in ("error", "message"):
        value = data.get(key)
        if isinstance(value, Mapping):
            if not isinstance(value.get('message'), str):
                raise MalformedVideoResponse('video failure message is invalid')
            value = value.get('message')
        if value is None:
            continue
        if not isinstance(value, str) or len(value) > 1000:
            raise MalformedVideoResponse("video failure message is invalid")
        return value
    return None

def _response_json(response: _AsyncResponse) -> Mapping[str, Any]:
    status_code = getattr(response, "status_code", None)
    if isinstance(status_code, bool) or not isinstance(status_code, int):
        raise MalformedVideoResponse("video provider response has no valid status code")
    if not 200 <= status_code < 300:
        raise UpstreamVideoHTTPError(status_code)
    content = getattr(response, "content", None)
    if not isinstance(content, bytes) or len(content) > MAX_RESPONSE_BYTES:
        raise MalformedVideoResponse("video provider response body is invalid")
    try:
        decoded = json.loads(content.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MalformedVideoResponse("video provider response is not valid JSON") from exc
    return _json_object(decoded)
class _SyncHTTPClient(Protocol):
    def post(self, url: str, **kwargs: Any) -> _AsyncResponse: ...
    def get(self, url: str, **kwargs: Any) -> _AsyncResponse: ...

@dataclass(slots=True)
class CogVideoXSyncClient:
    """Sync counterpart for FastAPI's existing synchronous route handlers.

    The injected client is normally ``httpx.Client``. It receives no video
    bytes; this class only submits work and parses bounded JSON task metadata.
    """
    adapter: CogVideoXAdapter
    http_client: _SyncHTTPClient
    api_key: str = field(repr=False)
    timeout: float = 60.0

    @property
    def _headers(self) -> dict[str, str]:
        if not isinstance(self.api_key, str) or not self.api_key:
            raise UnsupportedVideoRequest("video provider API key is required")
        return {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"}

    def submit(self, request: VideoGenerationRequest) -> VideoTaskSubmission:
        response = self.http_client.post(
            self.adapter.generations_url,
            headers=self._headers,
            json=build_generation_payload(self.adapter, request),
            timeout=self.timeout,
        )
        return parse_submission_response(_response_json(response))

    def poll(self, task_id: str) -> VideoTaskResult:
        task_id = validate_task_id(task_id)
        response = self.http_client.get(
            self.adapter.async_result_url(task_id),
            headers=self._headers,
            timeout=self.timeout,
        )
        return parse_poll_response(_response_json(response), task_id)
