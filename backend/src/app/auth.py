import base64
import os
import time

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException, Request, status

from app.models import ClerkUser

# Single source of truth for auth config — main.py imports CLERK_ENABLED for the D2 boot guard.
CLERK_ENABLED = os.getenv("CLERK_ENABLED", "false").lower() == "true"
CLERK_DOMAIN = os.getenv("CLERK_DOMAIN", "")
CLERK_JWKS_URL = os.getenv("CLERK_JWKS_URL", "")
CLERK_AUDIENCE = os.getenv("CLERK_AUDIENCE", "")

# Fixed identity used only when CLERK_ENABLED=false (dev/test only — main.py guard enforces).
DEV_USER = ClerkUser(sub="dev-user", email="dev@example.com", name="Dev User")

# JWKS cache: {keys, fetched_at}; TTL 1h; on `kid`-miss re-fetch once (key rotation).
_JWKS_CACHE_TTL_S = 3600
_jwks_cache: dict | None = None
_jwks_cache_at: float = 0.0


def _b64url_decode(value: str) -> bytes:
    # JWKS n/e are base64url without padding.
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _public_key_from_jwk(jwk: dict) -> rsa.RSAPublicKey:
    n = int.from_bytes(_b64url_decode(jwk["n"]), "big")
    e = int.from_bytes(_b64url_decode(jwk["e"]), "big")
    pub = rsa.RSAPublicNumbers(e, n).public_key()
    return pub


def _fetch_jwks() -> dict:
    """Fetch (and cache) Clerk's JWKS — GET CLERK_JWKS_URL, TTL ~1h, kid-miss re-fetch once."""
    global _jwks_cache, _jwks_cache_at
    now = time.time()
    if _jwks_cache is not None and (now - _jwks_cache_at) < _JWKS_CACHE_TTL_S:
        return _jwks_cache
    resp = httpx.get(CLERK_JWKS_URL, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    _jwks_cache = data
    _jwks_cache_at = now
    return data


def verify_jwt(token: str, jwks: dict) -> ClerkUser:
    """Verify a Clerk JWT against JWKS (RS256, kid, iss/aud/exp) → ClerkUser.

    Raises HTTPException(401) on any failure, with no token details leaked.
    aud is validated ONLY if CLERK_AUDIENCE is set (empty default in .env.example).
    """
    try:
        headers = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise _unauthorized() from exc

    if headers.get("alg") != "RS256":
        raise _unauthorized()

    jwk = next((k for k in jwks.get("keys", []) if k.get("kid") == headers.get("kid")), None)
    if jwk is None:
        raise _unauthorized()

    pub = _public_key_from_jwk(jwk)
    pem = pub.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    options = {"verify_aud": False} if not CLERK_AUDIENCE else {}
    try:
        payload = jwt.decode(
            token,
            pem,
            algorithms=["RS256"],
            audience=CLERK_AUDIENCE or None,
            issuer=CLERK_DOMAIN,
            options=options,
        )
    except jwt.PyJWTError as exc:
        raise _unauthorized() from exc

    return ClerkUser(
        sub=payload["sub"],
        email=payload.get("email"),
        name=payload.get("name") or payload.get("first_name"),
        session_id=payload.get("sid"),
    )


def _unauthorized() -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")


def _extract_token(request: Request) -> str | None:
    # __session cookie is primary (PLAN §4); Bearer accepted for API clients/tests.
    token = request.cookies.get("__session")
    if token:
        return token
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


async def get_current_user(request: Request) -> ClerkUser:
    if not CLERK_ENABLED:
        return DEV_USER
    token = _extract_token(request)
    if token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing credentials")
    return verify_jwt(token, _fetch_jwks())
