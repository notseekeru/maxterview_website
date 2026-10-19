import base64
import json

import pytest
import respx
from httpx import ConnectError, Response

from app import voice

ACCOUNT = "acct-123"
TOKEN = "tok-456"
CLIP = b"\x1aE\xdf\xa3" + b"fake-webm-payload"


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(voice, "ACCOUNT_ID", ACCOUNT)
    monkeypatch.setattr(voice, "API_TOKEN", TOKEN)
    voice._cache.clear()


def url(model: str) -> str:
    return f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/run/{model}"


async def test_speak_posts_the_prompt_and_returns_the_mp3():
    with respx.mock as mock:
        route = mock.post(url(voice.TTS_MODEL)).mock(return_value=Response(200, content=b"ID3audio", headers={"content-type": "audio/mpeg"}))
        got = await voice.speak("Tell me about the migration.")
    assert got.audio == b"ID3audio"
    assert got.media_type == "audio/mpeg"
    body = route.calls[0].request
    assert body.headers["authorization"] == f"Bearer {TOKEN}"
    # Aura takes `text` plus the named voice, MeloTTS takes `prompt` plus `lang`. The field names are
    # the whole request, so both shapes are pinned: the default is one env var away from the other
    # family, and a body with no speaker is the provider's default voice, which is not a choice.
    assert json.loads(body.content) == {"text": "Tell me about the migration.", "speaker": voice.TTS_SPEAKER}
    assert voice.TTS_SPEAKER in {"asteria", "athena", "hera", "luna", "stella"}
    assert voice._tts_body("@cf/myshell-ai/melotts", "hi") == {"prompt": "hi", "lang": "en"}


async def test_a_repeated_line_is_synthesized_once():
    with respx.mock as mock:
        route = mock.post(url(voice.TTS_MODEL)).mock(return_value=Response(200, content=b"ID3audio", headers={"content-type": "audio/mpeg"}))
        first = await voice.speak("Say that again.")
        again = await voice.speak("Say that again.")
    assert route.call_count == 1
    assert first == again == voice.Speech(audio=b"ID3audio", media_type="audio/mpeg")


async def test_speak_reads_the_json_audio_option():
    payload = {"result": {"audio": base64.b64encode(b"mp3bytes").decode()}, "success": True, "errors": []}
    with respx.mock as mock:
        mock.post(url(voice.TTS_MODEL)).mock(return_value=Response(200, json=payload))
        got = await voice.speak("One line.")
    assert got.audio == b"mp3bytes"


async def test_transcribe_base64s_the_clip_and_reads_the_segments():
    # The real payload (2026-09-23): segments + transcription_info, no per-word array.
    payload = {
        "result": {
            "text": "I ran the migration.  ",
            "segments": [{"start": 0, "end": 2.1, "text": " I ran the migration."}],
            "transcription_info": {"duration": 90.2, "language": "en"},
            "usage": {"neurons": 87.26},
        },
        "success": True,
        "errors": [],
    }
    with respx.mock as mock:
        route = mock.post(url(voice.STT_MODEL)).mock(return_value=Response(200, json=payload))
        got = await voice.transcribe(CLIP)
    assert got.text == "I ran the migration."  # stripped: the answer box owns whitespace
    assert got.segments[0]["end"] == 2.1
    assert got.language == "en"
    sent = route.calls[0].request.content
    # The clip must survive the round trip byte for byte, or every transcription is of something else.
    assert base64.b64decode(__import__("json").loads(sent)["audio"]) == CLIP
    assert b'"task":"transcribe"' in sent


async def test_a_failed_envelope_is_a_sentence_not_a_keyerror():
    payload = {"success": False, "errors": [{"code": 7000, "message": "No more neurons for today"}], "messages": []}
    with respx.mock as mock:
        mock.post(url(voice.STT_MODEL)).mock(return_value=Response(200, json=payload))
        with pytest.raises(voice.VoiceError, match="No more neurons for today"):
            await voice.transcribe(CLIP)


async def test_refusals_and_a_dead_provider_become_visitor_sentences():
    with respx.mock as mock:
        mock.post(url(voice.TTS_MODEL)).mock(return_value=Response(429, json={}))
        with pytest.raises(voice.VoiceError, match="daily limit"):
            await voice.speak("One line.")
    with respx.mock as mock:
        mock.post(url(voice.TTS_MODEL)).mock(side_effect=ConnectError("blackholed"))
        with pytest.raises(voice.VoiceError, match="did not answer"):
            await voice.speak("One line.")


async def test_caps_refuse_before_anything_leaves_the_pod(monkeypatch):
    monkeypatch.setattr(voice, "MAX_TTS_CHARS", 5)
    monkeypatch.setattr(voice, "MAX_UPLOAD_BYTES", 10)
    monkeypatch.setattr(voice, "ACCOUNT_ID", "")
    with respx.mock(assert_all_called=False) as mock:
        mock.post(url(voice.TTS_MODEL)).mock(return_value=Response(200, content=b"x"))
        mock.post(url(voice.STT_MODEL)).mock(return_value=Response(200, json={"result": {"text": ""}}))
        with pytest.raises(voice.VoiceError, match="longer than 5 characters"):
            await voice.speak("six characters")
        with pytest.raises(voice.VoiceError, match="larger than 0 MB"):
            await voice.transcribe(CLIP)
        monkeypatch.setattr(voice, "ACCOUNT_ID", ACCOUNT)
        with pytest.raises(voice.VoiceError, match="not in a format"):
            await voice.transcribe(b"nope")
        monkeypatch.setattr(voice, "ACCOUNT_ID", "")
        with pytest.raises(voice.VoiceError, match="not configured"):
            await voice.speak("hi")


def test_capability_moves_both_directions_together(monkeypatch):
    monkeypatch.setattr(voice, "ACCOUNT_ID", "")
    monkeypatch.setattr(voice, "API_TOKEN", "")
    assert voice.capability() == {"tts": False, "stt": False, "tts_model": voice.TTS_MODEL, "stt_model": voice.STT_MODEL}
    monkeypatch.setattr(voice, "ACCOUNT_ID", ACCOUNT)
    monkeypatch.setattr(voice, "API_TOKEN", TOKEN)
    assert voice.capability()["tts"] and voice.capability()["stt"]
