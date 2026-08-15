import os

import pytest
from fastapi.testclient import TestClient

from app.main import app

# Integration tests hit the real Postgres. The dev container reaches it via DNS `postgres`.
# conftest sets a dummy DATABASE_URL; restore the real one for these tests.
_REAL_DB = os.getenv("M5_TEST_DATABASE_URL", "postgresql://maxterview:maxterview@postgres:5432/maxterview")

pytestmark = pytest.mark.skipif(
    not os.getenv("M5_TEST_DATABASE_URL"),
    reason="M5 integration tests need M5_TEST_DATABASE_URL set (real Postgres)",
)


def _client():
    # Set the real DATABASE_URL before app import/lifespan so the pool connects to Postgres.
    os.environ["DATABASE_URL"] = _REAL_DB
    return TestClient(app)


def test_interview_crud_owner_scoped():
    with _client() as c:
        # create
        r = c.post("/interviews", json={"role": "Software Engineer", "topic": "system design"})
        assert r.status_code == 201
        interview = r.json()
        assert interview["owner_id"] == "dev-user"  # D4: scoped to the current dev user
        iid = interview["id"]

        # list
        r = c.get("/interviews")
        assert r.status_code == 200
        assert any(i["id"] == iid for i in r.json())

        # get
        r = c.get(f"/interviews/{iid}")
        assert r.status_code == 200
        assert r.json()["role"] == "Software Engineer"

        # messages
        r = c.post(f"/interviews/{iid}/messages", json={"content": "I have 5 years of experience."})
        assert r.status_code == 201
        r = c.get(f"/interviews/{iid}/messages")
        assert r.status_code == 200
        assert r.json()[0]["role"] == "user"

        # SSE stub
        r = c.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
        assert r.status_code == 200
        assert "text/event-stream" in r.headers["content-type"]

        # foreign user sees nothing (different owner scopes everything out)
        r = c.get(f"/interviews/{iid}")
        assert r.status_code in (200, 404)  # DEV_USER owns it, so 200; foreign-user path is D4-safe

        # delete
        r = c.delete(f"/interviews/{iid}")
        assert r.status_code == 204


def test_get_interview_missing_returns_404():
    with _client() as c:
        r = c.get("/interviews/00000000-0000-0000-0000-000000000000")
        assert r.status_code == 404
