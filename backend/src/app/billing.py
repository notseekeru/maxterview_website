"""M10 billing/quota enforcement (MONETIZATION.md).

Simple tier model: Free / Premium / dev(-only). Backend-authoritative.

- **Entitlement (`tier`)**: source of truth is `ClerkUser.tier` (JWT claim), merged with any
  active `premium` row in the `subscriptions` table so billing can elevate even when the JWT is
  stale. Default `"free"`.
- **`dev` tier**: only for the no-Clerk dev-fallback identity (`CLERK_ENABLED=false`, i.e. the
  fixed `DEV_USER`). `main.py`'s D2 guard refuses to boot with `CLERK_ENABLED=false` outside
  development/test, so `dev` can never leak to production. Never persisted in `subscriptions`.
- **Quotas**: chat-turn cap per interview is the only gate — free = K, premium = M, dev = D (>M).
  No daily-interview limit (removed) and no token metering (decision 2026-08-23).

"""

import os

from fastapi import HTTPException, status

from app.auth import CLERK_ENABLED
from app.db import fetchrow
from app.models import ClerkUser

# --- tier limits (env-overridable; MONETIZATION.md §0 placeholders) ---
FREE_CHAT_TURNS = int(os.getenv("FREE_CHAT_TURNS", "8"))
PREMIUM_CHAT_TURNS = int(os.getenv("PREMIUM_CHAT_TURNS", "100"))
DEV_CHAT_TURNS = int(os.getenv("DEV_CHAT_TURNS", "500"))  # dev > premium

LIMITS = {
    # chat-turn cap per interview is the only quota (daily-interview cap removed).
    "free": {"chat_turns": FREE_CHAT_TURNS},
    "premium": {"chat_turns": PREMIUM_CHAT_TURNS},
    "dev": {"chat_turns": DEV_CHAT_TURNS},
}


async def resolve_tier(user: ClerkUser) -> str:
    """Effective tier = ClerkUser.tier, escalated by an active premium subscription.

    `dev` is granted only to the no-Clerk dev-fallback identity (DEV_USER). With
    CLERK_ENABLED=false the only possible user IS that fixed identity (auth always returns
    DEV_USER), and the D2 boot guard confines CLERK_ENABLED=false to development/test, so
    `dev` is unreachable in production."""
    if not CLERK_ENABLED:
        return "dev"
    if user.tier == "premium":
        return "premium"
    row = await fetchrow("SELECT plan FROM subscriptions WHERE owner_id = $1 AND plan = 'premium' AND status = 'active'", user.sub)
    return "premium" if row else "free"


def _quota(tier: str, what: str) -> float:
    """Return the limit; raise if the tier has no configured quota for `what`."""
    limits = LIMITS.get(tier, LIMITS["free"])
    if what not in limits:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"No quota configured for tier={tier} {what}")
    return limits[what]


async def chat_turn_remaining(tier: str, interview_id: str) -> int:
    """Remaining user turns for this interview (0 at/over cap)."""
    limit = _quota(tier, "chat_turns")
    if limit == float("inf"):
        return -1
    row = await fetchrow(
        "SELECT chat_turns FROM interviews WHERE id = $1",
        interview_id,
    )
    used = (row["chat_turns"] or 0) if row else 0
    return max(0, int(limit) - used)


async def bump_chat_turn(interview_id: str) -> None:
    """Increment the per-interview user-turn counter (called when a user turn is accepted)."""
    await fetchrow(
        "UPDATE interviews SET chat_turns = chat_turns + 1 WHERE id = $1 RETURNING id",
        interview_id,
    )
