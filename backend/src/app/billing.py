import os
from datetime import UTC, date, datetime

from fastapi import HTTPException, status

from app.auth import CLERK_ENABLED
from app.db import fetchrow
from app.models import ClerkUser

# Daily GLOBAL chat-turn credits PER OWNER, across all interviews in one UTC day (MONETIZATION.md §0).
FREE_CHAT_TURNS = int(os.getenv("FREE_CHAT_TURNS", "10"))
PREMIUM_CHAT_TURNS = int(os.getenv("PREMIUM_CHAT_TURNS", "100"))
DEV_CHAT_TURNS = int(os.getenv("DEV_CHAT_TURNS", "100000000"))
BYOK_CHAT_TURNS = int(os.getenv("BYOK_CHAT_TURNS", "300"))
BYOK_PREMIUM_CHAT_TURNS = int(os.getenv("BYOK_PREMIUM_CHAT_TURNS", "5000"))

FREE_RESUMES = int(os.getenv("FREE_RESUMES", "1"))
PREMIUM_RESUMES = int(os.getenv("PREMIUM_RESUMES", "10"))
DEV_RESUMES = int(os.getenv("DEV_RESUMES", "10"))

FREE_REDOS = int(os.getenv("FREE_REDOS", "1"))
PREMIUM_REDOS = int(os.getenv("PREMIUM_REDOS", "10"))
DEV_REDOS = int(os.getenv("DEV_REDOS", "10"))

LIMITS = {
    "free": {"chat_turns": FREE_CHAT_TURNS, "byok_turns": BYOK_CHAT_TURNS, "resumes": FREE_RESUMES, "redos": FREE_REDOS},
    "premium": {"chat_turns": PREMIUM_CHAT_TURNS, "byok_turns": BYOK_PREMIUM_CHAT_TURNS, "resumes": PREMIUM_RESUMES, "redos": PREMIUM_REDOS},
    "dev": {"chat_turns": DEV_CHAT_TURNS, "byok_turns": BYOK_PREMIUM_CHAT_TURNS, "resumes": DEV_RESUMES, "redos": DEV_REDOS},
}

# `cancelled` included: the provider cancels at once but the invoice stays paid.
ENTITLED_STATUSES = ("active", "cancelled")


async def _entitled_row(owner_id: str) -> dict | None:
    return await fetchrow(
        """
        SELECT plan, current_period_end FROM subscriptions
        WHERE owner_id = $1 AND plan = 'premium'
          AND status = ANY($2::text[])
          AND (current_period_end IS NULL OR current_period_end > now())
        """,
        owner_id,
        list(ENTITLED_STATUSES),
    )


async def resolve_tier(user: ClerkUser) -> str:
    if not CLERK_ENABLED:
        return "dev"
    if user.tier == "premium":
        return "premium"
    return "premium" if await _entitled_row(user.sub) else "free"


async def premium_until(owner_id: str) -> datetime | None:
    return ((await _entitled_row(owner_id)) or {}).get("current_period_end")


def _quota(tier: str, what: str) -> float:
    limits = LIMITS.get(tier, LIMITS["free"])
    if what not in limits:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"No quota configured for tier={tier} {what}")
    return limits[what]


def chat_turn_limit(tier: str, byok: bool = False) -> int:
    return int(_quota(tier, "byok_turns" if byok else "chat_turns"))


def redo_limit(tier: str) -> int:
    return int(_quota(tier, "redos"))


def resume_limit(tier: str) -> int:
    return int(_quota(tier, "resumes"))


def _utc_day() -> date:
    return datetime.now(UTC).date()


async def chat_turns_used(owner_id: str) -> int:
    row = await fetchrow(
        "SELECT turns FROM turn_usage WHERE owner_id = $1 AND day = $2",
        owner_id,
        _utc_day(),
    )
    return (row["turns"] or 0) if row else 0


async def bump_chat_turn(owner_id: str) -> None:
    await fetchrow(
        "INSERT INTO turn_usage (owner_id, day, turns) VALUES ($1, $2, 1) ON CONFLICT (owner_id, day) DO UPDATE SET turns = turn_usage.turns + 1",
        owner_id,
        _utc_day(),
    )
