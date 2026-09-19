import base64
import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app import auth
from app.auth import CLERK_ENABLED, DEV_USER, get_current_user, verify_jwt


class _FakeRequest:
    def __init__(self, cookies=None, headers=None):
        self.cookies = cookies or {}
        self.headers = headers or {}
        self.state = SimpleNamespace()  # the access log's attribution channel (app/logs.py)


# --- helpers: self-generated keypair + JWKS + tokens (no real Clerk needed) ---


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


@pytest.fixture
def keypair():
    priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub = priv.public_key()
    pub_nums = pub.public_numbers()
    pem = priv.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    n = pub_nums.n.to_bytes((pub_nums.n.bit_length() + 7) // 8, "big")
    e = pub_nums.e.to_bytes((pub_nums.e.bit_length() + 7) // 8, "big")
    jwks = {"keys": [{"kty": "RSA", "alg": "RS256", "kid": "test-kid", "n": _b64url(n), "e": _b64url(e)}]}
    return pem, jwks


def _make_token(priv_pem, *, kid="test-kid", sub="user_123", exp=None, iss=None, aud=None, alg="RS256", iat=None):
    now = int(time.time())
    payload = {"sub": sub, "iss": iss or "https://test.clerk.accounts", "iat": iat or now, "exp": exp or now + 3600}
    if aud:
        payload["aud"] = aud
    return jwt.encode(payload, priv_pem, algorithm=alg, headers={"kid": kid, "alg": alg})


# --- tests ---


async def test_dev_fallback_returns_fixed_user():
    assert CLERK_ENABLED is False
    user = await get_current_user(_FakeRequest())
    assert user == DEV_USER
    assert user.sub == "dev-user"


def test_verify_valid_token(keypair):
    priv_pem, jwks = keypair
    auth.CLERK_AUDIENCE = ""  # no audience configured → aud-gate off
    token = _make_token(priv_pem, iss="https://test.clerk.accounts")
    user = verify_jwt(token, jwks)
    assert user.sub == "user_123"


def test_verify_rejects_none_alg(keypair):
    _, jwks = keypair
    with pytest.raises(Exception) as exc:
        verify_jwt("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.", jwks)
    assert exc.type.__name__ == "HTTPException"
    assert exc.value.status_code == 401


def _fake_header_payload():
    import json
    from base64 import urlsafe_b64encode as b64

    def e(o):
        return b64(json.dumps(o).encode()).rstrip(b"=").decode()

    header = e({"alg": "RS256", "kid": "test-kid"})
    payload = e({"sub": "user_123", "iss": "https://test.clerk.accounts"})
    return f"{header}.{payload}.garbage"


def test_verify_rejects_bad_signature(keypair):
    _, jwks = keypair
    with pytest.raises(Exception) as exc:
        verify_jwt(_fake_header_payload(), jwks)
    assert exc.type.__name__ == "HTTPException"
    assert exc.value.status_code == 401


def test_verify_rejects_unknown_kid(keypair):
    priv_pem, jwks = keypair
    token = _make_token(priv_pem, kid="other-kid")
    with pytest.raises(Exception) as exc:
        verify_jwt(token, jwks)
    assert exc.type.__name__ == "HTTPException"
    assert exc.value.status_code == 401


def test_verify_expired(keypair):
    priv_pem, jwks = keypair
    token = _make_token(priv_pem, exp=int(time.time()) - 100)
    with pytest.raises(Exception) as exc:
        verify_jwt(token, jwks)
    assert exc.type.__name__ == "HTTPException"
    assert exc.value.status_code == 401


def test_verify_tolerates_a_freshly_issued_token_from_ahead_of_our_clock(keypair):
    # Live 2026-09-12: Clerk stamps `iat` from its own clock, PyJWT rejects iat > now outright, so a
    # brand-new session 401'd its FIRST request and worked one second later. Leeway must cover that
    # rounding without covering real skew: a token from a minute in the future still fails.
    priv_pem, jwks = keypair
    assert verify_jwt(_make_token(priv_pem, iat=int(time.time()) + 1), jwks).sub == "user_123"
    with pytest.raises(Exception) as exc:
        verify_jwt(_make_token(priv_pem, iat=int(time.time()) + 60), jwks)
    assert exc.type.__name__ == "HTTPException" and exc.value.status_code == 401


def test_verify_wrong_issuer(keypair):
    priv_pem, jwks = keypair
    token = _make_token(priv_pem, iss="https://evil.clerk.accounts")
    with pytest.raises(Exception) as exc:
        verify_jwt(token, jwks)
    assert exc.type.__name__ == "HTTPException"
    assert exc.value.status_code == 401


def test_verify_aud_gate_on(keypair):
    priv_pem, jwks = keypair
    auth.CLERK_AUDIENCE = "maxterview"
    try:
        ok = _make_token(priv_pem, aud="maxterview")
        bad = _make_token(priv_pem, aud="other-app")
        assert verify_jwt(ok, jwks).sub == "user_123"
        with pytest.raises(Exception) as exc:
            verify_jwt(bad, jwks)
        assert exc.type.__name__ == "HTTPException"
        assert exc.value.status_code == 401
    finally:
        auth.CLERK_AUDIENCE = ""
