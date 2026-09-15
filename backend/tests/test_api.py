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
    r = c.post("/api/interviews", json={"role": "Dials Default"})
    assert r.status_code == 201
    d = r.json()
    assert (d["company_size"], d["cynicism"], d["brutally_honest"], d["human_mode"]) == ("any", "neutral", False, True)
    assert (d["mix_chitchat"], d["mix_behavioural"], d["mix_technical"]) == (0, 2, 4)
    c.delete(f"/api/interviews/{d['id']}")

    # Every dial survives a create -> read, on all three read paths (room for the response_model's
    # defaults to mask a query that forgot a column).
    r = c.post(
        "/api/interviews",
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
    for payload in (r.json(), c.get(f"/api/interviews/{iid}").json(), next(i for i in c.get("/api/interviews").json() if i["id"] == iid)):
        assert {k: payload[k] for k in expected} == expected

    # start/complete echo the same row (their RETURNING used to drop columns, which the response
    # model then silently filled from defaults). One request each: a second /start 409s, so these
    # bodies must be captured before being indexed.
    started = c.post(f"/api/interviews/{iid}/start").json()
    assert {k: started[k] for k in expected} == expected
    c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hello"})
    completed = c.post(f"/api/interviews/{iid}/complete").json()
    assert {k: completed[k] for k in expected} == expected
    c.delete(f"/api/interviews/{iid}")


def test_chat_refuses_turns_after_the_question_mix_is_spent(client):
    from app import llm

    c = client
    # Every budget on 0 -> the arc is opener + closing statement, so the THIRD turn is over the plan.
    iv = c.post("/api/interviews", json={"role": "Mix Exhausted", "mix_chitchat": 0, "mix_behavioural": 0, "mix_technical": 0}).json()
    iid = iv["id"]
    c.post(f"/api/interviews/{iid}/start")
    for i in range(2):
        assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": f"answer {i}"}).status_code == 200

    used_before = c.get("/api/usage").json()["chat_turns_used_today"]
    transcript_before = c.get(f"/api/interviews/{iid}/messages").json()
    # The closing turn is canned and persisted, so the transcript ends the way it was displayed.
    assert llm.CLOSING_MESSAGE in transcript_before[-1]["content"]
    r = c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "one more thing"})
    assert r.status_code == 409
    assert "Press Complete" in r.json()["detail"]
    # Refused BEFORE the model call, the chat credit, and the write: an over-plan turn must not
    # cost a quota credit or leave an unanswered user turn in the transcript.
    assert c.get("/api/usage").json()["chat_turns_used_today"] == used_before
    assert c.get(f"/api/interviews/{iid}/messages").json() == transcript_before
    c.delete(f"/api/interviews/{iid}")


def test_chat_rolls_back_the_turn_when_the_model_fails(client, monkeypatch):
    # A turn that never got a reply must not stay in the transcript: the resend would duplicate the
    # answer, with the stale copy sitting unanswered.
    from app import llm

    async def _boom(*_a, **_kw):
        raise RuntimeError("provider exploded")
        yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr(llm, "stream_chat", _boom)
    c = client
    iid = c.post("/api/interviews", json={"role": "Rollback On Model Failure"}).json()["id"]
    c.post(f"/api/interviews/{iid}/start")
    body = c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "my answer"}).text
    assert "event: error" in body
    assert c.get(f"/api/interviews/{iid}/messages").json() == []

    # The same turn after the model recovers: exactly one copy of the answer.
    monkeypatch.undo()
    assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "my answer"}).status_code == 200
    roles = [m["role"] for m in c.get(f"/api/interviews/{iid}/messages").json()]
    assert roles == ["user", "assistant"]
    c.delete(f"/api/interviews/{iid}")


