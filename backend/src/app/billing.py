"""M10 billing/quota enforcement (MONETIZATION.md).

Simple tier model: Free / Premium / dev(-only). Backend-authoritative.

- **Entitlement (`tier`)**: source of truth is `ClerkUser.tier` (JWT claim), merged with any
  active `premium` row in the `subscriptions` table so billing can elevate even when the JWT is
  stale. Default `"free"`.
- **`dev` tier**: only for the no-Clerk dev-fallback identity (`CLERK_ENABLED=false`, i.e. the
  fixed `DEV_USER`). `main.py`'s D2 guard refuses to boot with `CLERK_ENABLED=false` outside
  development/test, so `dev` can never leak to production. Never persisted in `subscriptions`.
- **Quotas**: a single daily chat-turn credits per owner is the only gate — free = 10,
  premium = 250, dev = 500 (across ALL the owner's interviews in one UTC day). No
  per-interview cap and no token metering (decisions 2026-08-23 / this change).
"""

import os
from datetime import UTC, date, datetime

from fastapi import HTTPException, status

from app.auth import CLERK_ENABLED
from app.db import fetchrow
from app.models import ClerkUser

# --- tier limits (env-overridable; MONETIZATION.md §0 placeholders) ---
# Daily GLOBAL chat-turn credits PER OWNER (across all interviews in one UTC day),
# reset at 00:00:00 UTC.
FREE_CHAT_TURNS = int(os.getenv("FREE_CHAT_TURNS", "10"))
PREMIUM_CHAT_TURNS = int(os.getenv("PREMIUM_CHAT_TURNS", "250"))
DEV_CHAT_TURNS = int(os.getenv("DEV_CHAT_TURNS", "500"))  # dev > premium

LIMITS = {
    "free": {"chat_turns": FREE_CHAT_TURNS},
    "premium": {"chat_turns": PREMIUM_CHAT_TURNS},
    "dev": {"chat_turns": DEV_CHAT_TURNS},
}


async def resolve_tier(user: ClerkUser) -> str:
    if not CLERK_ENABLED:
        return "dev"
    if user.tier == "premium":
        return "premium"
    row = await fetchrow("SELECT plan FROM subscriptions WHERE owner_id = $1 AND plan = 'premium' AND status = 'active'", user.sub)
    return "premium" if row else "free"


def _quota(tier: str, what: str) -> float:
    limits = LIMITS.get(tier, LIMITS["free"])
    if what not in limits:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"No quota configured for tier={tier} {what}")
    return limits[what]


def _utc_day() -> date:
    return datetime.now(UTC).date()


async def chat_turns_used(owner_id: str) -> int:
    row = await fetchrow(
        "SELECT turns FROM turn_usage WHERE owner_id = $1 AND day = $2",
        owner_id,
        _utc_day(),
    )
    return (row["turns"] or 0) if row else 0


async def chat_turn_remaining(tier: str, owner_id: str) -> int:
    limit = _quota(tier, "chat_turns")
    return max(0, int(limit) - await chat_turns_used(owner_id))


async def bump_chat_turn(owner_id: str) -> None:
    await fetchrow(
        "INSERT INTO turn_usage (owner_id, day, turns) VALUES ($1, $2, 1) ON CONFLICT (owner_id, day) DO UPDATE SET turns = turn_usage.turns + 1",
        owner_id,
        _utc_day(),
    )
