from pydantic import BaseModel


class ClerkUser(BaseModel):
    """Authenticated identity — `sub` is the Clerk user id, scopes every query (D4)."""

    sub: str
    email: str | None = None
    name: str | None = None
    session_id: str | None = None