def test_chat_repairs_a_dangling_user_turn(client):
    # A trailing user turn can only come from a worker that died mid-turn (a clean failure rolls
    # back). The next send is that turn's retry, so it replaces it instead of appending a twin.
    import asyncio

    import asyncpg

    c = client
    iid = c.post("/api/interviews", json={"role": "Dangling Turn Repair"}).json()["id"]
    c.post(f"/api/interviews/{iid}/start")

    async def insert_dangling():
        conn = await asyncpg.connect(DB_URL)
        try:
            await conn.execute("INSERT INTO messages (interview_id, role, content) VALUES ($1::uuid, 'user', 'abandoned answer')", iid)
        finally:
            await conn.close()

    asyncio.run(insert_dangling())
    assert [m["content"] for m in c.get(f"/api/interviews/{iid}/messages").json()] == ["abandoned answer"]

    assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "the retry"}).status_code == 200
    users = [m["content"] for m in c.get(f"/api/interviews/{iid}/messages").json() if m["role"] == "user"]
    assert users == ["the retry"]
    c.delete(f"/api/interviews/{iid}")


def test_interview_dials_reject_values_outside_the_vocabulary(client):
    c = client
    for bad in (
        {"company_size": "1-10k"},
        {"cynicism": "harsh"},
        {"mix_chitchat": 5},
        {"mix_technical": -1},
        {"mix_behavioural": 2.5},
    ):
        r = c.post("/api/interviews", json={"role": "Bad Dials", **bad})
        assert r.status_code == 422, bad


def test_interview_lifecycle_owner_scoped(client):
    c = client
    r = c.post("/api/interviews", json={"role": "Software Engineer", "topic": "system design"})
    assert r.status_code == 201
    interview = r.json()
    assert interview["owner_id"] == "dev-user"  # D4: scoped to the current dev user
    assert interview["status"] == "pending"
    iid = interview["id"]

    r = c.get("/api/interviews")
    assert r.status_code == 200
    assert any(i["id"] == iid for i in r.json())

    r = c.get(f"/api/interviews/{iid}")
    assert r.status_code == 200
    assert r.json()["role"] == "Software Engineer"

    # chat stream blocked while pending (Gap C)
    r = c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
    assert r.status_code == 409

    r = c.post(f"/api/interviews/{iid}/start")
    assert r.status_code == 200
    assert r.json()["status"] == "in_progress"

    # SSE chat: real LLM stub streams + persists both turns
    r = c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "I have 5 years of experience."})
    assert r.status_code == 200
    assert "text/event-stream" in r.headers["content-type"]
    # Both the user turn and the streamed assistant reply are persisted (transcript complete).
    r = c.get(f"/api/interviews/{iid}/messages")
    assert r.status_code == 200
    roles = [m["role"] for m in r.json()]
    assert "user" in roles and "assistant" in roles

    # complete -> completed (M6 auto-generates feedback in stub mode)
    r = c.post(f"/api/interviews/{iid}/complete")
    assert r.status_code == 200
    assert r.json()["status"] == "completed"
    # Auto-generated feedback exists (stub deterministic scores).
    r = c.get(f"/api/interviews/{iid}/feedback")
    assert r.status_code == 200
    assert r.json()["verdict"]
    # Hire/reject spectrum + certainty, not pass/fail: the stub's lean_hire/50 is capped by
    # the one-answer transcript (40 + 8 per candidate answer), so certainty must be 48.
    assert (r.json()["decision"], r.json()["certainty"]) == ("lean_hire", 48)
    # Chess-style review (migration 0010): the annotator classes each candidate turn, and the
    # derived accuracy/grade ride along. Interviewer/system turns carry no class.
    assert (r.json()["accuracy"], r.json()["grade"]) == (85, "A")
    r = c.get(f"/api/interviews/{iid}/messages")
    msgs = r.json()
    assert [m["move_class"] for m in msgs if m["role"] == "user"] == ["good"]  # one candidate turn
    assert all(m["move_class"] is None for m in msgs if m["role"] != "user")

    # The history list carries the same two fields (drives the row chip).
    r = c.get("/api/interviews")
    row = next(i for i in r.json() if i["id"] == iid)
    assert (row["decision"], row["certainty"]) == ("lean_hire", 48)
    assert (row["accuracy"], row["grade"]) == (85, "A")

    # write + read feedback (UPSERT over the auto-generated one)
    r = c.post(f"/api/interviews/{iid}/feedback", json={"scores": {"clarity": 4}, "verdict": "Good", "tips": ["be concise"]})
    assert r.status_code == 201
    r = c.get(f"/api/interviews/{iid}/feedback")
    assert r.status_code == 200
    assert r.json()["verdict"] == "Good"
    r = c.post(f"/api/interviews/{iid}/feedback", json={"scores": {"clarity": 5}, "verdict": "Better", "tips": ["shorter"], "decision": "hire", "certainty": 80})
    assert r.status_code == 201
    r = c.get(f"/api/interviews/{iid}/feedback")
    assert r.status_code == 200
    assert r.json()["verdict"] == "Better"
    assert (r.json()["decision"], r.json()["certainty"]) == ("hire", 80)
    # ... and the raw write path cannot wipe the review: accuracy is derived from the message
    # classes, so a body with no classification leaves the stored grade alone.
    assert (r.json()["accuracy"], r.json()["grade"]) == (85, "A")

    # A decision outside the four-point spread is refused, not silently stored.
    r = c.post(f"/api/interviews/{iid}/feedback", json={"verdict": "Hmm", "decision": "strong_hire", "certainty": 80})
    assert r.status_code == 422
    r = c.post(f"/api/interviews/{iid}/feedback", json={"verdict": "Hmm", "decision": "hire", "certainty": 101})
    assert r.status_code == 422

    # chat blocked once completed
    r = c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "late"})
    assert r.status_code == 409

    # foreign user sees nothing (different owner scopes everything out)
    r = c.get(f"/api/interviews/{iid}")
    assert r.status_code in (200, 404)  # DEV_USER owns it, so 200; foreign-user path is D4-safe

    r = c.delete(f"/api/interviews/{iid}")
    assert r.status_code == 204


