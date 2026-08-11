from pydantic import BaseModel


class ClerkUser(BaseModel):
    """Authenticated identity — `sub` is the Clerk user id, scopes every query (D4).

    `tier` is a monetization seam (D10): free/premium. Used for gating post-MVP;
    billing engine itself is phase 2 (M10), not built in MVP.
    """

    sub: str
    email: str | None = None
    name: str | None = None
    session_id: str | None = None
    tier: str = "free"
