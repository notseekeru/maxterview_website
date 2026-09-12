"""BYOK: per-owner OpenAI-compatible provider credentials (the settings panel's key field).

- One row per owner in `llm_credentials`, written only from /settings/llm. The key is stored
  Fernet-encrypted under BYOK_ENCRYPTION_KEY; the DB never holds plaintext.
- Resolution is per request and REPLACES the system LLM_* config for that owner (chat,
  grader and formatter alike, see llm.grader_config).
- BYOK is optional by construction: no encryption key, no row, or an undecryptable row all
  fall back to the system default. A settings problem must never take interviews down.

See BYOK.md for the contract, endpoints and threat notes.
"""

import os
from functools import lru_cache
from urllib.parse import urlparse

import structlog
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, status

from app import llm
from app.db import fetchrow
from app.models import ClerkUser

log = structlog.get_logger(__name__)

DISABLED_DETAIL = "BYOK is not enabled on this deployment: set BYOK_ENCRYPTION_KEY on the backend, then save again."
# A key has to be long enough to be a key and must not contain whitespace: it goes verbatim into
# an Authorization header, where a stray space or newline is a malformed (or injected) request.
_KEY_MIN, _KEY_MAX = 8, 500


@lru_cache(maxsize=1)
def _fernet() -> Fernet | None:
    """The row cipher, or None when BYOK_ENCRYPTION_KEY is unset/malformed (feature off).

    Cached: the env cannot change under a running process. A test that monkeypatches the env
    clears the cache (`byok._fernet.cache_clear()`)."""
    raw = os.getenv("BYOK_ENCRYPTION_KEY", "").strip()
    if not raw:
        return None
    try:
        return Fernet(raw.encode())
    except (ValueError, TypeError):
        log.error("byok.encryption_key_invalid")
        return None


def enabled() -> bool:
    return _fernet() is not None


def _base_url(raw: str) -> str:
    url = urlparse(raw.strip().rstrip("/"))
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Base URL must look like https://api.openai.com/v1 (http/https, no credentials, no query).")
    return url.geturl().rstrip("/")


def _key(raw: str) -> str:
    key = raw.strip()
    if not _KEY_MIN <= len(key) <= _KEY_MAX or any(c.isspace() for c in key):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="That does not look like an API key: 8-500 characters, no spaces.")
    return key


async def _row(owner_id: str):
    return await fetchrow("SELECT base_url, model, api_key, key_hint FROM llm_credentials WHERE owner_id = $1", owner_id)


async def resolve_config(user: ClerkUser) -> llm.LLMConfig:
    """The LLM target for this request: the owner's own provider when usable, else the system default."""
    fernet = _fernet()
    row = await _row(user.sub) if fernet else None
    if row is None:
        return llm.SYSTEM_CONFIG
    try:
        key = fernet.decrypt(row["api_key"].encode()).decode()
    except (InvalidToken, ValueError, UnicodeDecodeError):
        # BYOK_ENCRYPTION_KEY was rotated/restored wrong: the stored key is unrecoverable. Degrade
        # to the system provider (the panel then reads "system default"; the user re-saves).
        log.warning("byok.undecryptable_row")
        return llm.SYSTEM_CONFIG
    return llm.LLMConfig(base_url=row["base_url"], model=row["model"], api_key=key, byok=True)


async def save(owner_id: str, base_url: str, model: str, api_key: str) -> None:
    """Create/update the owner's provider row. Empty `api_key` keeps the key already stored,
    so base URL and model stay editable without re-pasting the secret."""
    fernet = _fernet()
    if fernet is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=DISABLED_DETAIL)
    base_url = _base_url(base_url)
    model = model.strip()
    if not model:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="A model id is required.")
    if api_key:
        key = _key(api_key)
        cipher, hint = fernet.encrypt(key.encode()).decode(), key[-4:]
    else:
        existing = await _row(owner_id)
        if existing is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="An API key is required the first time you save provider settings.")
        cipher, hint = existing["api_key"], existing["key_hint"]
    await fetchrow(
        "INSERT INTO llm_credentials (owner_id, base_url, model, api_key, key_hint, updated_at) VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (owner_id) DO UPDATE SET base_url = EXCLUDED.base_url, model = EXCLUDED.model, api_key = EXCLUDED.api_key, key_hint = EXCLUDED.key_hint, updated_at = now()",
        owner_id,
        base_url,
        model,
        cipher,
        hint,
    )


async def clear(owner_id: str) -> None:
    await fetchrow("DELETE FROM llm_credentials WHERE owner_id = $1 RETURNING owner_id", owner_id)


async def public_view(user: ClerkUser) -> dict:
    """Settings-panel status. Carries the key's last 4 characters as a hint, NEVER the key."""
    row = await _row(user.sub) if _fernet() else None
    system = llm.SYSTEM_CONFIG
    return {
        "enabled": enabled(),
        "byok": row is not None,
        "base_url": row["base_url"] if row else "",
        "model": row["model"] if row else "",
        "key_hint": row["key_hint"] if row else None,
        "system": {"configured": not system.stub, "base_url": system.base_url, "model": system.model},
    }


async def test(user: ClerkUser) -> dict:
    """Probe the SAVED config (never a request body: no arbitrary URL+key fetch from here)."""
    config = await resolve_config(user)
    if not config.byok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Save a provider first - there is nothing to test.")
    ok, detail = await llm.test_provider(config)
    return {"ok": ok, "detail": detail}
