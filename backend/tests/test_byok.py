"""BYOK unit tests: encryption, validation, resolution fallbacks, and the probe's hygiene.

Pure-logic: `db.fetchrow` is monkeypatched, so no live pool is needed. Endpoint-level coverage
(clerk identity -> owner scoping) rides on the existing /api integration tests.
"""

import json

import pytest
import respx
from cryptography.fernet import Fernet
from fastapi import HTTPException
from httpx import Response

from app import byok, llm
from app.models import ClerkUser


def _user(sub="user_byok"):
    return ClerkUser(sub=sub)


@pytest.fixture(autouse=True)
def encryption_key(monkeypatch):
    monkeypatch.setenv("BYOK_ENCRYPTION_KEY", Fernet.generate_key().decode())
    byok._fernet.cache_clear()
    yield
    byok._fernet.cache_clear()


def _capture(monkeypatch, existing=None):
    """Record every DB call; the SELECT that looks up the current row returns `existing`."""
    calls = []

    async def _fetchrow(query, *args):
        calls.append((query, args))
        return existing if query.strip().upper().startswith("SELECT") else {"ok": 1}

    monkeypatch.setattr(byok, "fetchrow", _fetchrow)
    return calls


def _write(calls):
    return next(c for c in calls if c[0].strip().upper().startswith("INSERT"))


async def test_save_stores_ciphertext_and_only_a_hint(monkeypatch):
    calls = _capture(monkeypatch)
    key = "sk-test-abcdefgh-1234"
    await byok.save("user_byok", "https://api.openai.com/v1/", "gpt-4o-mini", key)

    _, args = _write(calls)
    owner, base_url, model, cipher, hint = args
    assert (owner, base_url, model) == ("user_byok", "https://api.openai.com/v1", "gpt-4o-mini")
    assert cipher != key and key not in cipher  # the DB gets ciphertext, never the key
    assert byok._fernet().decrypt(cipher.encode()).decode() == key
    assert hint == "1234"  # last 4 only: enough to identify the key in the UI, not to use it


async def test_update_without_a_key_reuses_the_stored_ciphertext(monkeypatch):
    stored = {"base_url": "https://old", "model": "old", "api_key": "cipher-old", "key_hint": "9999"}
    calls = _capture(monkeypatch, existing=stored)
    await byok.save("user_byok", "https://api.deepseek.com", "deepseek-chat", "")

    _, args = _write(calls)
    assert args[3:] == ("cipher-old", "9999")  # base URL + model changed, key untouched


async def test_first_save_without_a_key_is_a_keyless_row(monkeypatch):
    # Self-hosted BYOK (Ollama/llama.cpp/vLLM): no key exists, and none is required. Stored as the
    # encrypted empty string so "empty = keep the key" stays one uniform rule.
    calls = _capture(monkeypatch, existing=None)
    await byok.save("user_byok", "http://localhost:11434/v1", "qwen3:8b", "")

    _, args = _write(calls)
    assert args[3] != ""  # still ciphertext, not a bare empty string
    assert byok._fernet().decrypt(args[3].encode()).decode() == ""
    assert args[4] == ""  # no hint to show


async def test_keyless_row_resolves_without_an_authorization_header(monkeypatch):
    _capture(monkeypatch, existing={"base_url": "http://192.168.1.9:8080/v1", "model": "qwen", "api_key": byok._fernet().encrypt(b"").decode(), "key_hint": ""})

    config = await byok.resolve_config(_user())
    assert (config.byok, config.api_key) == (True, "")
    # No key means no Authorization header at all (not an empty Bearer token).
    assert llm._headers(config) == {}
    assert (await byok.public_view(_user()))["key_hint"] is None


