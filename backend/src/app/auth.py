import base64
import os
import time

import httpx
import jwt
import structlog
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException, Request, status

from app.models import ClerkUser

log = structlog.get_logger(__name__)

# Single source of truth for auth config — main.py imports CLERK_ENABLED for the boot guard.
CLERK_ENABLED = os.getenv("CLERK_ENABLED", "false").lower() == "true"
CLERK_DOMAIN = os.getenv("CLERK_DOMAIN", "")
CLERK_JWKS_URL = os.getenv("CLERK_JWKS_URL", "")
CLERK_AUDIENCE = os.getenv("CLERK_AUDIENCE", "")
# Backend API credential, needed only for the user lookup below (billing needs an email address,
# which the session token does not carry). Empty = claim-only, exactly the old behaviour.
CLERK_SECRET_KEY = os.getenv("CLERK_SECRET_KEY", "")
# The Backend API has its OWN host: CLERK_DOMAIN is the frontend/JWKS instance and answers 404 for
# /v1/users (verified). Overridable for a non-US Clerk host.
CLERK_API_BASE = os.getenv("CLERK_API_BASE", "https://api.clerk.com")

# Clerk stamps `iat` from ITS clock and PyJWT rejects `iat > now` outright, so an app a fraction of a
# second behind 401s a brand-new session's FIRST request (verified live 2026-09-12: fresh session
# JWT -> 401, same token -> 200 one second later). This leeway also applies to `nbf`/`exp`.
JWT_LEEWAY_S = 10

# Fixed identity used only when CLERK_ENABLED=false (dev/test only — main.py guard enforces).
DEV_USER = ClerkUser(sub="dev-user", email="dev@example.com", name="Dev User")

# Clerk Backend API lookups: {sub: (expires_at, email)}; TTL 1h, same reasoning as the JWKS cache.
_USER_EMAIL_TTL_S = 3600
_user_email_cache: dict[str, tuple[float, str]] = {}

# JWKS cache: {keys, fetched_at}; TTL 1h; on `kid`-miss re-fetch once (key rotation).
_JWKS_CACHE_TTL_S = 3600
_jwks_cache: dict | None = None
_jwks_cache_at: float = 0.0


def _b64url_decode(value: str) -> bytes:
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
            leeway=JWT_LEEWAY_S,
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


async def user_email(user: ClerkUser) -> str | None:
    """The user's primary email: the JWT claim when present, else Clerk's Backend API.

    Clerk's DEFAULT session token carries no `email` claim (verified: exp, fva, iat, iss, nbf, sid,
    sts, sub, v), so relying on the claim refuses every real user. Cached per process because the
    caller (billing) wants it once per purchase, not once per request.

    None means "no address available" — a Clerk outage must not 500 a route that merely wants one.
    """
    if user.email:
        return user.email
    if not (CLERK_SECRET_KEY and CLERK_DOMAIN):
        return None
    cached = _user_email_cache.get(user.sub)
    if cached and cached[0] > time.time():
        return cached[1]
    try:
        async with httpx.AsyncClient(base_url=CLERK_API_BASE, timeout=10) as client:
            res = await client.get(f"/v1/users/{user.sub}", headers={"Authorization": f"Bearer {CLERK_SECRET_KEY}"})
        res.raise_for_status()
        email = _primary_email(res.json())
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("clerk.user_lookup_failed", sub=user.sub, reason=type(exc).__name__)
        return None
    if email:
        # AI HERE: one entry per user who reaches checkout, never evicted. A cap or a shared cache
        # only matters if this lookup moves off the purchase path.
        _user_email_cache[user.sub] = (time.time() + _USER_EMAIL_TTL_S, email)
    return email


def _primary_email(body: dict) -> str | None:
    addresses = body.get("email_addresses") or []
    primary = body.get("primary_email_address_id")
    for addr in addresses:
        if addr.get("id") == primary and addr.get("email_address"):
            return addr["email_address"]
    # No primary flag, or it points nowhere: any address beats refusing a paying customer.
    return next((a["email_address"] for a in addresses if a.get("email_address")), None)


def _extract_token(request: Request) -> str | None:
    # __session cookie is primary (app/auth.py); Bearer accepted for API clients/tests.
    token = request.cookies.get("__session")
    if token:
        return token
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def _attributed(request: Request, user: ClerkUser) -> ClerkUser:
    """Record the identity on the request so the access log can attribute the line: it reads
    `scope["state"]` after the route ran, and a contextvar could not carry the value back up past the
    rate limiter, which is a `BaseHTTPMiddleware`."""
    request.state.user_sub = user.sub
    return user


async def get_current_user(request: Request) -> ClerkUser:
    if not CLERK_ENABLED:
        return _attributed(request, DEV_USER)
    token = _extract_token(request)
    if token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing credentials")
    return _attributed(request, verify_jwt(token, _fetch_jwks()))