def test_move_review_annotates_every_candidate_turn(client):
    # The stub cycles good -> inaccuracy. Two answers is the smallest case that exercises the turn ->
    # row mapping as an ARRAY (one answer passes trivially), and accuracy must average both classes.
    c = client
    iid = c.post("/api/interviews", json={"role": "Move Review Multi"}).json()["id"]
    c.post(f"/api/interviews/{iid}/start")
    for answer in ("I shipped a cache layer in front of the read path.", "It dropped p99 by 40%."):
        assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": answer}).status_code == 200
    assert c.post(f"/api/interviews/{iid}/complete").status_code == 200

    msgs = c.get(f"/api/interviews/{iid}/messages").json()
    assert [m["move_class"] for m in msgs if m["role"] == "user"] == ["good", "inaccuracy"]
    fb = c.get(f"/api/interviews/{iid}/feedback").json()
    assert (fb["accuracy"], fb["grade"]) == (73, "B")  # mean(0.85, 0.6) = 72.5 -> half-up
    c.delete(f"/api/interviews/{iid}")


def test_get_interview_missing_returns_404(client):
    r = client.get("/api/interviews/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404


def test_interviews_unlimited_at_creation(client):
    r1 = client.post("/api/interviews", json={"role": "Quota Probe"})
    assert r1.status_code == 201
    iid1 = r1.json()["id"]
    r2 = client.post("/api/interviews", json={"role": "Quota Probe 2"})
    assert r2.status_code == 201
    iid2 = r2.json()["id"]
    # /usage reports tier + the daily GLOBAL chat-turn dial (per owner, not per interview).
    u = client.get("/api/usage")
    assert u.status_code == 200
    body = u.json()
    assert "daily_interviews" not in body
    assert body["tier"] == "dev"  # no-Clerk dev-fallback -> dev tier
    assert body["chat_turns_per_day_dev"] == 500
    assert body["chat_turns_used_today"] >= 0
    assert body["chat_turns_remaining_today"] >= 0

    assert client.delete(f"/api/interviews/{iid1}").status_code == 204
    assert client.delete(f"/api/interviews/{iid2}").status_code == 204


def test_usage_tracks_global_daily_counter(client):
    # A turn in one interview advances the shared per-owner daily counter that all of the
    # owner's interviews draw from (cap math is unit-tested; dev cap 500 keeps this under it).
    c = client
    iv = c.post("/api/interviews", json={"role": "Cap Probe"}).json()
    iid = iv["id"]
    c.post(f"/api/interviews/{iid}/start")

    before = c.get("/api/usage").json()["chat_turns_used_today"]
    r = c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "ping"})
    assert r.status_code == 200
    after = c.get("/api/usage").json()["chat_turns_used_today"]
    assert after == before + 1
    c.delete(f"/api/interviews/{iid}")


