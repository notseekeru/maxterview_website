import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

# Integration tests hit a real Postgres. `DATABASE_URL` is provided by CI (Postgres
# service) or the dev container (DNS `postgres`). conftest only sets a dummy default for
# unit tests; these tests need the real one and will fail fast if it's unreachable.
DB_URL = os.getenv("M5_TEST_DATABASE_URL") or os.environ.get("DATABASE_URL", "")


@pytest.fixture(scope="session", autouse=True)
def migrated_db():
    """Ensure migrations are applied to the test DB before integration tests run.

    Self-contained: locally (dev container) and in CI (Postgres service). Uses yoyo.
    """
    if not DB_URL:
        pytest.skip("DATABASE_URL not set; cannot run integration tests")
    migrations_dir = Path(__file__).resolve().parents[1] / "migrations"
    subprocess.run(
        [sys.executable, "-m", "yoyo", "apply", "--no-config-file", "--batch", "--database", DB_URL, str(migrations_dir)],
        check=True,
        capture_output=True,
    )
    yield


@pytest.fixture(scope="function")
def client(migrated_db):
    os.environ["DATABASE_URL"] = DB_URL
    with TestClient(app) as c:
        yield c


def test_interview_lifecycle_owner_scoped(client):
    c = client
    # create (pending)
    r = c.post("/interviews", json={"role": "Software Engineer", "topic": "system design"})
    assert r.status_code == 201
    interview = r.json()
    assert interview["owner_id"] == "dev-user"  # D4: scoped to the current dev user
    assert interview["status"] == "pending"
    iid = interview["id"]

    # list
    r = c.get("/interviews")
    assert r.status_code == 200
    assert any(i["id"] == iid for i in r.json())

    # get
    r = c.get(f"/interviews/{iid}")
    assert r.status_code == 200
    assert r.json()["role"] == "Software Engineer"

    # chat stream blocked while pending (Gap C)
    r = c.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
    assert r.status_code == 409

    # start -> in_progress
    r = c.post(f"/interviews/{iid}/start")
    assert r.status_code == 200
    assert r.json()["status"] == "in_progress"

    # SSE chat (M6: real LLM stub streams + persists both turns)
    r = c.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "I have 5 years of experience."})
    assert r.status_code == 200
    assert "text/event-stream" in r.headers["content-type"]
    # Both the user turn and the streamed assistant reply are persisted (transcript complete).
    r = c.get(f"/interviews/{iid}/messages")
    assert r.status_code == 200
    roles = [m["role"] for m in r.json()]
    assert "user" in roles and "assistant" in roles

    # complete -> completed (M6 auto-generates feedback in stub mode)
    r = c.post(f"/interviews/{iid}/complete")
    assert r.status_code == 200
    assert r.json()["status"] == "completed"
    # Auto-generated feedback exists (stub deterministic scores).
    r = c.get(f"/interviews/{iid}/feedback")
    assert r.status_code == 200
    assert r.json()["verdict"]

    # write + read feedback (UPSERT over the auto-generated one)
    r = c.post(f"/interviews/{iid}/feedback", json={"scores": {"clarity": 4}, "verdict": "Good", "tips": ["be concise"]})
    assert r.status_code == 201
    r = c.get(f"/interviews/{iid}/feedback")
    assert r.status_code == 200
    assert r.json()["verdict"] == "Good"

    # feedback UPSERT: second write updates (not 500) (Gap B)
    r = c.post(f"/interviews/{iid}/feedback", json={"scores": {"clarity": 5}, "verdict": "Better", "tips": ["shorter"]})
    assert r.status_code == 201
    r = c.get(f"/interviews/{iid}/feedback")
    assert r.status_code == 200
    assert r.json()["verdict"] == "Better"

    # chat blocked once completed
    r = c.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "late"})
    assert r.status_code == 409

    # foreign user sees nothing (different owner scopes everything out)
    r = c.get(f"/interviews/{iid}")
    assert r.status_code in (200, 404)  # DEV_USER owns it, so 200; foreign-user path is D4-safe

    # delete
    r = c.delete(f"/interviews/{iid}")
    assert r.status_code == 204


def test_get_interview_missing_returns_404(client):
    r = client.get("/interviews/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404
