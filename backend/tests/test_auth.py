from app.auth import CLERK_ENABLED, DEV_USER, get_current_user


class _FakeRequest:
    def __init__(self, cookies=None, headers=None):
        self.cookies = cookies or {}
        self.headers = headers or {}


async def test_dev_fallback_returns_fixed_user():
    # conftest sets CLERK_ENABLED=false → no auth, fixed identity (D2/D4).
    assert CLERK_ENABLED is False
    user = await get_current_user(_FakeRequest())
    assert user == DEV_USER
    assert user.sub == "dev-user"