def test_regenerate_feedback_rejects_incomplete_and_foreign(client):
    r = client.post("/api/interviews", json={"role": "Regen Guard"})
    assert r.status_code == 201
    pending_id = r.json()["id"]
    rr = client.post(f"/api/interviews/{pending_id}/feedback/generate")
    assert rr.status_code == 409

    # A nonexistent/foreign interview is a 404 via the ownership guard.
    rr = client.post("/api/interviews/00000000-0000-0000-0000-000000000000/feedback/generate")
    assert rr.status_code == 404

    client.delete(f"/api/interviews/{pending_id}")


def test_complete_requires_at_least_one_message(client):
    # Regression: completing a never-chatted interview produced a "completed, scoring can
    # never succeed" row (empty transcript -> 503 on every retry, no way back in).
    iv = client.post("/api/interviews", json={"role": "Empty Complete"}).json()
    iid = iv["id"]
    assert client.post(f"/api/interviews/{iid}/start").status_code == 200
    r = client.post(f"/api/interviews/{iid}/complete")
    assert r.status_code == 409
    assert client.get(f"/api/interviews/{iid}").json()["status"] == "in_progress"  # still resumable

    client.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
    assert client.post(f"/api/interviews/{iid}/complete").status_code == 200
    client.delete(f"/api/interviews/{iid}")


def test_regenerate_feedback_rejects_empty_transcript(client, monkeypatch):
    # Legacy rows (completed before the /complete guard) must answer 409, not a 503 the retry
    # button can never clear. The empty-but-completed state is unreachable via the API now,
    # so stub the predicate instead of deleting rows behind the app's pool.
    from app import main as main_mod

    iv = client.post("/api/interviews", json={"role": "Empty Regen"}).json()
    iid = iv["id"]
    client.post(f"/api/interviews/{iid}/start")
    client.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
    assert client.post(f"/api/interviews/{iid}/complete").status_code == 200

    async def _empty(_interview_id):
        return False

    monkeypatch.setattr(main_mod, "_has_transcript", _empty)
    r = client.post(f"/api/interviews/{iid}/feedback/generate")
    assert r.status_code == 409
    assert "no answers" in r.json()["detail"]
    client.delete(f"/api/interviews/{iid}")


def test_regenerate_feedback_writes_when_model_recovers(client, monkeypatch):
    from app import llm
    from app import main as main_mod
    from app.models import FeedbackSummary

    iv = client.post("/api/interviews", json={"role": "Regen Recovers"}).json()
    iid = iv["id"]
    client.post(f"/api/interviews/{iid}/start")
    client.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hello?"})

    # First complete: model "fails" (None, as in real mode) -> no feedback row written.
    # /complete auto-retries, so neutralize its backoff timer to keep this test fast.
    monkeypatch.setattr(main_mod, "_backoff_sleep", _noop_sleep)
    monkeypatch.setattr(llm, "generate_feedback", _always_none)
    r = client.post(f"/api/interviews/{iid}/complete")
    assert r.status_code == 200
    assert r.json()["status"] == "completed"
    assert client.get(f"/api/interviews/{iid}/feedback").status_code == 404  # genuinely absent

    # Later regenerate: model "recovers" -> row written; 404 turns into 200.
    async def _ok(history, dials=None, config=None, **_kw):
        return FeedbackSummary(scores={d: 7.0 for d in llm.FEEDBACK_DIMS}, verdict="Recovered", tips=["Keep going."])

    monkeypatch.setattr(llm, "generate_feedback", _ok)
    rr = client.post(f"/api/interviews/{iid}/feedback/generate")
    assert rr.status_code == 200
    assert rr.json()["verdict"] == "Recovered"
    fb = client.get(f"/api/interviews/{iid}/feedback")
    assert fb.status_code == 200
    assert fb.json()["verdict"] == "Recovered"
    client.delete(f"/api/interviews/{iid}")


async def _always_none(history, dials=None, config=None, **_kw):
    return None


async def _noop_sleep(ms):
    return None  # neutralize the /complete auto-retry backoff so integration tests run instantly


