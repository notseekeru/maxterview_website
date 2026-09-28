"""M10 billing/quota enforcement (MONETIZATION.md).

Simple tier model: Free / Premium / dev(-only). Backend-authoritative.

- **Entitlement (`tier`)**: source of truth is `ClerkUser.tier` (JWT claim), merged with any
  active `premium` row in the `subscriptions` table so billing can elevate even when the JWT is
  stale. Default `"free"`. A cancelled subscription keeps its already-paid period (MONETIZATION
  §5: access to the end of the paid period) — `past_due`/`unpaid` revoke immediately, and so do the
  statuses `payments._revoke`/`revoke.sh` write for a refund or a chargeback (`refunded`,
  `disputed`).
- **`dev` tier**: only for the no-Clerk dev-fallback identity (`CLERK_ENABLED=false`, i.e. the
  fixed `DEV_USER`). `main.py`'s boot guard refuses to boot with `CLERK_ENABLED=false` outside
  development/test, so `dev` can never leak to production. Never persisted in `subscriptions`.
- **Quotas**: a single daily chat-turn credits per owner is the only METERED gate — free = 30,
  premium = 100, dev = 500 (across ALL the owner's interviews in one UTC day). No
  per-interview cap and no token metering (decisions 2026-08-23 / this change). An owner on their
  own provider (BYOK) trades the tier cap for the flat, higher `BYOK_CHAT_TURNS` ceiling: the cap
  is never WAIVED, and every turn is metered either way (see `chat_turn_limit`).
- **Reset is LAZY**: `day` is part of the `turn_usage` PK, so a new UTC day simply has no row yet;
  the first turn inserts `(owner_id, today, 1)`. There is no cron/job and no global `UPDATE`. Do NOT
  add a scheduled reset (e.g. `UPDATE turn_usage SET turns = 0 WHERE day < today`) — that turns
  midnight into a whole-table write spike. Watch read amplification (1 SELECT per turn), not resets.
"""

import os
from datetime import UTC, date, datetime

from fastapi import HTTPException, status

from app.auth import CLERK_ENABLED
from app.db import fetchrow
from app.models import ClerkUser

# --- tier limits (env-overridable; MONETIZATION.md §0) ---
# Daily GLOBAL chat-turn credits PER OWNER, across all interviews in one UTC day.
FREE_CHAT_TURNS = int(os.getenv("FREE_CHAT_TURNS", "10"))
PREMIUM_CHAT_TURNS = int(os.getenv("PREMIUM_CHAT_TURNS", "100"))
DEV_CHAT_TURNS = int(os.getenv("DEV_CHAT_TURNS", "500"))  # dev > premium
# BYOK: the owner's own provider pays, so the TIER cap is not the gate - this flat ceiling is. A
# waived cap would make the self-asserted `byok` flag a free ride on whoever's GPU `base_url` names
# (BYOK.md). Flat across tiers on purpose: BYOK is a different payer, not an upgrade.
BYOK_CHAT_TURNS = int(os.getenv("BYOK_CHAT_TURNS", "1000"))
# Resume imports per owner. Free is a teaser cap, premium the real ceiling (env-overridable like the
# turn caps above). `dev` tracks premium: a dev identity is never meant to be the more limited one.
FREE_RESUMES = int(os.getenv("FREE_RESUMES", "1"))
PREMIUM_RESUMES = int(os.getenv("PREMIUM_RESUMES", "5"))
DEV_RESUMES = int(os.getenv("DEV_RESUMES", "5"))

LIMITS = {
    "free": {"chat_turns": FREE_CHAT_TURNS, "resumes": FREE_RESUMES},
    "premium": {"chat_turns": PREMIUM_CHAT_TURNS, "resumes": PREMIUM_RESUMES},
    "dev": {"chat_turns": DEV_CHAT_TURNS, "resumes": DEV_RESUMES},
}

# Statuses that still serve time the customer paid for. `cancelled` is here on purpose: PayMongo
# cancels immediately but the current invoice stays paid, so access runs to `current_period_end`.
ENTITLED_STATUSES = ("active", "cancelled")


async def _entitled_row(owner_id: str) -> dict | None:
    """The one predicate for "this owner has paid time left", shared by tier + period readout.

    The period is checked at read time, so no scheduled job is needed to lapse a subscription.
    """
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
    """When the paid time lapses. Period mode never renews itself, so the user buying again is the
    renewal and the UI has to state the deadline."""
    return ((await _entitled_row(owner_id)) or {}).get("current_period_end")


def _quota(tier: str, what: str) -> float:
    limits = LIMITS.get(tier, LIMITS["free"])
    if what not in limits:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"No quota configured for tier={tier} {what}")
    return limits[what]


def chat_turn_limit(tier: str | None) -> int:
    """Daily chat-turn ceiling: `tier`'s, or the flat BYOK one when the tier is None.

    None MEANS BYOK (the caller must not resolve a tier it has no other use for); it is never
    "uncapped" - see BYOK_CHAT_TURNS."""
    return BYOK_CHAT_TURNS if tier is None else int(_quota(tier, "chat_turns"))


def resume_limit(tier: str) -> int:
    """How many resumes this tier may keep. A storage cap, not a metered quota: nothing is spent by
    importing one, which is why it is counted at INSERT and never decremented."""
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


async def chat_turn_remaining(tier: str | None, owner_id: str) -> int:
    return max(0, chat_turn_limit(tier) - await chat_turns_used(owner_id))


async def bump_chat_turn(owner_id: str) -> None:
    await fetchrow(
        "INSERT INTO turn_usage (owner_id, day, turns) VALUES ($1, $2, 1) ON CONFLICT (owner_id, day) DO UPDATE SET turns = turn_usage.turns + 1",
        owner_id,
        _utc_day(),
    )
