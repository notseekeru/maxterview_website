import asyncio
import ipaddress
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
# Long enough to be a key, and no whitespace: it goes verbatim into an Authorization header, where a
# stray space or newline is a malformed (or injected) request.
_KEY_MIN, _KEY_MAX = 8, 500
_DNS_TIMEOUT_S = 5
# Attacker-controlled: a private host turns the backend into a probe of its own network.
ALLOW_PRIVATE_HOSTS = os.getenv("BYOK_ALLOW_PRIVATE_HOSTS", "").lower() == "true"


@lru_cache(maxsize=1)
def _fernet() -> Fernet | None:
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


def _origin(raw: str) -> tuple[str, int]:
    url = urlparse(raw)
    host = (url.hostname or "").lower().rstrip(".")
    try:
        ip = ipaddress.ip_address(host)
        host = str(getattr(ip, "ipv4_mapped", None) or ip)
    except ValueError:
        pass  # a DNS name: compared as written, so a second name for the same host passes
    try:
        port = url.port
    except ValueError:
        port = None  # unparseable port: httpx refuses the URL at call time, exactly as before
    return host, port or (443 if url.scheme == "https" else 80)


def _offnet(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return not (getattr(ip, "ipv4_mapped", None) or ip).is_global


async def _resolve(host: str) -> list[str]:
    try:
        async with asyncio.timeout(_DNS_TIMEOUT_S):
            infos = await asyncio.get_running_loop().getaddrinfo(host, None)
    except OSError:
        return []
    return [info[4][0] for info in infos]


async def _base_url(raw: str) -> str:
    url = urlparse(raw.strip().rstrip("/"))
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Base URL must look like https://api.openai.com/v1 (http/https, no credentials, no query).")
    # A junk key against our own keyless provider trades the tier cap for the BYOK ceiling.
    own = llm.SYSTEM_CONFIG
    if not own.stub and not own.api_key and _origin(raw) == _origin(own.base_url):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="That is this deployment's own provider. BYOK is for an endpoint you pay for - point it at your own, or clear it to use the system default.")
    # Resolved at SAVE only, so DNS rebinding gets through.
    if not ALLOW_PRIVATE_HOSTS:
        host = url.hostname or ""
        if _offnet(host) or any(_offnet(addr) for addr in await _resolve(host)):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="That address is inside a private network, or a name that points into one. BYOK needs a provider reachable on the public internet - this deployment's own model and internal services are off limits.")
    return url.geturl().rstrip("/")


def _key(raw: str) -> str:
    key = raw.strip()
    if not _KEY_MIN <= len(key) <= _KEY_MAX or any(c.isspace() for c in key):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="That does not look like an API key: 8-500 characters, no spaces.")
    return key


async def _row(owner_id: str):
    return await fetchrow("SELECT base_url, model, api_key, key_hint FROM llm_credentials WHERE owner_id = $1", owner_id)


async def resolve_config(user: ClerkUser) -> llm.LLMConfig:
    fernet = _fernet()
    row = await _row(user.sub) if fernet else None
    if row is None:
        return llm.SYSTEM_CONFIG
    try:
        key = fernet.decrypt(row["api_key"].encode()).decode()
    except (InvalidToken, ValueError, UnicodeDecodeError):
        # Rotated wrong: the stored key is unrecoverable, so the user must re-save.
        log.warning("byok.undecryptable_row")
        return llm.SYSTEM_CONFIG
    return llm.LLMConfig(base_url=row["base_url"], model=row["model"], api_key=key, byok=True)


async def save(owner_id: str, base_url: str, model: str, api_key: str) -> None:
    fernet = _fernet()
    if fernet is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=DISABLED_DETAIL)
    base_url = await _base_url(base_url)
    model = model.strip()
    if not model:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="A model id is required.")
    if api_key:
        key = _key(api_key)
        cipher, hint = fernet.encrypt(key.encode()).decode(), key[-4:]
    else:
        # Empty is legitimate on a first save: self-hosted endpoints authenticate nothing.
        existing = await _row(owner_id)
        cipher, hint = (existing["api_key"], existing["key_hint"]) if existing else (fernet.encrypt(b"").decode(), "")
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
    row = await _row(user.sub) if _fernet() else None
    system = llm.SYSTEM_CONFIG
    return {
        "enabled": enabled(),
        "byok": row is not None,
        "base_url": row["base_url"] if row else "",
        "model": row["model"] if row else "",
        "key_hint": (row["key_hint"] or None) if row else None,
        "system": {"configured": not system.stub, "base_url": system.base_url, "model": system.model},
    }


async def test(user: ClerkUser) -> dict:
    config = await resolve_config(user)
    if not config.byok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Save a provider first - there is nothing to test.")
    ok, detail = await llm.test_provider(config)
    return {"ok": ok, "detail": detail}
