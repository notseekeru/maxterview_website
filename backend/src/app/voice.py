import asyncio
import base64
import json
import os
import time
from collections import OrderedDict
from dataclasses import dataclass

import httpx
import structlog

log = structlog.get_logger(__name__)

ACCOUNT_ID = os.getenv("CLOUDFLARE_ACCOUNT_ID", "")
API_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN", "")
STT_MODEL = os.getenv("CLOUDFLARE_STT_MODEL", "@cf/openai/whisper-large-v3-turbo")
# MeloTTS 500s on every request from this account, and Aura is the human voice the feature is for.
# Aura is the scarce resource: roughly 1.4k-3.8k neurons per run of the daily allocation.
TTS_MODEL = os.getenv("CLOUDFLARE_TTS_MODEL", "@cf/deepgram/aura-1")
# The model's default is `angus`, an Irish man: the interviewer's voice is cast, not inherited.
TTS_SPEAKER = os.getenv("CLOUDFLARE_TTS_SPEAKER", "hera")

MAX_UPLOAD_BYTES = int(os.getenv("VOICE_MAX_UPLOAD_BYTES", str(8 * 1024 * 1024)))
# One sentence is spoken per request, so this is a ceiling on a
# caller, not a limit anyone meets: it protects the daily neuron budget from a hostile body.
MAX_TTS_CHARS = int(os.getenv("VOICE_MAX_TTS_CHARS", "600"))

# Connect is capped in seconds on purpose (a blackholed host otherwise burns the kernel's SYN budget);
# read is wide because a 90 second clip takes as long as it takes. Whisper is batch, not streaming.
TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)

# Concurrent upstream calls. The pod is one replica and each call holds its audio in memory, so a burst
# is a burst of held bytes: unbounded, that is an OOMKill (a full outage) rather than a slow take.
CONCURRENCY = int(os.getenv("VOICE_CONCURRENCY", "2"))
_slots = asyncio.Semaphore(CONCURRENCY)

# Keyed on the voice that would say the line, so a replay costs no neurons, and bounded in bytes: a
# clip's size tracks its text and the pod is 256Mi.
# The opener is generated per run, so the first line is always a miss.
CACHE_BYTES = int(os.getenv("VOICE_TTS_CACHE_BYTES", str(8 * 1024 * 1024)))
_cache: OrderedDict[tuple[str, str, str], "Speech"] = OrderedDict()

# One client per process, per event loop: a pool's connections belong to the loop that opened them.
# A client per call put a TLS handshake on the path to the first word.
_http: tuple[asyncio.AbstractEventLoop, httpx.AsyncClient] | None = None

# Container magic bytes. Whisper needs a real container, and the browser's Content-Type is not proof of
# one (Safari and Chrome disagree, and either can be spoofed). Same reasoning as resumes._has_pdf_header.
_CONTAINERS = ((b"\x1aE\xdf\xa3", 0), (b"OggS", 0), (b"RIFF", 0), (b"ftyp", 4), (b"ID3", 0))


class VoiceError(Exception): ...


@dataclass(frozen=True)
class Transcript:
    text: str
    # Whisper turbo returns SEGMENTS, not per-word timings: word-level detail needs the non-turbo model.
    segments: list[dict]
    # Detected language, logged because a wrong guess here is the first suspect when the text comes
    # back looking like nonsense.
    language: str


@dataclass(frozen=True)
class Speech:
    audio: bytes
    media_type: str


def capability() -> dict:
    configured = bool(ACCOUNT_ID and API_TOKEN)
    return {"tts": configured, "stt": configured, "tts_model": TTS_MODEL, "stt_model": STT_MODEL}


def _has_container(data: bytes) -> bool:
    return any(data[offset : offset + len(magic)] == magic for magic, offset in _CONTAINERS)


def _client() -> httpx.AsyncClient:
    global _http
    loop = asyncio.get_running_loop()
    if _http is None or _http[0] is not loop or _http[1].is_closed:
        _http = (loop, httpx.AsyncClient(timeout=TIMEOUT))
    return _http[1]


async def aclose() -> None:
    global _http
    if _http is not None:
        await _http[1].aclose()
        _http = None


def _endpoint(model: str) -> str:
    return f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model}"


def _failure(payload: object) -> str | None:
    if not isinstance(payload, dict) or payload.get("success", True):
        return None
    errors = payload.get("errors") or []
    first = errors[0] if isinstance(errors, list) and errors else {}
    message = first.get("message") if isinstance(first, dict) else None
    return message or "Workers AI refused the request"


def _tts_body(model: str, text: str) -> dict:
    if "aura" in model:
        return {"text": text, "speaker": TTS_SPEAKER}
    return {"prompt": text, "lang": "en"}


def _cached(key: tuple[str, str, str]) -> "Speech | None":
    hit = _cache.get(key)
    if hit is not None:
        _cache.move_to_end(key)
    return hit


def _remember(key: tuple[str, str, str], speech: "Speech") -> None:
    _cache[key] = speech
    # Oldest first, and the newest line is never the one evicted: a clip larger than the whole budget
    # is still worth serving, it just empties the cache.
    while len(_cache) > 1 and sum(len(s.audio) for s in _cache.values()) > CACHE_BYTES:
        _cache.popitem(last=False)