@pytest.mark.parametrize(
    ("base_url", "model", "key"),
    [
        ("ftp://api.openai.com", "gpt-4o-mini", "sk-test-abcdefgh"),  # not http(s)
        ("api.openai.com/v1", "gpt-4o-mini", "sk-test-abcdefgh"),  # no scheme/host
        ("https://user:pw@api.openai.com/v1", "gpt-4o-mini", "sk-test-abcdefgh"),  # credentials in URL
        ("https://api.openai.com/v1?x=1", "gpt-4o-mini", "sk-test-abcdefgh"),  # query
        ("https://api.openai.com/v1", "", "sk-test-abcdefgh"),  # no model
        ("https://api.openai.com/v1", "gpt-4o-mini", "short"),  # key floor
        ("https://api.openai.com/v1", "gpt-4o-mini", "sk-two words"),  # key must be header-safe
    ],
)
async def test_save_rejects_malformed_input(monkeypatch, base_url, model, key):
    _capture(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        await byok.save("user_byok", base_url, model, key)
    assert exc.value.status_code == 422


async def test_save_is_unavailable_without_an_encryption_key(monkeypatch):
    monkeypatch.delenv("BYOK_ENCRYPTION_KEY", raising=False)
    byok._fernet.cache_clear()
    _capture(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        await byok.save("user_byok", "https://api.openai.com/v1", "gpt-4o-mini", "sk-test-abcdefgh")
    assert exc.value.status_code == 503
    assert byok.enabled() is False


async def test_save_is_unavailable_when_the_encryption_key_is_malformed(monkeypatch):
    monkeypatch.setenv("BYOK_ENCRYPTION_KEY", "not-a-fernet-key")
    byok._fernet.cache_clear()
    assert byok.enabled() is False  # fail closed; the app still boots


async def test_resolve_falls_back_to_the_system_default_without_a_row(monkeypatch):
    _capture(monkeypatch, existing=None)
    assert await byok.resolve_config(_user()) == llm.SYSTEM_CONFIG


async def test_resolve_falls_back_when_the_ciphertext_cannot_be_decrypted(monkeypatch):
    # Simulates a rotated BYOK_ENCRYPTION_KEY: interviews keep working on the system provider.
    foreign = Fernet(Fernet.generate_key()).encrypt(b"sk-lost-key").decode()
    _capture(monkeypatch, existing={"base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini", "api_key": foreign, "key_hint": "-key"})
    assert await byok.resolve_config(_user()) == llm.SYSTEM_CONFIG


async def test_resolve_returns_the_owners_config_and_derives_the_grader(monkeypatch):
    key = "sk-test-abcdefgh"
    _capture(monkeypatch, existing={"base_url": "https://openrouter.ai/api/v1", "model": "openai/gpt-4o-mini", "api_key": byok._fernet().encrypt(key.encode()).decode(), "key_hint": "fgh"})

    config = await byok.resolve_config(_user())
    assert (config.base_url, config.model, config.api_key, config.byok) == ("https://openrouter.ai/api/v1", "openai/gpt-4o-mini", key, True)
    # One provider for both stages: the grader falls back to the owner's target, key included.
    assert llm.grader_config(config) == config


async def test_public_view_never_returns_the_key(monkeypatch):
    key = "sk-test-abcdefgh"
    _capture(monkeypatch, existing={"base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini", "api_key": byok._fernet().encrypt(key.encode()).decode(), "key_hint": "fgh"})

    view = await byok.public_view(_user())
    assert view["byok"] is True
    assert view["key_hint"] == "fgh"
    assert "api_key" not in view
    assert key not in json.dumps(view)  # not even in a nested field added later


async def test_clear_deletes_the_row(monkeypatch):
    calls = _capture(monkeypatch)
    await byok.clear("user_byok")
    assert calls[0][0].strip().upper().startswith("DELETE")
    assert calls[0][1] == ("user_byok",)


async def test_probe_reports_success_and_sends_the_key():
    with respx.mock(base_url="https://api.openai.com/v1") as mock:
        route = mock.post("/chat/completions").mock(return_value=Response(200, json={"choices": [{"message": {"content": "pong"}}]}))
        ok, detail = await llm.test_provider(llm.LLMConfig(base_url="https://api.openai.com/v1", model="gpt-4o-mini", api_key="sk-test-abcdefgh"))
    assert ok is True
    assert "gpt-4o-mini" in detail
    assert route.calls[0].request.headers["authorization"] == "Bearer sk-test-abcdefgh"


async def test_probe_never_echoes_the_body_or_the_key():
    # The provider body is untrusted: it can echo the request, and the request carries the key.
    with respx.mock(base_url="https://api.openai.com/v1") as mock:
        mock.post("/chat/completions").mock(return_value=Response(401, json={"error": {"message": "invalid key sk-test-abcdefgh"}}))
        ok, detail = await llm.test_provider(llm.LLMConfig(base_url="https://api.openai.com/v1", model="gpt-4o-mini", api_key="sk-test-abcdefgh"))
    assert ok is False
    assert "401" in detail
    assert "sk-test-abcdefgh" not in detail


async def test_test_endpoint_refuses_to_probe_without_a_saved_provider(monkeypatch):
    _capture(monkeypatch, existing=None)
    with pytest.raises(HTTPException) as exc:
        await byok.test(_user())
    assert exc.value.status_code == 400
