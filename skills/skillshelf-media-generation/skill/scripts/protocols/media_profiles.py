"""Image/video media capability profiles and OpenAI-Videos-style protocol helpers.

The toolbox renders per-model options from these profiles instead of assuming
every provider is CogVideoX or a fixed OpenAI images trio.  Profiles are pure
data: detection only inspects non-secret resource attributes (provider base
URL, model id, endpoint path), so this module stays unit-testable offline.

The OpenAI-Videos-style helpers implement the asynchronous task contract used
by Agnes Video (``POST /v1/videos`` + poll) and compatible providers.  They
never fetch media bytes; the caller owns the SSRF-safe downloader.
"""
from __future__ import annotations

import base64
import binascii
import json
import math
import re
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import quote, urlsplit

from .video_protocol import (
    ALLOWED_SIZES as _COGVIDEOX_SIZES,
    MAX_PROMPT_LENGTH as _COGVIDEOX_MAX_PROMPT,
    MalformedVideoResponse,
    UnsupportedVideoRequest,
    VideoResource,
    detect_cogvideox_adapter,
)

# ---------------------------------------------------------------------------
# Capability profiles
# ---------------------------------------------------------------------------

VIDEO_MODES = ("text", "keyframe", "reference")
AGNES_VIDEO_HOST = "apihub.agnes-ai.com"
AGNES_VIDEO_ASPECT_RATIOS = ("16:9", "9:16", "1:1", "4:3", "3:4", "21:9")
AGNES_VIDEO_DURATIONS = tuple(range(4, 13))
AGNES_VIDEO_MAX_PROMPT = 2000
GENERIC_VIDEO_SIZES = ("1280x720", "720x1280", "1920x1080", "1080x1920", "1024x1024")
GENERIC_VIDEO_DURATIONS = (4, 5, 6, 8, 10, 12)
GENERIC_VIDEO_MAX_PROMPT = 2000
_COGVIDEOX_SIZE_ORDER = (
    "1920x1080", "1080x1920", "1280x960", "960x1280",
    "720x480", "1024x1024", "2048x1080", "3840x2160",
)
AGNES_IMAGE_SIZES = ("1K", "2K", "3K", "4K")
AGNES_IMAGE_RATIOS = ("1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9")
GENERIC_IMAGE_SIZES = ("1024x1024", "1792x1024", "1024x1792")
COGVIEW_IMAGE_SIZES = (
    "1024x1024", "768x1349", "864x1152", "1349x768",
    "1152x864", "1440x720", "720x1440",
)
MAX_REFERENCE_IMAGES = 5
MAX_REFERENCE_AUDIOS = 3
MAX_MEDIA_DATA_URI_BYTES = 8 * 1024 * 1024
MAX_MEDIA_URL_LENGTH = 8192
_MEDIA_DATA_URI_RE = re.compile(
    r"^data:(?P<mime>[a-z0-9.+-]+/[a-z0-9.+-]+);base64,(?P<data>[A-Za-z0-9+/=\s]+)$",
    re.IGNORECASE,
)
_IMAGE_DATA_MIMES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif"})
_AUDIO_DATA_MIMES = frozenset({"audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "audio/aac"})


@dataclass(frozen=True, slots=True)
class VideoMediaProfile:
    adapter: str  # "cogvideox" | "agnes_videos" | "openai_videos"
    modes: tuple[str, ...]
    sizes: tuple[str, ...]
    size_kind: str  # "pixels" | "tier"
    aspect_ratios: tuple[str, ...]
    durations: tuple[int, ...]
    max_prompt_length: int
    max_reference_images: int = 0
    max_reference_audios: int = 0
    reference_videos: bool = False
    last_frame: bool = True
    fps: tuple[int, ...] = ()
    qualities: tuple[str, ...] = ()
    with_audio: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "adapter": self.adapter,
            "modes": list(self.modes),
            "sizes": list(self.sizes),
            "size_kind": self.size_kind,
            "aspect_ratios": list(self.aspect_ratios),
            "durations": list(self.durations),
            "max_prompt_length": self.max_prompt_length,
            "max_reference_images": self.max_reference_images,
            "max_reference_audios": self.max_reference_audios,
            "reference_videos": self.reference_videos,
            "last_frame": self.last_frame,
            "fps": list(self.fps),
            "qualities": list(self.qualities),
            "with_audio": self.with_audio,
        }


@dataclass(frozen=True, slots=True)
class ImageMediaProfile:
    adapter: str  # "openai_images"
    sizes: tuple[str, ...]
    size_kind: str  # "pixels" | "tier"
    ratios: tuple[str, ...]
    edit: bool
    max_reference_images: int
    max_prompt_length: int = 4000
    edit_transport: str = "none"
    qualities: tuple[str, ...] = ()
    output_formats: tuple[str, ...] = ()
    backgrounds: tuple[str, ...] = ()
    custom_size: bool = False
    mask: bool = False
    moderation: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "adapter": self.adapter,
            "sizes": list(self.sizes),
            "size_kind": self.size_kind,
            "ratios": list(self.ratios),
            "edit": self.edit,
            "max_reference_images": self.max_reference_images,
            "max_prompt_length": self.max_prompt_length,
            "edit_transport": self.edit_transport,
            "qualities": list(self.qualities),
            "output_formats": list(self.output_formats),
            "backgrounds": list(self.backgrounds),
            "custom_size": self.custom_size,
            "mask": self.mask,
            "moderation": self.moderation,
        }


