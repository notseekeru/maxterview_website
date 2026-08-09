import os

from fastapi import HTTPException, Request, status

from app.models import ClerkUser

# Single source of truth for auth config — main.py imports CLERK_ENABLED for the D2 boot guard.
CLERK_ENABLED = os.getenv("CLERK_ENABLED", "false").lower() == "true"

# Fixed identity used only when CLERK_ENABLED=false (dev/test only — main.py guard enforces).
DEV_USER = ClerkUser(sub="dev-user", email="dev@example.com", name="Dev User")


def _fetch_jwks() -> dict:
    """Fetch Clerk's JWKS — the I/O boundary, stubbed until pre-ship.

    Real impl: GET CLERK_JWKS_URL; cache with TTL (~1h); on `kid`-miss, re-fetch once (key rotation).
    """
    raise NotImplementedError("Clerk JWKS fetch lands pre-ship; use CLERK_ENABLED=false in dev/test")


def verify_jwt(token: str, jwks: dict) -> ClerkUser:
    """Pure JWT verification against JWKS — stubbed until pre-ship.

    Contracts for the real implementation (locked):
    - RS256 only; reject `none`/HS256 (PyJWT: pin algorithms=["RS256"]).
    - Select public key by header `kid` from `jwks`.
    - Validate `iss` (CLERK_DOMAIN) and `exp`; validate `aud` ONLY if CLERK_AUDIENCE is set.
    - Raise HTTPException(401) on any failure (no token details leaked).
    """
    raise NotImplementedError("Clerk JWT verification lands pre-ship; use CLERK_ENABLED=false in dev/test")


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