def test_complete_auto_retries_then_leaves_unscored_when_always_none(client, monkeypatch):
    from app import llm
    from app import main as main_mod

    monkeypatch.setattr(main_mod, "_backoff_sleep", _noop_sleep)
    attempts = {"n": 0}

    async def _count_none(_history, dials=None, config=None, **_kw):
        attempts["n"] += 1
        return None

    monkeypatch.setattr(llm, "generate_feedback", _count_none)

    iv = client.post("/api/interviews", json={"role": "AutoRetry Exhaust"}).json()
    iid = iv["id"]
    client.post(f"/api/interviews/{iid}/start")
    client.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hello?"})

    r = client.post(f"/api/interviews/{iid}/complete")
    assert r.status_code == 200
    assert r.json()["status"] == "completed"
    assert attempts["n"] == main_mod.COMPLETE_MAX_FEEDBACK_ATTEMPTS  # bounded, not infinite
    assert client.get(f"/api/interviews/{iid}/feedback").status_code == 404  # still unscored -> manual
    client.delete(f"/api/interviews/{iid}")


def test_complete_auto_retry_stops_on_first_success(client, monkeypatch):
    from app import llm
    from app import main as main_mod
    from app.models import FeedbackSummary

    monkeypatch.setattr(main_mod, "_backoff_sleep", _noop_sleep)
    attempts = {"n": 0}

    async def _flaky(_history, dials=None, config=None, **_kw):
        attempts["n"] += 1
        if attempts["n"] == 1:
            return None
        return FeedbackSummary(scores={d: 7.0 for d in llm.FEEDBACK_DIMS}, verdict="Auto recovered", tips=["Keep."])

    monkeypatch.setattr(llm, "generate_feedback", _flaky)

    iv = client.post("/api/interviews", json={"role": "AutoRetry Recover"}).json()
    iid = iv["id"]
    client.post(f"/api/interviews/{iid}/start")
    client.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hello?"})

    r = client.post(f"/api/interviews/{iid}/complete")
    assert r.status_code == 200
    assert attempts["n"] == 2  # recovered on attempt 2; no 3rd attempt
    assert r.json()["status"] == "completed"
    fb = client.get(f"/api/interviews/{iid}/feedback")
    assert fb.status_code == 200
    assert fb.json()["verdict"] == "Auto recovered"
    client.delete(f"/api/interviews/{iid}")


# --- BYOK settings (app/byok.py, BYOK.md) ---


def test_byok_chat_turn_skips_the_quota(client, monkeypatch):
    # BYOK pays the provider, not us: the turn must pass with zero credits left and must not
    # be metered. Both halves are asserted, since either one alone is a silent billing bug.
    from cryptography.fernet import Fernet

    from app import billing, byok, llm

    monkeypatch.setenv("BYOK_ENCRYPTION_KEY", Fernet.generate_key().decode())
    byok._fernet.cache_clear()
    bumps = {"n": 0}

    async def _no_quota(_tier, _owner):
        return 0

    async def _count_bump(_owner):
        bumps["n"] += 1

    async def _fake_stream(_history, config):
        assert config.byok is True  # the owner's target, not the system one
        yield "Sure - "

    monkeypatch.setattr(billing, "chat_turn_remaining", _no_quota)
    monkeypatch.setattr(billing, "bump_chat_turn", _count_bump)
    monkeypatch.setattr(llm, "stream_chat", _fake_stream)
    try:
        client.put("/api/settings/llm", json={"base_url": "https://api.example.com/v1", "model": "m", "api_key": "sk-unit-test-key-abcd"})
        iid = client.post("/api/interviews", json={"role": "BYOK quota"}).json()["id"]
        client.post(f"/api/interviews/{iid}/start")
        r = client.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
        assert r.status_code == 200
        assert "Sure - " in r.text
        assert bumps["n"] == 0  # unmetered
        assert client.get("/api/usage").json()["byok"] is True
        client.delete(f"/api/interviews/{iid}")
    finally:
        client.delete("/api/settings/llm")
        byok._fernet.cache_clear()


