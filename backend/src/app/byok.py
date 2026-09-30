"""BYOK: per-owner OpenAI-compatible provider credentials (the settings panel's key field).

- One row per owner in `llm_credentials`, written only from /settings/llm. The key is stored
  Fernet-encrypted under BYOK_ENCRYPTION_KEY; the DB never holds plaintext. A keyless row is valid
  BYOK: self-hosted endpoints authenticate nothing, and no key just means no Authorization header.
- Resolution is per request and REPLACES the system LLM_* config for that owner (chat,
  grader and formatter alike, see llm.grader_config).
- BYOK is optional by construction: no encryption key, no row, or an undecryptable row all
  fall back to the system default. A settings problem must never take interviews down.
- The deployment's OWN provider (while it needs no key) and anything off the public internet are
  not valid targets (`_base_url`): `byok` is self-asserted and swaps the tier cap for a flat
  ceiling, so either one is a free ride on, or a probe into, this deployment's own infrastructure.

See BYOK.md for the contract, endpoints and threat notes.
"""

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
# Fork pointing at its own localhost Ollama/LM Studio flips this. The hosted deployment must not:
# BYOK is attacker-controlled, so allowing it turns the backend into a probe into its own network
# (BYOK.md, `_base_url`).
ALLOW_PRIVATE_HOSTS = os.getenv("BYOK_ALLOW_PRIVATE_HOSTS", "").lower() == "true"


@lru_cache(maxsize=1)
def _fernet() -> Fernet | None:
    """The row cipher, or None when BYOK_ENCRYPTION_KEY is unset/malformed (feature off). Cached: the env
    cannot change under a running process. A test that monkeypatches the env clears it
    (`byok._fernet.cache_clear()`)."""
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
    """Host + port of a base URL, normalised for comparison. The scheme is deliberately dropped: the same
    listener behind http and https is the same listener. An IPv4-mapped IPv6 literal (`[::ffff:100.64.2.2]`)
    is unwrapped to the IPv4 it is."""
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
    """True when `host` is an IP literal that is NOT on the public internet. `is_global`, not `is_private`:
    this Python reports 100.64.0.0/10 (CGNAT, i.e. Tailscale) as NOT private, and that is where a
    self-hosted model lives. Also covers RFC1918, loopback, link-local (169.254.169.254/IMDS), ULA,
    reserved and `0.0.0.0`."""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return not (getattr(ip, "ipv4_mapped", None) or ip).is_global


async def _resolve(host: str) -> list[str]:
    """The addresses `host` resolves to, [] when it does not resolve (or the lookup times out). A name is
    not evidence of a public target (`evil.example A 100.64.2.2` is one DNS record away), so the address
    check runs on what the name points at too. Unresolvable is ALLOWED: the call fails at use time anyway,
    and a save must not depend on this deployment's resolver being up."""
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
    # This deployment's OWN provider is never valid BYOK while IT NEEDS NO KEY: a junk key passes and the
    # owner trades the tier cap for the higher BYOK ceiling while our GPU pays. Gated on `api_key`, so the
    # documented DeepSeek swap closes it without locking out owners bringing their own key.
    own = llm.SYSTEM_CONFIG
    if not own.stub and not own.api_key and _origin(raw) == _origin(own.base_url):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="That is this deployment's own provider. BYOK is for an endpoint you pay for - point it at your own, or clear it to use the system default.")
    # Anything off the public internet is refused: the backend makes the request, so a private `base_url`
    # is a probe into this deployment's own network (tailnet, LAN, k8s API, node metadata).
    # AI HERE: resolved at SAVE time only, so DNS rebinding gets through. Upgrade: re-check per call.
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
    """The LLM target for this request: the owner's own provider when usable, else the system default."""
    fernet = _fernet()
    row = await _row(user.sub) if fernet else None
    if row is None:
        return llm.SYSTEM_CONFIG
    try:
        key = fernet.decrypt(row["api_key"].encode()).decode()
    except (InvalidToken, ValueError, UnicodeDecodeError):
        # BYOK_ENCRYPTION_KEY rotated/restored wrong: the stored key is unrecoverable. Degrade to the
        # system provider; the panel then reads "system default" and the user re-saves.
        log.warning("byok.undecryptable_row")
        return llm.SYSTEM_CONFIG
    return llm.LLMConfig(base_url=row["base_url"], model=row["model"], api_key=key, byok=True)


async def save(owner_id: str, base_url: str, model: str, api_key: str) -> None:
    """Create/update the owner's provider row. A supplied `api_key` is encrypted and becomes the saved key.
    An empty one keeps the stored key (so base URL and model stay editable without re-pasting), and on the
    FIRST save it means the endpoint needs no auth at all (Ollama, llama.cpp, vLLM)."""
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
        # Empty means "keep the stored key" on an existing row and "no key at all" on a new one: self-hosted
        # endpoints authenticate nothing, so a keyless row is legitimate BYOK. Storing the encrypted empty
        # string keeps the reuse rule uniform.
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
    """Settings-panel status. Carries the key's last 4 characters as a hint, NEVER the key."""
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
    """Probe the SAVED config (never a request body: no arbitrary URL+key fetch from here)."""
    config = await resolve_config(user)
    if not config.byok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Save a provider first - there is nothing to test.")
    ok, detail = await llm.test_provider(config)
    return {"ok": ok, "detail": detail}
