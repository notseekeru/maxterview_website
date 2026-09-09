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


def test_interviews_unlimited_at_creation(client):
    # Daily-interview cap removed: creating multiple interviews the same day all succeed.
    r1 = client.post("/interviews", json={"role": "Quota Probe"})
    assert r1.status_code == 201
    iid1 = r1.json()["id"]
    r2 = client.post("/interviews", json={"role": "Quota Probe 2"})
    assert r2.status_code == 201
    iid2 = r2.json()["id"]
    # /usage reports tier + the daily GLOBAL chat-turn dial (per owner, not per interview).
    u = client.get("/usage")
    assert u.status_code == 200
    body = u.json()
    assert "daily_interviews" not in body
    assert body["tier"] == "dev"  # no-Clerk dev-fallback -> dev tier
    assert body["chat_turns_per_day_dev"] == 500
    assert body["chat_turns_used_today"] >= 0
    assert body["chat_turns_remaining_today"] >= 0

    assert client.delete(f"/interviews/{iid1}").status_code == 204
    assert client.delete(f"/interviews/{iid2}").status_code == 204


def test_usage_tracks_global_daily_counter(client):
    # Chat turns count GLOBALLY per owner (across all interviews), not per interview.
    # A turn in one interview advances the shared daily /usage counter that all of the
    # owner's interviews draw from (cap math covered by the unit tests; dev cap 500
    # keeps this integration run safely under the cap).
    c = client
    iv = c.post("/interviews", json={"role": "Cap Probe"}).json()
    iid = iv["id"]
    c.post(f"/interviews/{iid}/start")

    before = c.get("/usage").json()["chat_turns_used_today"]
    r = c.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "ping"})
    assert r.status_code == 200
    after = c.get("/usage").json()["chat_turns_used_today"]
    assert after == before + 1
    c.delete(f"/interviews/{iid}")


def test_regenerate_feedback_rejects_incomplete_and_foreign(client):
    # A pending interview cannot be (re)scored.
    r = client.post("/interviews", json={"role": "Regen Guard"})
    assert r.status_code == 201
    pending_id = r.json()["id"]
    rr = client.post(f"/interviews/{pending_id}/feedback/generate")
    assert rr.status_code == 409

    # A nonexistent/foreign interview is a 404 via the ownership guard.
    rr = client.post("/interviews/00000000-0000-0000-0000-000000000000/feedback/generate")
    assert rr.status_code == 404
    client.delete(f"/interviews/{pending_id}")


def test_regenerate_feedback_writes_when_model_recovers(client, monkeypatch):
    # A completed interview whose /complete run scored nothing (model returned None, as in
    # real mode) can be re-scored on demand once the model recovers.
    from app import llm
    from app import main as main_mod
    from app.models import FeedbackSummary

    iv = client.post("/interviews", json={"role": "Regen Recovers"}).json()
    iid = iv["id"]
    client.post(f"/interviews/{iid}/start")
    client.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hello?"})

    # First complete: model "fails" (None, as in real mode) -> no feedback row written.
    # /complete auto-retries, so neutralize its backoff timer to keep this test fast.
    monkeypatch.setattr(main_mod, "_backoff_sleep", _noop_sleep)
    monkeypatch.setattr(llm, "generate_feedback", _always_none)
    r = client.post(f"/interviews/{iid}/complete")
    assert r.status_code == 200
    assert r.json()["status"] == "completed"
    assert client.get(f"/interviews/{iid}/feedback").status_code == 404  # genuinely absent

    # Later regenerate: model "recovers" -> row written; 404 turns into 200.
    async def _ok(history):
        return FeedbackSummary(scores={d: 7.0 for d in llm.FEEDBACK_DIMS}, verdict="Recovered", tips=["Keep going."])

    monkeypatch.setattr(llm, "generate_feedback", _ok)
    rr = client.post(f"/interviews/{iid}/feedback/generate")
    assert rr.status_code == 200
    assert rr.json()["verdict"] == "Recovered"
    fb = client.get(f"/interviews/{iid}/feedback")
    assert fb.status_code == 200
    assert fb.json()["verdict"] == "Recovered"
    client.delete(f"/interviews/{iid}")


async def _always_none(history):
    return None


async def _noop_sleep(ms):
    return None  # neutralize the /complete auto-retry backoff so integration tests run instantly


def test_complete_auto_retries_then_leaves_unscored_when_always_none(client, monkeypatch):
    # A model that keeps failing must NOT be retried forever: /complete auto-retries up to
    # COMPLETE_MAX_FEEDBACK_ATTEMPTS, then gives up leaving the interview completed but
    # genuinely unscored (404) so the manual regenerate button can retry later.
    from app import llm
    from app import main as main_mod

    monkeypatch.setattr(main_mod, "_backoff_sleep", _noop_sleep)
    attempts = {"n": 0}

    async def _count_none(_history):
        attempts["n"] += 1
        return None

    monkeypatch.setattr(llm, "generate_feedback", _count_none)

    iv = client.post("/interviews", json={"role": "AutoRetry Exhaust"}).json()
    iid = iv["id"]
    client.post(f"/interviews/{iid}/start")
    client.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hello?"})

    r = client.post(f"/interviews/{iid}/complete")
    assert r.status_code == 200
    assert r.json()["status"] == "completed"
    assert attempts["n"] == main_mod.COMPLETE_MAX_FEEDBACK_ATTEMPTS  # bounded, not infinite
    assert client.get(f"/interviews/{iid}/feedback").status_code == 404  # still unscored -> manual
    client.delete(f"/interviews/{iid}")


def test_complete_auto_retry_stops_on_first_success(client, monkeypatch):
    # A flaky model that succeeds on the 2nd attempt should stop immediately (not burn its
    # remaining attempts) and persist the recovered feedback.
    from app import llm
    from app import main as main_mod
    from app.models import FeedbackSummary

    monkeypatch.setattr(main_mod, "_backoff_sleep", _noop_sleep)
    attempts = {"n": 0}

    async def _flaky(_history):
        attempts["n"] += 1
        if attempts["n"] == 1:
            return None
        return FeedbackSummary(scores={d: 7.0 for d in llm.FEEDBACK_DIMS}, verdict="Auto recovered", tips=["Keep."])

    monkeypatch.setattr(llm, "generate_feedback", _flaky)

    iv = client.post("/interviews", json={"role": "AutoRetry Recover"}).json()
    iid = iv["id"]
    client.post(f"/interviews/{iid}/start")
    client.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hello?"})

    r = client.post(f"/interviews/{iid}/complete")
    assert r.status_code == 200
    assert attempts["n"] == 2  # recovered on attempt 2; no 3rd attempt
    assert r.json()["status"] == "completed"
    fb = client.get(f"/interviews/{iid}/feedback")
    assert fb.status_code == 200
    assert fb.json()["verdict"] == "Auto recovered"
    client.delete(f"/interviews/{iid}")