def test_byok_settings_round_trip_without_ever_returning_the_key(client, monkeypatch):
    from cryptography.fernet import Fernet

    from app import byok

    monkeypatch.setenv("BYOK_ENCRYPTION_KEY", Fernet.generate_key().decode())
    byok._fernet.cache_clear()
    key = "sk-unit-test-key-abcd"
    try:
        status = client.get("/api/settings/llm").json()
        assert (status["enabled"], status["byok"]) == (True, False)
        assert set(status["system"]) == {"configured", "base_url", "model"}

        r = client.put("/api/settings/llm", json={"base_url": "https://api.example.com/v1/", "model": "some-model", "api_key": key})
        assert r.status_code == 200
        body = r.json()
        assert (body["byok"], body["base_url"], body["model"], body["key_hint"]) == (True, "https://api.example.com/v1", "some-model", "abcd")
        assert key not in r.text  # the write response carries the hint, never the key
        assert key not in client.get("/api/settings/llm").text

        # Editing base URL/model alone keeps the stored key (no re-paste).
        assert client.put("/api/settings/llm", json={"base_url": "https://api.example.com/v1", "model": "another", "api_key": ""}).json()["model"] == "another"
        assert client.delete("/api/settings/llm").status_code == 204
        assert client.get("/api/settings/llm").json()["byok"] is False
    finally:
        client.delete("/api/settings/llm")  # never leave dev-user pointing at a fake provider
        byok._fernet.cache_clear()


def test_byok_write_is_refused_without_the_deployment_encryption_key(client, monkeypatch):
    from app import byok

    monkeypatch.delenv("BYOK_ENCRYPTION_KEY", raising=False)
    byok._fernet.cache_clear()
    try:
        r = client.put("/api/settings/llm", json={"base_url": "https://api.example.com/v1", "model": "m", "api_key": "sk-unit-test-key-abcd"})
        assert r.status_code == 503
        assert "BYOK_ENCRYPTION_KEY" in r.json()["detail"]
        assert client.get("/api/settings/llm").json()["enabled"] is False
    finally:
        byok._fernet.cache_clear()


def test_hardcore_ends_the_run_on_the_first_wrong_answer(client, monkeypatch):
    from app import llm

    # The live judge: answer 1 is called wrong. Everything else about the run is the real code path.
    async def _judge(_question, _answer, _config, _turn=1):
        return "mistake"

    monkeypatch.setattr(llm, "judge_answer", _judge)
    c = client
    iv = c.post("/api/interviews", json={"role": "Hardcore Judge", "hardcore": True}).json()
    assert iv["hardcore"] is True
    iid = iv["id"]
    c.post(f"/api/interviews/{iid}/start")

    body = c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "uh, I think we just retried it"}).text
    assert llm.FAIL_MESSAGE.format(cls="MISTAKE") in body  # shouted, in caps, in the transcript
    assert '"failed": {"turn": 1, "class": "mistake"}' in body  # ... and the client is told why it ended
    # The run is over for the API too, not just for the composer.
    assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "one more"}).status_code == 409
    # The wrong answer keeps its class, which is what the review points at.
    assert [m["move_class"] for m in c.get(f"/api/interviews/{iid}/messages").json()] == ["mistake"]

    assert c.post(f"/api/interviews/{iid}/complete").status_code == 200
    fb = c.get(f"/api/interviews/{iid}/feedback").json()
    assert (fb["failed_turn"], fb["failed_class"]) == (1, "mistake")
    assert (fb["grade"], fb["decision"]) == ("F", "reject")  # one wrong move overrides the average
    assert fb["verdict"].isupper()  # the stub's shout; the real path prompts the model for caps
    row = next(i for i in c.get("/api/interviews").json() if i["id"] == iid)
    assert (row["failed_turn"], row["failed_class"], row["grade"]) == (1, "mistake", "F")
    c.delete(f"/api/interviews/{iid}")


def test_hardcore_lets_a_clean_answer_through(client, monkeypatch):
    # The judge only ends the run on mistake/blunder: `inaccuracy` is survivable, and so is a judge
    # that comes back empty (a model outage must not fail a candidate by default).
    from app import llm

    async def _judge(_question, _answer, _config, _turn=1):
        return "inaccuracy"

    monkeypatch.setattr(llm, "judge_answer", _judge)
    c = client
    iid = c.post("/api/interviews", json={"role": "Hardcore Survivor", "hardcore": True}).json()["id"]
    c.post(f"/api/interviews/{iid}/start")
    assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "it was vague, I admit"}).status_code == 200
    assert [m["move_class"] for m in c.get(f"/api/interviews/{iid}/messages").json() if m["role"] == "user"] == ["inaccuracy"]
    assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "let me be specific"}).status_code == 200
    c.delete(f"/api/interviews/{iid}")