def _host_of(base_url: str) -> str:
    try:
        return (urlsplit((base_url or "").strip()).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def _is_agnes_host(base_url: str) -> bool:
    host = _host_of(base_url)
    return host == AGNES_VIDEO_HOST or host.endswith(".agnes-ai.com")


def video_resource_profile(
    provider_base_url: str,
    kind: str,
    upstream_model_id: str,
) -> VideoMediaProfile | None:
    """Return the effective video capability profile for a resource."""
    if str(kind or "").strip().lower() != "video":
        return None
    model = (upstream_model_id or "").strip().lower()
    resource = VideoResource(
        provider_base_url=provider_base_url,
        kind=kind,
        upstream_model_id=upstream_model_id,
    )
    if detect_cogvideox_adapter(resource) is not None:
        return VideoMediaProfile(
            adapter="cogvideox",
            modes=("text", "keyframe"),
            sizes=(("1280x720", "720x1280", "1024x1024", "1920x1080", "1080x1920", "2048x1080", "3840x2160") if model == "cogvideox-3" else tuple(size for size in _COGVIDEOX_SIZE_ORDER if size in _COGVIDEOX_SIZES)),
            size_kind="pixels",
            aspect_ratios=(),
            durations=(5, 10) if model == "cogvideox-3" else (5,),
            max_prompt_length=_COGVIDEOX_MAX_PROMPT,
            last_frame=model == "cogvideox-3", fps=(30, 60),
            qualities=("speed", "quality"), with_audio=True,
        )
    if _is_agnes_host(provider_base_url) or model.startswith("agnes-video"):
        flash = "flash" in model
        return VideoMediaProfile(
            adapter="agnes_videos",
            modes=VIDEO_MODES,
            sizes=("720P",) if flash else ("720P", "1080P", "1K", "2K"),
            size_kind="tier",
            aspect_ratios=AGNES_VIDEO_ASPECT_RATIOS,
            durations=AGNES_VIDEO_DURATIONS,
            max_prompt_length=AGNES_VIDEO_MAX_PROMPT,
            max_reference_images=MAX_REFERENCE_IMAGES,
            max_reference_audios=MAX_REFERENCE_AUDIOS,
            reference_videos=False,
        )
    return VideoMediaProfile(
        adapter="openai_videos",
        modes=("text",),
        sizes=(("720x1280", "1280x720", "1024x1792", "1792x1024") if model.startswith("sora-2") else GENERIC_VIDEO_SIZES),
        size_kind="pixels",
        aspect_ratios=(),
        durations=((4, 8, 12) if model.startswith("sora-2") else GENERIC_VIDEO_DURATIONS),
        max_prompt_length=GENERIC_VIDEO_MAX_PROMPT,
    )


def image_resource_profile(
    provider_base_url: str,
    kind: str,
    upstream_model_id: str,
) -> ImageMediaProfile | None:
    """Return the effective image capability profile for a resource."""
    if str(kind or "").strip().lower() != "image":
        return None
    model = (upstream_model_id or "").strip().lower()
    if _is_agnes_host(provider_base_url) or model.startswith("agnes-image"):
        return ImageMediaProfile(
            adapter="openai_images",
            sizes=AGNES_IMAGE_SIZES,
            size_kind="tier",
            ratios=AGNES_IMAGE_RATIOS,
            edit=True,
            max_reference_images=MAX_REFERENCE_IMAGES,
            edit_transport="agnes_json",
        )
    if model.startswith("gpt-image-") or model == "chatgpt-image-latest":
        return ImageMediaProfile(
            adapter="openai_images", sizes=(("auto", "1024x1024", "1536x1024", "1024x1536", "1536x864", "864x1536", "2048x2048", "2560x1440", "3840x2160") if model.startswith("gpt-image-2") else ("auto", "1024x1024", "1536x1024", "1024x1536")),
            size_kind="pixels", ratios=(), edit=True, max_reference_images=16,
            max_prompt_length=32000, edit_transport="multipart",
            qualities=(("auto", "low", "medium", "high", "xhigh", "max") if model.startswith("gpt-image-2.5") else ("auto", "low", "medium", "high")),
            output_formats=("png", "jpeg", "webp"),
            backgrounds=("auto", "opaque", "transparent"),
            custom_size=model.startswith("gpt-image-2"), mask=True, moderation=True,
        )
    if _host_of(provider_base_url) == "api.xbai.top" and model in {"nano-banana", "nano-banana-2"}:
        return ImageMediaProfile(
            adapter="openai_images", sizes=("1024x1024", "256x256", "512x512", "1024x1792", "1792x1024"),
            size_kind="pixels", ratios=(), edit=True, max_reference_images=5,
            edit_transport="multipart", qualities=("standard", "hd"),
        )
    if "cogview" in model:
        return ImageMediaProfile(
            adapter="openai_images",
            sizes=COGVIEW_IMAGE_SIZES,
            size_kind="pixels",
            ratios=(),
            edit=False,
            max_reference_images=0,
        )
    return ImageMediaProfile(
        adapter="openai_images",
        sizes=GENERIC_IMAGE_SIZES,
        size_kind="pixels",
        ratios=(),
        edit=False,
        max_reference_images=0,
    )


# ---------------------------------------------------------------------------
# Request validation against a profile
# ---------------------------------------------------------------------------

def normalize_media_input(value: Any, *, field: str, image: bool = True) -> str:
    """Accept a public http(s) URL or a base64 data URI, return it normalized."""
    if not isinstance(value, str):
        raise UnsupportedVideoRequest(f"{field} must be a URL or base64 data URI")
    candidate = value.strip()
    if not candidate or len(candidate) > MAX_MEDIA_URL_LENGTH + 4 * ((MAX_MEDIA_DATA_URI_BYTES + 2) // 3):
        raise UnsupportedVideoRequest(f"{field} is too large")
    lowered = candidate[:8].lower()
    if lowered.startswith(("http://", "https://")):
        if len(candidate) > MAX_MEDIA_URL_LENGTH:
            raise UnsupportedVideoRequest(f"{field} URL exceeds the 8192 character limit")
        return candidate
    match = _MEDIA_DATA_URI_RE.match(candidate)
    if not match:
        raise UnsupportedVideoRequest(f"{field} must be a public http(s) URL or a base64 data URI")
    allowed = _IMAGE_DATA_MIMES if image else _AUDIO_DATA_MIMES
    if match.group("mime").lower() not in allowed:
        raise UnsupportedVideoRequest(f"{field} has an unsupported media type")
    try:
        decoded = base64.b64decode(re.sub(r"\s", "", match.group("data")), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise UnsupportedVideoRequest(f"{field} is not valid base64 data") from exc
    if not decoded or len(decoded) > MAX_MEDIA_DATA_URI_BYTES:
        raise UnsupportedVideoRequest(f"{field} exceeds the 8 MiB media limit")
    return candidate


def validate_video_request(
    profile: VideoMediaProfile,
    *,
    prompt: str,
    mode: str,
    size: str,
    duration: int,
    aspect_ratio: str | None,
    first_frame: str | None,
    last_frame: str | None,
    images: tuple[str, ...],
    audios: tuple[str, ...],
) -> None:
    """Validate a toolbox video request against the resolved resource profile."""
    if not isinstance(profile, VideoMediaProfile):
        raise UnsupportedVideoRequest("video profile is missing")
    if mode not in profile.modes:
        raise UnsupportedVideoRequest("所选模型不支持该生成模式")
    if len(prompt) > profile.max_prompt_length:
        raise UnsupportedVideoRequest(f"提示词最长 {profile.max_prompt_length} 字符")
    if size not in profile.sizes:
        raise UnsupportedVideoRequest("所选模型不支持该尺寸/清晰度")
    if duration not in profile.durations:
        raise UnsupportedVideoRequest("所选模型不支持该时长")
    if aspect_ratio:
        if not profile.aspect_ratios:
            raise UnsupportedVideoRequest("所选模型不支持宽高比设置")
        if aspect_ratio not in profile.aspect_ratios:
            raise UnsupportedVideoRequest("所选模型不支持该宽高比")
    if mode == "text":
        if first_frame or last_frame or images or audios:
            raise UnsupportedVideoRequest("文生视频模式不接受参考媒体")
    elif mode == "keyframe":
        if images or audios:
            raise UnsupportedVideoRequest("首尾帧模式只接受首帧/尾帧图片")
        if not first_frame and not last_frame:
            raise UnsupportedVideoRequest("首尾帧模式至少需要首帧或尾帧图片")
        if profile.adapter == "cogvideox":
            for value in (first_frame, last_frame):
                if value and value.lower().startswith("data:"):
                    match = _MEDIA_DATA_URI_RE.match(value)
                    if not match or match.group("mime").lower() not in {"image/png", "image/jpeg"}:
                        raise UnsupportedVideoRequest("CogVideoX 首尾帧仅支持 PNG/JPEG")
                    if len(base64.b64decode(re.sub(r"\s", "", match.group("data")), validate=True)) > 5 * 1024 * 1024:
                        raise UnsupportedVideoRequest("CogVideoX 首尾帧每张最多 5 MiB")
        if last_frame and not profile.last_frame:
            raise UnsupportedVideoRequest("所选模型仅支持首帧图片，不支持尾帧")
    elif mode == "reference":
        if first_frame or last_frame:
            raise UnsupportedVideoRequest("参考生成模式不接受首帧/尾帧")
        if not images and not audios:
            raise UnsupportedVideoRequest("参考生成模式至少需要一张参考图或一段参考音频")
    if len(images) > profile.max_reference_images:
        raise UnsupportedVideoRequest(f"所选模型最多支持 {profile.max_reference_images} 张参考图")
    if len(audios) > profile.max_reference_audios:
        raise UnsupportedVideoRequest(f"所选模型最多支持 {profile.max_reference_audios} 段参考音频")


def validate_image_request(
    profile: ImageMediaProfile,
    *,
    prompt: str,
    size: str,
    ratio: str | None,
    reference_images: tuple[str, ...],
) -> None:
    if not isinstance(profile, ImageMediaProfile):
        raise UnsupportedVideoRequest("image profile is missing")
    if len(prompt) > profile.max_prompt_length:
        raise UnsupportedVideoRequest(f"提示词最长 {profile.max_prompt_length} 字符")
    if size not in profile.sizes and not (profile.custom_size and valid_custom_image_size(size)):
        raise UnsupportedVideoRequest("所选模型不支持该尺寸/清晰度")
    if ratio:
        if not profile.ratios:
            raise UnsupportedVideoRequest("所选模型不支持宽高比设置")
        if ratio not in profile.ratios:
            raise UnsupportedVideoRequest("所选模型不支持该宽高比")
    if reference_images:
        if not profile.edit:
            raise UnsupportedVideoRequest("所选模型不支持图片编辑/图生图")
        if len(reference_images) > profile.max_reference_images:
            raise UnsupportedVideoRequest(f"所选模型最多支持 {profile.max_reference_images} 张参考图")


# ---------------------------------------------------------------------------
def valid_custom_image_size(size: str) -> bool:
    match = re.fullmatch(r"(\d{2,4})x(\d{2,4})", size)
    if not match:
        return False
    width, height = map(int, match.groups())
    return (width % 16 == height % 16 == 0 and min(width, height) >= 16
            and max(width, height) <= 3840 and width * height <= 3840 * 2160
            and 1 / 3 <= width / height <= 3)


# OpenAI-Videos-compatible asynchronous protocol (Agnes and peers)
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class OpenAIVideosAdapter:
    """Validated endpoint configuration for an OpenAI-Videos-style resource."""
    submit_url: str
    poll_style: str  # "agnes" | "openai"
    base_origin: str  # scheme://host for agnes poll; submit base for openai poll
    submit_path: str
    upstream_model: str

    def poll_url(self, video_id: str) -> str:
        video_id = _video_task_id(video_id)
        if self.poll_style == "agnes":
            return (
                f"{self.base_origin}/agnesapi?video_id={quote(video_id, safe='')}"
                f"&model_name={quote(self.upstream_model, safe='')}"
            )
        path = self.submit_path.rstrip("/")
        return f"{self.base_origin}{path}/{quote(video_id, safe='')}"

    def content_url(self, video_id: str) -> str:
        return self.poll_url(video_id) + "/content"


def detect_openai_videos_adapter(
    resource: VideoResource,
    endpoint_path: str = "",
) -> OpenAIVideosAdapter | None:
    """Return an adapter for OpenAI-Videos-compatible resources, else None."""
    if not isinstance(resource, VideoResource):
        return None
    if str(resource.kind or "").strip().lower() != "video":
        return None
    model = str(resource.upstream_model_id or "").strip()
    if not model:
        return None
    try:
        parsed = urlsplit(str(resource.provider_base_url or "").strip())
        if parsed.scheme.lower() != "https" or not parsed.hostname:
            return None
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            return None
        port = parsed.port
    except ValueError:
        return None
    if port not in (None, 443):
        return None
    origin = f"https://{parsed.hostname.lower().rstrip('.')}"
    if port == 443:
        origin += ":443"
    base_path = parsed.path.rstrip("/")
    relative = (endpoint_path or "").strip().lstrip("/")
    if relative:
        # Provider base paths commonly end in a version segment (``/v1``);
        # an explicit endpoint that restarts the version keeps only one copy.
        base_tail = base_path.rsplit("/", 1)[-1] if base_path else ""
        path_parts = relative.split("/", 1)
        if (
            len(path_parts) > 1
            and re.fullmatch(r"v\d+[a-z0-9._-]*", base_tail, re.IGNORECASE)
            and re.fullmatch(r"v\d+[a-z0-9._-]*", path_parts[0], re.IGNORECASE)
        ):
            relative = path_parts[1]
        submit_path = base_path + "/" + relative
    else:
        submit_path = (base_path + "/videos") if base_path else "/v1/videos"
    poll_style = "agnes" if (_is_agnes_host(resource.provider_base_url) or model.lower().startswith("agnes-video")) else "openai"
    return OpenAIVideosAdapter(
        submit_url=origin + submit_path,
        poll_style=poll_style,
        base_origin=origin,
        submit_path=submit_path,
        upstream_model=model,
    )


def build_openai_video_payload(
    adapter: OpenAIVideosAdapter,
    *,
    prompt: str,
    mode: str,
    seconds: int,
    size: str,
    aspect_ratio: str | None = None,
    first_frame: str | None = None,
    last_frame: str | None = None,
    images: tuple[str, ...] = (),
    audios: tuple[str, ...] = (),
    seed: int | None = None,
) -> dict[str, Any]:
    """Build the submit body for an OpenAI-Videos-style provider."""
    if not isinstance(adapter, OpenAIVideosAdapter):
        raise UnsupportedVideoRequest("OpenAI videos adapter is required")
    prompt = (prompt or "").strip()
    if not prompt:
        raise UnsupportedVideoRequest("prompt must not be blank")
    if adapter.poll_style == "agnes":
        payload: dict[str, Any] = {
            "model": adapter.upstream_model,
            "prompt": prompt,
            "mode": mode,
            "seconds": str(seconds),
            "size": size,
        }
        if aspect_ratio:
            payload["aspect_ratio"] = aspect_ratio
        if first_frame:
            payload["first_frame"] = first_frame
        if last_frame:
            payload["last_frame"] = last_frame
        if images:
            payload["images"] = list(images)
        if audios:
            payload["audios"] = list(audios)
        if seed is not None:
            payload["seed"] = seed
        return payload
    return {
        "model": adapter.upstream_model,
        "prompt": prompt,
        "seconds": str(seconds),
        "size": size,
    }


_OPENAI_VIDEO_STATUS_MAP = {
    "queued": "queued",
    "pending": "queued",
    "in_progress": "in_progress",
    "processing": "in_progress",
    "running": "in_progress",
    "completed": "completed",
    "succeeded": "completed",
    "success": "completed",
    "failed": "failed",
    "error": "failed",
    "cancelled": "failed",
    "canceled": "failed",
}


@dataclass(frozen=True, slots=True)
class OpenAIVideoSubmission:
    video_id: str
    status: str


@dataclass(frozen=True, slots=True)
class OpenAIVideoPoll:
    video_id: str
    status: str
    progress: int | None = None
    video_url: str | None = None
    failure_message: str | None = None


def _video_task_id(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 256:
        raise MalformedVideoResponse("video task id is invalid")
    candidate = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}", candidate):
        raise MalformedVideoResponse("video task id is invalid")
    return candidate


def _video_status(value: Any) -> str:
    if not isinstance(value, str):
        raise MalformedVideoResponse("video task status is missing")
    mapped = _OPENAI_VIDEO_STATUS_MAP.get(value.strip().lower())
    if mapped is None:
        raise MalformedVideoResponse("video task status is unknown")
    return mapped


def _video_progress(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return None
        return max(0, min(100, int(value)))
    return None


def _video_result_url(data: Mapping[str, Any]) -> str | None:
    candidates: list[Any] = [data.get("url"), data.get("content_url"), data.get("video_url")]
    metadata = data.get("metadata")
    if isinstance(metadata, Mapping):
        candidates.append(metadata.get("url"))
    output = data.get("output")
    if isinstance(output, Mapping):
        candidates.extend((output.get("url"), output.get("video_url")))
    result = data.get("result")
    if isinstance(result, Mapping):
        candidates.append(result.get("url"))
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip().lower().startswith(("http://", "https://")):
            return candidate.strip()
    return None


def _video_failure_message(data: Mapping[str, Any]) -> str | None:
    error = data.get("error")
    if isinstance(error, Mapping):
        message = error.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()[:500]
    if isinstance(error, str) and error.strip():
        return error.strip()[:500]
    message = data.get("message")
    if isinstance(message, str) and message.strip():
        return message.strip()[:500]
    return None


def parse_openai_video_submission(payload: Any) -> OpenAIVideoSubmission:
    if not isinstance(payload, Mapping):
        raise MalformedVideoResponse("video submission response must be an object")
    video_id = payload.get("video_id") or payload.get("task_id") or payload.get("id")
    status = payload.get("status") or "queued"
    return OpenAIVideoSubmission(video_id=_video_task_id(video_id), status=_video_status(status))


def parse_openai_video_poll(payload: Any, video_id: str) -> OpenAIVideoPoll:
    if not isinstance(payload, Mapping):
        raise MalformedVideoResponse("video task response must be an object")
    video_id = _video_task_id(video_id)
    response_id = payload.get("video_id") or payload.get("task_id") or payload.get("id")
    if response_id is not None and _video_task_id(response_id) != video_id:
        raise MalformedVideoResponse("video result task id does not match request")
    status = _video_status(payload.get("status"))
    return OpenAIVideoPoll(
        video_id=video_id,
        status=status,
        progress=_video_progress(payload.get("progress")),
        video_url=_video_result_url(payload) if status == "completed" else None,
        failure_message=_video_failure_message(payload) if status == "failed" else None,
    )


# ---------------------------------------------------------------------------
# Image payload construction
# ---------------------------------------------------------------------------

def build_image_payload(
    profile: ImageMediaProfile,
    *,
    upstream_model: str,
    prompt: str,
    size: str,
    ratio: str | None = None,
    reference_images: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Build an OpenAI-images-style body, honouring tier/edit extensions."""
    if not isinstance(profile, ImageMediaProfile):
        raise UnsupportedVideoRequest("image profile is missing")
    payload: dict[str, Any] = {"model": upstream_model, "prompt": prompt, "size": size}
    if profile.size_kind == "tier":
        # 实测该画像上游对 base64 输出不响应（读超时），一律请求 URL，
        # 由调用方的 SSRF 安全下载器取回字节。
        if ratio:
            payload["ratio"] = ratio
        payload["extra_body"] = {"response_format": "url"}
        if reference_images:
            payload["extra_body"]["image"] = list(reference_images)
    return payload


def profile_from_json(value: Any) -> VideoMediaProfile | ImageMediaProfile | None:
    """Rebuild a profile from its ``to_dict`` form (task snapshots)."""
    if not isinstance(value, Mapping):
        return None
    try:
        if value.get("adapter") in {"cogvideox", "agnes_videos", "openai_videos"}:
            return VideoMediaProfile(
                adapter=str(value["adapter"]),
                modes=tuple(str(item) for item in value["modes"]),
                sizes=tuple(str(item) for item in value["sizes"]),
                size_kind=str(value["size_kind"]),
                aspect_ratios=tuple(str(item) for item in value["aspect_ratios"]),
                durations=tuple(int(item) for item in value["durations"]),
                max_prompt_length=int(value["max_prompt_length"]),
                max_reference_images=int(value.get("max_reference_images", 0)),
                max_reference_audios=int(value.get("max_reference_audios", 0)),
                reference_videos=bool(value.get("reference_videos", False)),
                last_frame=bool(value.get("last_frame", True)),
                fps=tuple(value.get("fps", ())),
                qualities=tuple(value.get("qualities", ())),
                with_audio=bool(value.get("with_audio", False)),
            )
        if value.get("adapter") == "openai_images":
            return ImageMediaProfile(
                adapter="openai_images",
                sizes=tuple(str(item) for item in value["sizes"]),
                size_kind=str(value["size_kind"]),
                ratios=tuple(str(item) for item in value["ratios"]),
                edit=bool(value.get("edit", False)),
                max_reference_images=int(value.get("max_reference_images", 0)),
                max_prompt_length=int(value.get("max_prompt_length", 4000)),
                edit_transport=str(value.get("edit_transport", "none")),
                qualities=tuple(value.get("qualities", ())),
                output_formats=tuple(value.get("output_formats", ())),
                backgrounds=tuple(value.get("backgrounds", ())),
                custom_size=bool(value.get("custom_size", False)),
                mask=bool(value.get("mask", False)),
                moderation=bool(value.get("moderation", False)),
            )
    except (KeyError, TypeError, ValueError):
        return None
    return None


def json_dumps_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
