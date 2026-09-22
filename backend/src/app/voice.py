"""Voice: Workers AI in, text out (and back), nothing kept.

Framework-free (no FastAPI, no DB) so the caps and the envelope are testable without a server, the
same split as app/resumes.py. Recorded audio is base64'd into the request and discarded when the call
returns: the resume rule (PLAN D16) applied to voice, so nothing is stored, logged or replayable.

AI HERE: this is written against the published model pages and pinned by respx doubles, NOT against a
live account, because CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN do not exist in this environment
yet. VOICE.md holds the two curls that must pass before the first real call is trusted.
"""

import asyncio
import base64
import json
import os
import time
from dataclasses import dataclass

import httpx
import structlog

log = structlog.get_logger(__name__)

# Env-overridable, the same idiom as billing and resumes: a deployment can swap the model or tighten a
# cap without a code change.
ACCOUNT_ID = os.getenv("CLOUDFLARE_ACCOUNT_ID", "")
API_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN", "")
STT_MODEL = os.getenv("CLOUDFLARE_STT_MODEL", "@cf/openai/whisper-large-v3-turbo")
TTS_MODEL = os.getenv("CLOUDFLARE_TTS_MODEL", "@cf/myshell-ai/melotts")

# A take is capped at 180s in the UI; 8MB is roughly four minutes of Opus, so this only catches a
# client that ignored the timer.
MAX_UPLOAD_BYTES = int(os.getenv("VOICE_MAX_UPLOAD_BYTES", str(8 * 1024 * 1024)))
# One sentence is spoken per request (VOICE.md step 1 chunks at 140 chars), so this is a ceiling on a
# caller, not a limit anyone meets: it protects the daily neuron budget from a hostile body.
MAX_TTS_CHARS = int(os.getenv("VOICE_MAX_TTS_CHARS", "600"))

# Connect is capped in seconds on purpose (a blackholed host otherwise burns the kernel's SYN budget);
# read is wide because a 90 second clip takes as long as it takes. Whisper is batch, not streaming.
TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=10.0)

# Concurrent upstream calls. The pod is one replica and each call holds its audio in memory, so a burst
# is a burst of held bytes: unbounded, that is an OOMKill (a full outage) rather than a slow take.
CONCURRENCY = int(os.getenv("VOICE_CONCURRENCY", "2"))
_slots = asyncio.Semaphore(CONCURRENCY)

# Container magic bytes. Whisper needs a real container, and the browser's Content-Type is not proof of
# one (Safari and Chrome disagree, and either can be spoofed). Same reasoning as resumes._has_pdf_header.
_CONTAINERS = ((b"\x1aE\xdf\xa3", 0), (b"OggS", 0), (b"RIFF", 0), (b"ftyp", 4), (b"ID3", 0))


class VoiceError(Exception):
    """A rejection whose message is safe, and useful, to show the visitor."""


@dataclass(frozen=True)
class Transcript:
    text: str
    # Word timings are what make pace, filler and pause numbers possible later. Whisper returns them;
    # the UI does not read them yet.
    words: list[dict]


@dataclass(frozen=True)
class Speech:
    audio: bytes
    media_type: str


def capability() -> dict:
    """What this deployment can actually do, for the UI to gate its controls on rather than letting a
    visitor press a button that 503s. Both directions need the same two values, so they move together."""
    configured = bool(ACCOUNT_ID and API_TOKEN)
    return {"tts": configured, "stt": configured, "tts_model": TTS_MODEL, "stt_model": STT_MODEL}


def _has_container(data: bytes) -> bool:
    return any(data[offset : offset + len(magic)] == magic for magic, offset in _CONTAINERS)


def _endpoint(model: str) -> str:
    return f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{model}"


def _failure(payload: object) -> str | None:
    """The provider's own message when the envelope says the call failed, else None.

    Workers AI answers HTTP 200 with `success: false` for a model-level refusal, so a status check
    alone would turn a quota message into a KeyError three lines later. The message is quoted back
    because Cloudflare writes these for operators, and the quota one names the reset."""
    if not isinstance(payload, dict) or payload.get("success", True):
        return None
    errors = payload.get("errors") or []
    first = errors[0] if isinstance(errors, list) and errors else {}
    message = first.get("message") if isinstance(first, dict) else None
    return message or "Workers AI refused the request"


# One framework-free self-check (AGENTS rule 5): this branch decides between a usable answer and a
# 502, and it is the one an envelope change would silently flip.
assert _failure({"success": False, "errors": [{"code": 7000, "message": "No more neurons"}]}) == "No more neurons"
assert _failure({"success": True, "result": {"text": "hi"}}) is None


async def _run(model: str, body: dict) -> httpx.Response:
    """One POST to Workers AI. Raises VoiceError for everything the caller can be told about."""
    if not (ACCOUNT_ID and API_TOKEN):
        raise VoiceError("Voice is not configured on this server yet.")
    async with _slots:
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                return await client.post(_endpoint(model), headers={"Authorization": f"Bearer {API_TOKEN}"}, json=body)
        except httpx.HTTPError as exc:
            # The visitor gets one sentence; the log gets the class, never the audio or the token.
            log.warning("voice.unreachable", model=model, error=type(exc).__name__)
            raise VoiceError("The voice service did not answer. Type your answer instead.") from exc


def _audio_bytes(resp: httpx.Response) -> tuple[bytes, str]:
    """The MP3, from whichever of the two documented shapes came back.

    MeloTTS returns `audio/mpeg` binary; the JSON option returns the audio base64'd (sometimes as a
    data URL). AI HERE: both are handled because neither is confirmed against a live account, and the
    one that is wrong costs a 502 with no clue which. Drop the branch the first real call kills.
    """
    media_type = (resp.headers.get("content-type") or "").split(";")[0].strip()
    if media_type.startswith("audio/"):
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
    """One line in, MP3 out. The caller chunks; this never sees a paragraph."""
    if len(text) > MAX_TTS_CHARS:
        raise VoiceError(f"That line is longer than {MAX_TTS_CHARS} characters.")
    started = time.perf_counter()
    resp = await _run(TTS_MODEL, {"prompt": text, "lang": "en"})
    if resp.status_code != 200:
        raise VoiceError(_status_message(resp.status_code))
    audio, media_type = _audio_bytes(resp)
    log.info("voice.tts.completed", chars=len(text), latency_ms=round((time.perf_counter() - started) * 1000, 1), engine="cloud", bytes=len(audio))
    return Speech(audio=audio, media_type=media_type)


async def transcribe(data: bytes, transcription: str = "transcribe") -> Transcript:
    """One recorded clip in, text out. The bytes live for the length of this call and no longer."""
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
    # Older whisper returns `result` as the text itself; the turbo model returns an object.
    text = result if isinstance(result, str) else (result or {}).get("text") or ""
    words = [] if isinstance(result, str) else ((result or {}).get("words") or [])
    log.info("voice.stt.completed", bytes=len(data), latency_ms=round((time.perf_counter() - started) * 1000, 1), engine="cloud", chars=len(text))
    return Transcript(text=text.strip(), words=words)


def _status_message(code: int) -> str:
    """Upstream status, translated into the one thing the visitor can do about it."""
    if code in (401, 403):
        log.warning("voice.unauthorized", status=code)
        return "Voice is not authorised on this server. Type your answer instead."
    if code == 429:
        # The free daily allocation is spent (or a rate limit tripped): it resets at 00:00 UTC.
        log.warning("voice.quota_exhausted", status=code)
        return "The voice service has hit its daily limit. Type your answer, or come back tomorrow."
    return "The voice service is unavailable right now. Type your answer instead."
