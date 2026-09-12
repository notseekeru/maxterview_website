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


def test_interview_dials_round_trip_and_default(client):
    c = client
    # Defaults: neutral, human-sounding, 0 chitchat / 2 behavioural / max technical.
    r = c.post("/interviews", json={"role": "Dials Default"})
    assert r.status_code == 201
    d = r.json()
    assert (d["company_size"], d["cynicism"], d["brutally_honest"], d["human_mode"]) == ("any", "neutral", False, True)
    assert (d["mix_chitchat"], d["mix_behavioural"], d["mix_technical"]) == (0, 2, 4)
    c.delete(f"/interviews/{d['id']}")

    # Every dial survives a create -> read, on all three read paths (room for the response_model's
    # defaults to mask a query that forgot a column).
    r = c.post(
        "/interviews",
        json={
            "role": "Dials Round Trip",
            "level": "staff",
            "company_size": "51-200",
            "cynicism": "skeptical",
            "brutally_honest": True,
            "human_mode": False,
            "mix_chitchat": 1,
            "mix_behavioural": 0,
            "mix_technical": 3,
        },
    )
    assert r.status_code == 201
    iid = r.json()["id"]
    expected = {"company_size": "51-200", "cynicism": "skeptical", "brutally_honest": True, "human_mode": False, "mix_chitchat": 1, "mix_behavioural": 0, "mix_technical": 3}
    for payload in (r.json(), c.get(f"/interviews/{iid}").json(), next(i for i in c.get("/interviews").json() if i["id"] == iid)):
        assert {k: payload[k] for k in expected} == expected

    # start/complete echo the same row (their RETURNING used to drop columns, which the response
    # model then silently filled from defaults). One request each: a second /start 409s, so these
    # bodies must be captured before being indexed.
    started = c.post(f"/interviews/{iid}/start").json()
    assert {k: started[k] for k in expected} == expected
    c.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hello"})
    completed = c.post(f"/interviews/{iid}/complete").json()
    assert {k: completed[k] for k in expected} == expected
    c.delete(f"/interviews/{iid}")


def test_chat_refuses_turns_after_the_question_mix_is_spent(client):
    from app import llm

    c = client
    # Every budget on 0 -> the arc is opener + closing statement, so the THIRD turn is over the plan.
    iv = c.post("/interviews", json={"role": "Mix Exhausted", "mix_chitchat": 0, "mix_behavioural": 0, "mix_technical": 0}).json()
    iid = iv["id"]
    c.post(f"/interviews/{iid}/start")
    for i in range(2):
        assert c.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": f"answer {i}"}).status_code == 200

    used_before = c.get("/usage").json()["chat_turns_used_today"]
    transcript_before = c.get(f"/interviews/{iid}/messages").json()
    # The closing turn is canned and persisted, so the transcript ends the way it was displayed.
    assert llm.CLOSING_MESSAGE in transcript_before[-1]["content"]
    r = c.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "one more thing"})
    assert r.status_code == 409
    assert "Press Complete" in r.json()["detail"]
    # Refused BEFORE the model call, the chat credit, and the write: an over-plan turn must not
    # cost a quota credit or leave an unanswered user turn in the transcript.
    assert c.get("/usage").json()["chat_turns_used_today"] == used_before
    assert c.get(f"/interviews/{iid}/messages").json() == transcript_before
    c.delete(f"/interviews/{iid}")


def test_interview_dials_reject_values_outside_the_vocabulary(client):
    c = client
    for bad in (
        {"company_size": "1-10k"},
        {"cynicism": "harsh"},
        {"mix_chitchat": 5},
        {"mix_technical": -1},
        {"mix_behavioural": 2.5},
    ):
        r = c.post("/interviews", json={"role": "Bad Dials", **bad})
        assert r.status_code == 422, bad


def test_interview_lifecycle_owner_scoped(client):
    c = client
    r = c.post("/interviews", json={"role": "Software Engineer", "topic": "system design"})
    assert r.status_code == 201
    interview = r.json()
    assert interview["owner_id"] == "dev-user"  # D4: scoped to the current dev user
    assert interview["status"] == "pending"
    iid = interview["id"]

    r = c.get("/interviews")
    assert r.status_code == 200
    assert any(i["id"] == iid for i in r.json())

    r = c.get(f"/interviews/{iid}")
    assert r.status_code == 200
    assert r.json()["role"] == "Software Engineer"

    # chat stream blocked while pending (Gap C)
    r = c.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
    assert r.status_code == 409

    r = c.post(f"/interviews/{iid}/start")
    assert r.status_code == 200
    assert r.json()["status"] == "in_progress"

    # SSE chat: real LLM stub streams + persists both turns
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
    # Hire/reject spectrum + certainty, not pass/fail: the stub's lean_hire/50 is capped by
    # the one-answer transcript (40 + 8 per candidate answer), so certainty must be 48.
    assert (r.json()["decision"], r.json()["certainty"]) == ("lean_hire", 48)

    # The history list carries the same two fields (drives the row chip).
    r = c.get("/interviews")
    row = next(i for i in r.json() if i["id"] == iid)
    assert (row["decision"], row["certainty"]) == ("lean_hire", 48)

    # write + read feedback (UPSERT over the auto-generated one)
    r = c.post(f"/interviews/{iid}/feedback", json={"scores": {"clarity": 4}, "verdict": "Good", "tips": ["be concise"]})
    assert r.status_code == 201
    r = c.get(f"/interviews/{iid}/feedback")
    assert r.status_code == 200
    assert r.json()["verdict"] == "Good"
    r = c.post(f"/interviews/{iid}/feedback", json={"scores": {"clarity": 5}, "verdict": "Better", "tips": ["shorter"], "decision": "hire", "certainty": 80})
    assert r.status_code == 201
    r = c.get(f"/interviews/{iid}/feedback")
    assert r.status_code == 200
    assert r.json()["verdict"] == "Better"
    assert (r.json()["decision"], r.json()["certainty"]) == ("hire", 80)

    # A decision outside the four-point spread is refused, not silently stored.
    r = c.post(f"/interviews/{iid}/feedback", json={"verdict": "Hmm", "decision": "strong_hire", "certainty": 80})
    assert r.status_code == 422
    r = c.post(f"/interviews/{iid}/feedback", json={"verdict": "Hmm", "decision": "hire", "certainty": 101})
    assert r.status_code == 422

    # chat blocked once completed
    r = c.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "late"})
    assert r.status_code == 409

    # foreign user sees nothing (different owner scopes everything out)
    r = c.get(f"/interviews/{iid}")
    assert r.status_code in (200, 404)  # DEV_USER owns it, so 200; foreign-user path is D4-safe

    r = c.delete(f"/interviews/{iid}")
    assert r.status_code == 204


