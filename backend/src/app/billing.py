import os
from datetime import UTC, date, datetime

from fastapi import HTTPException, status

from app.auth import CLERK_ENABLED
from app.db import fetchrow
from app.models import ClerkUser

# Daily GLOBAL chat-turn credits PER OWNER, across all interviews in one UTC day.
FREE_CHAT_TURNS = int(os.getenv("FREE_CHAT_TURNS", "30"))
PREMIUM_CHAT_TURNS = int(os.getenv("PREMIUM_CHAT_TURNS", "300"))
DEV_CHAT_TURNS = int(os.getenv("DEV_CHAT_TURNS", "100000000"))
BYOK_CHAT_TURNS = int(os.getenv("BYOK_CHAT_TURNS", "600"))
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
    if not CLERK_ENABLED or user.tier == "premium":
        return tier_from(user, entitled=False)
    return tier_from(user, entitled=(await _entitled_row(user.sub)) is not None)


def tier_from(user: ClerkUser, entitled: bool) -> str:
    if not CLERK_ENABLED:
        return "dev"
    return "premium" if user.tier == "premium" or entitled else "free"


async def usage_state(user: ClerkUser) -> dict:
    row = await fetchrow(
        """
        SELECT (SELECT turns FROM turn_usage WHERE owner_id = $1 AND day = $2) AS turns,
               EXISTS(SELECT 1 FROM llm_credentials WHERE owner_id = $1) AS byok,
               (SELECT current_period_end FROM subscriptions
                 WHERE owner_id = $1 AND plan = 'premium'
                   AND status = ANY($3::text[])
                   AND (current_period_end IS NULL OR current_period_end > now())) AS premium_until
        """,
        user.sub,
        utc_day(),
        list(ENTITLED_STATUSES),
    )
    assert row is not None
    return {"turns": row["turns"] or 0, "byok": bool(row["byok"]), "premium_until": row["premium_until"]}


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


SPEND_TURN_SQL = """
        INSERT INTO turn_usage (owner_id, day, turns)
        SELECT $1, $2, 1
        WHERE $3 > 0
        ON CONFLICT (owner_id, day) DO UPDATE SET turns = turn_usage.turns + 1
        WHERE turn_usage.turns < $3
        RETURNING turns
        """


def utc_day() -> date:
    return datetime.now(UTC).date()


async def spend_chat_turn(owner_id: str, limit: int) -> bool:
    row = await fetchrow(SPEND_TURN_SQL, owner_id, utc_day(), limit)
    return row is not None
