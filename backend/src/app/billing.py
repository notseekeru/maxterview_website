"""M10 billing/quota enforcement (MONETIZATION.md).

Simple two-tier model: Free / Premium. Backend-authoritative.

- **Entitlement (`tier`)**: source of truth is `ClerkUser.tier` (JWT claim), merged with any
  active `premium` row in the `subscriptions` table so billing can elevate even when the JWT is
  stale. Default `"free"`.
- **Quotas** (simpler than the token-budget design; see MONETIZATION.md):
  - **Chat-turn cap** per interview: free = K user turns; premium = M (effectively unlimited).
  No daily-interview cap (removed): interviews are unlimited at creation. The chat-turn cap is
  the only gate. No token metering (decision 2026-08-23).
"""

import os

from fastapi import HTTPException, status

from app.db import fetchrow
from app.models import ClerkUser

# --- tier limits (env-overridable; MONETIZATION.md §0 placeholders) ---
FREE_CHAT_TURNS = int(os.getenv("FREE_CHAT_TURNS", "8"))
PREMIUM_CHAT_TURNS = int(os.getenv("PREMIUM_CHAT_TURNS", "100"))

LIMITS = {
    # chat-turn cap per interview is the only quota (daily-interview cap removed).
    "free": {"chat_turns": FREE_CHAT_TURNS},
    "premium": {"chat_turns": PREMIUM_CHAT_TURNS},
}


async def resolve_tier(user: ClerkUser) -> str:
    """Effective tier = ClerkUser.tier, escalated by an active premium subscription."""
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