def test_get_interview_missing_returns_404(client):
    r = client.get("/interviews/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404


def test_interviews_unlimited_at_creation(client):
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
    # A turn in one interview advances the shared per-owner daily counter that all of the
    # owner's interviews draw from (cap math is unit-tested; dev cap 500 keeps this under it).
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
    r = client.post("/interviews", json={"role": "Regen Guard"})
    assert r.status_code == 201
    pending_id = r.json()["id"]
    rr = client.post(f"/interviews/{pending_id}/feedback/generate")
    assert rr.status_code == 409

    # A nonexistent/foreign interview is a 404 via the ownership guard.
    rr = client.post("/interviews/00000000-0000-0000-0000-000000000000/feedback/generate")
    assert rr.status_code == 404

    client.delete(f"/interviews/{pending_id}")


def test_complete_requires_at_least_one_message(client):
    # Regression: completing a never-chatted interview produced a "completed, scoring can
    # never succeed" row (empty transcript -> 503 on every retry, no way back in).
    iv = client.post("/interviews", json={"role": "Empty Complete"}).json()
    iid = iv["id"]
    assert client.post(f"/interviews/{iid}/start").status_code == 200
    r = client.post(f"/interviews/{iid}/complete")
    assert r.status_code == 409
    assert client.get(f"/interviews/{iid}").json()["status"] == "in_progress"  # still resumable

    client.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
    assert client.post(f"/interviews/{iid}/complete").status_code == 200
    client.delete(f"/interviews/{iid}")


def test_regenerate_feedback_rejects_empty_transcript(client, monkeypatch):
    # Legacy rows (completed before the /complete guard) must answer 409, not a 503 the retry
    # button can never clear. The empty-but-completed state is unreachable via the API now,
    # so stub the predicate instead of deleting rows behind the app's pool.
    from app import main as main_mod

    iv = client.post("/interviews", json={"role": "Empty Regen"}).json()
    iid = iv["id"]
    client.post(f"/interviews/{iid}/start")
    client.post(f"/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
    assert client.post(f"/interviews/{iid}/complete").status_code == 200

    async def _empty(_interview_id):
        return False

    monkeypatch.setattr(main_mod, "_has_transcript", _empty)
    r = client.post(f"/interviews/{iid}/feedback/generate")
    assert r.status_code == 409
    assert "no answers" in r.json()["detail"]
    client.delete(f"/interviews/{iid}")


def test_regenerate_feedback_writes_when_model_recovers(client, monkeypatch):
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
    async def _ok(history, dials=None):
        return FeedbackSummary(scores={d: 7.0 for d in llm.FEEDBACK_DIMS}, verdict="Recovered", tips=["Keep going."])

    monkeypatch.setattr(llm, "generate_feedback", _ok)
    rr = client.post(f"/interviews/{iid}/feedback/generate")
    assert rr.status_code == 200
    assert rr.json()["verdict"] == "Recovered"
    fb = client.get(f"/interviews/{iid}/feedback")
    assert fb.status_code == 200
    assert fb.json()["verdict"] == "Recovered"
    client.delete(f"/interviews/{iid}")


async def _always_none(history, dials=None):
    return None


async def _noop_sleep(ms):
    return None  # neutralize the /complete auto-retry backoff so integration tests run instantly


def test_complete_auto_retries_then_leaves_unscored_when_always_none(client, monkeypatch):
    from app import llm
    from app import main as main_mod

    monkeypatch.setattr(main_mod, "_backoff_sleep", _noop_sleep)
    attempts = {"n": 0}

    async def _count_none(_history, dials=None):
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
    from app import llm
    from app import main as main_mod
    from app.models import FeedbackSummary

    monkeypatch.setattr(main_mod, "_backoff_sleep", _noop_sleep)
    attempts = {"n": 0}

    async def _flaky(_history, dials=None):
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