# One framework-free self-check (AGENTS rule 5): this branch decides whether the provider sees a
# sentence or a 400, and it is the one a model swap would silently flip.
assert _tts_body("@cf/deepgram/aura-1", "hi") == {"text": "hi", "speaker": TTS_SPEAKER}
assert _tts_body("@cf/myshell-ai/melotts", "hi") == {"prompt": "hi", "lang": "en"}
assert _failure({"success": False, "errors": [{"code": 7000, "message": "No more neurons"}]}) == "No more neurons"
assert _failure({"success": True, "result": {"text": "hi"}}) is None


async def _run(model: str, body: dict) -> httpx.Response:
    if not (ACCOUNT_ID and API_TOKEN):
        raise VoiceError("Voice is not configured on this server yet.")
    async with _slots:
        try:
            return await _client().post(_endpoint(model), headers={"Authorization": f"Bearer {API_TOKEN}"}, json=body)
        except httpx.HTTPError as exc:
            # The visitor gets one sentence; the log gets the class, never the audio or the token.
            log.warning("voice.unreachable", model=model, error=type(exc).__name__)
            raise VoiceError("The voice service did not answer. Type your answer instead.") from exc


def _audio_bytes(resp: httpx.Response) -> tuple[bytes, str]:
    media_type = (resp.headers.get("content-type") or "").split(";")[0].strip()
    if media_type.startswith("audio/"):
        # Aura-1 measured: raw `audio/mpeg`, which is the browser's easiest case to decode.
        return resp.content, media_type
    payload = json.loads(resp.content or b"null")
    if (message := _failure(payload)) is not None:
        raise VoiceError(f"The voice model refused that line: {message}")
    audio = (payload.get("result") or {}).get("audio") if isinstance(payload, dict) else None
    if not isinstance(audio, str) or not audio:
        raise VoiceError("The voice model returned no audio.")
    encoded = audio.split(",", 1)[1] if audio.startswith("data:") else audio
    return base64.b64decode(encoded), "audio/mpeg"


async def speak(text: str) -> Speech:
    if len(text) > MAX_TTS_CHARS:
        raise VoiceError(f"That line is longer than {MAX_TTS_CHARS} characters.")
    key = (TTS_MODEL, TTS_SPEAKER, text)
    hit = _cached(key)
    if hit is not None:
        log.info("voice.tts.completed", chars=len(text), latency_ms=0.0, engine="cloud", bytes=len(hit.audio), speaker=TTS_SPEAKER, cached=True)
        return hit
    started = time.perf_counter()
    resp = await _run(TTS_MODEL, _tts_body(TTS_MODEL, text))
    if resp.status_code != 200:
        raise VoiceError(_status_message(resp.status_code))
    audio, media_type = _audio_bytes(resp)
    log.info("voice.tts.completed", chars=len(text), latency_ms=round((time.perf_counter() - started) * 1000, 1), engine="cloud", bytes=len(audio), speaker=TTS_SPEAKER, cached=False)
    speech = Speech(audio=audio, media_type=media_type)
    _remember(key, speech)
    return speech


async def transcribe(data: bytes, transcription: str = "transcribe") -> Transcript:
    if len(data) > MAX_UPLOAD_BYTES:
        raise VoiceError(f"That recording is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
    if not _has_container(data):
        raise VoiceError("That recording is not in a format the transcription service reads.")
    started = time.perf_counter()
    resp = await _run(STT_MODEL, {"audio": base64.b64encode(data).decode(), "task": transcription})
    if resp.status_code != 200:
        raise VoiceError(_status_message(resp.status_code))
    payload = json.loads(resp.content or b"null")
    if (message := _failure(payload)) is not None:
        raise VoiceError(f"The transcription model refused that clip: {message}")
    result = payload.get("result") if isinstance(payload, dict) else payload
    # The non-turbo `whisper` model answers with the text alone; the turbo model answers with an object.
    if isinstance(result, str):
        text, segments, info, usage = result, [], {}, {}
    else:
        result = result or {}
        text = result.get("text") or ""
        segments = result.get("segments") or []
        info = result.get("transcription_info") or {}
        usage = result.get("usage") or {}
    log.info(
        "voice.stt.completed",
        bytes=len(data),
        latency_ms=round((time.perf_counter() - started) * 1000, 1),
        engine="cloud",
        chars=len(text),
        # `transcription_info` carries the audio seconds and the detected language, which is what makes a
        # run's cost and a mis-detected language readable out of Loki.
        audio_s=info.get("duration"),
        language=info.get("language"),
        # Measured, not estimated: the response reports the neurons it spent. TTS returns raw audio, so its
        # cost stays an estimate from characters.
        neurons=usage.get("neurons"),
    )
    return Transcript(text=text.strip(), segments=segments, language=str(info.get("language") or ""))


def _status_message(code: int) -> str:
    if code in (401, 403):
        log.warning("voice.unauthorized", status=code)
        return "Voice is not authorised on this server. Type your answer instead."
    if code == 429:
        # The free daily allocation is spent (or a rate limit tripped): it resets at 00:00 UTC.
        log.warning("voice.quota_exhausted", status=code)
        return "The voice service has hit its daily limit. Type your answer, or come back tomorrow."
    return "The voice service is unavailable right now. Type your answer instead."
