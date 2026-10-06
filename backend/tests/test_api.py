import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_resumes import encrypted, mini_pdf

from app import rating, resumes
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

    # start/finish echo the same row (their RETURNING used to drop columns, which the response
    # model then silently filled from defaults). One request each: a second /start 409s, so these
    # bodies must be captured before being indexed.
    started = c.post(f"/api/interviews/{iid}/start").json()
    assert {k: started[k] for k in expected} == expected
    c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hello"})
    completed = c.post(f"/api/interviews/{iid}/finish").json()
    assert {k: completed[k] for k in expected} == expected
    c.delete(f"/api/interviews/{iid}")


def test_chat_refuses_turns_after_the_question_mix_is_spent(client):
    from app import llm

    c = client
    # Every budget on 0 -> the arc is the material ask + tell-me-about-yourself, so the opener, two
    # replies and the sign-off are the whole run; the turn after that is over the plan.
    iv = c.post("/api/interviews", json={"role": "Mix Exhausted", "mix_chitchat": 0, "mix_behavioural": 0, "mix_technical": 0}).json()
    iid = iv["id"]
    c.post(f"/api/interviews/{iid}/start")
    # One credit per MODEL turn: the opener, each reply, and the sign-off - which is exactly the run
    # below, so the whole arc costs 3.
    before = c.get("/api/usage").json()["chat_turns_used_today"]
    assert c.post(f"/api/interviews/{iid}/chat/kickoff").status_code == 200
    for i in range(2):
        assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": f"answer {i}"}).status_code == 200
    assert c.get("/api/usage").json()["chat_turns_used_today"] == before + 3

    transcript_before = c.get(f"/api/interviews/{iid}/messages").json()
    # Stub mode's sign-off is the canned line, persisted like any reply, so the transcript ends the
    # way it was displayed. The opener is the first row: nothing was drawn client-side.
    assert [m["role"] for m in transcript_before] == ["assistant", "user", "assistant", "user", "assistant"]
    assert llm.CLOSING_MESSAGE in transcript_before[-1]["content"]
    r = c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "one more thing"})
    assert r.status_code == 409
    assert "Press Finish" in r.json()["detail"]
    # Refused BEFORE the model call, the chat credit, and the write: an over-plan turn must not
    # cost a quota credit or leave an unanswered user turn in the transcript.
    assert c.get("/api/usage").json()["chat_turns_used_today"] == before + 3
    assert c.get(f"/api/interviews/{iid}/messages").json() == transcript_before
    c.delete(f"/api/interviews/{iid}")


def test_kickoff_generates_the_opener_once_and_spends_a_turn(client):
    # The first message of a run is a model turn rather than a bubble the frontend draws, so it is
    # metered like every other turn and generated exactly once.
    c = client
    iid = c.post("/api/interviews", json={"role": "Opener"}).json()["id"]
    c.post(f"/api/interviews/{iid}/start")

    before = c.get("/api/usage").json()["chat_turns_used_today"]
    # Sent the way the client sends it: an empty JSON body.
    r = c.post(f"/api/interviews/{iid}/chat/kickoff", json={})
    assert r.status_code == 200
    assert "event: done" in r.text
    assert [m["role"] for m in c.get(f"/api/interviews/{iid}/messages").json()] == ["assistant"]
    assert c.get("/api/usage").json()["chat_turns_used_today"] == before + 1

    # A second opener is a second charge for a turn the transcript already has.
    assert c.post(f"/api/interviews/{iid}/chat/kickoff", json={}).status_code == 409
    assert c.get("/api/usage").json()["chat_turns_used_today"] == before + 1
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
    # No `done` behind it: that frame is what tells the client the turn landed, and the frontend's
    # done branch flushes the voice queue - a rolled-back reply would be read aloud.
    assert "event: done" not in body
    assert c.get(f"/api/interviews/{iid}/messages").json() == []

    # The same turn after the model recovers: exactly one copy of the answer.
    monkeypatch.undo()
    assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "my answer"}).status_code == 200
    roles = [m["role"] for m in c.get(f"/api/interviews/{iid}/messages").json()]
    assert roles == ["user", "assistant"]
    c.delete(f"/api/interviews/{iid}")


def test_chat_keeps_the_turn_when_finish_lands_mid_stream(client, monkeypatch):
    # /finish and a live stream race: by the time the rollback runs the run is already complete,
    # so deleting the turn would leave it holding no answers - GET /feedback 404s and
    # /feedback/generate 409s, which no retry can clear.
    from app import llm
    from app.db import fetchrow

    c = client
    iid = c.post("/api/interviews", json={"role": "Rollback After Complete"}).json()["id"]
    c.post(f"/api/interviews/{iid}/start")

    async def _boom_after_finish(*_a, **_kw):
        await fetchrow("UPDATE interviews SET status = 'completed' WHERE id = $1", iid)
        raise RuntimeError("provider exploded")
        yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr(llm, "stream_chat", _boom_after_finish)
    assert "event: error" in c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "my answer"}).text
    assert [m["content"] for m in c.get(f"/api/interviews/{iid}/messages").json()] == ["my answer"]
    # The reason for keeping it: the completed run is still scorable.
    assert c.post(f"/api/interviews/{iid}/feedback/generate").status_code == 200
    c.delete(f"/api/interviews/{iid}")


def test_chat_stream_names_the_provider_it_could_not_reach(client, monkeypatch):
    # The frame the browser prints verbatim: "ConnectError" is not an instruction, the endpoint is.
    import httpx

    from app import llm

    async def _unreachable(*_a, **_kw):
        raise httpx.ConnectError("All connection attempts failed")
        yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr(llm, "stream_chat", _unreachable)
    c = client
    iid = c.post("/api/interviews", json={"role": "Unreachable Provider"}).json()["id"]
    c.post(f"/api/interviews/{iid}/start")
    body = c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"}).text
    assert "Could not reach the deployment's provider" in body and "ConnectError" in body
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
    assert interview["owner_id"] == "dev-user"  # scoped to the current dev user
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
    # The opener is the question the answer counts against: without it the certainty cap floors.
    assert c.post(f"/api/interviews/{iid}/chat/kickoff").status_code == 200
    r = c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "I have 5 years of experience."})
    assert r.status_code == 200
    assert "text/event-stream" in r.headers["content-type"]
    # Both the user turn and the streamed assistant reply are persisted (transcript complete).
    r = c.get(f"/api/interviews/{iid}/messages")
    assert r.status_code == 200
    roles = [m["role"] for m in r.json()]
    assert "user" in roles and "assistant" in roles

    # complete -> completed (M6 auto-generates feedback in stub mode)
    r = c.post(f"/api/interviews/{iid}/finish")
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
    # Every classed turn carries the note it was graded with (stub mode: canned per class).
    assert all(m["comment"] for m in msgs if m["move_class"])
    assert all(m["comment"] is None for m in msgs if m["role"] != "user")

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
    assert r.status_code in (200, 404)  # DEV_USER owns it, so 200; foreign-user path is owner-safe

    r = c.delete(f"/api/interviews/{iid}")
    assert r.status_code == 204


def test_archive_hides_a_run_from_history_but_keeps_it_in_the_stats(client):
    # Archive is a list-hiding flag, NOT a status and NOT a delete: the row still comes back from
    # GET /interviews (so the dashboard keeps counting it), keeps its lifecycle, and clearing the
    # flag brings it back into the history. That is the whole difference from DELETE.
    c = client
    iid = c.post("/api/interviews", json={"role": "Archive Probe"}).json()["id"]

    r = c.post(f"/api/interviews/{iid}/archive")
    assert r.status_code == 200
    assert r.json()["archived_at"] is not None
    assert r.json()["status"] == "pending"

    listing = c.get("/api/interviews").json()
    assert any(i["id"] == iid for i in listing)  # still listed: the UI hides it, the API does not
    assert next(i for i in listing if i["id"] == iid)["archived_at"] is not None
    assert c.get(f"/api/interviews/{iid}").json()["archived_at"] is not None

    r = c.delete(f"/api/interviews/{iid}/archive")
    assert r.status_code == 200
    assert r.json()["archived_at"] is None

    # Unknown id is a 404, never a silent success.
    assert c.post("/api/interviews/00000000-0000-0000-0000-000000000000/archive").status_code == 404
    assert c.delete("/api/interviews/00000000-0000-0000-0000-000000000000/archive").status_code == 404

    assert c.delete(f"/api/interviews/{iid}").status_code == 204


def _wipe_templates(c):
    """Presets are owner-scoped AND seeded with the built-ins (DEFAULT_TEMPLATES) on first read, so
    every test here starts from an empty row: a leftover default would otherwise eat the 20-cap and
    the suite would depend on test order."""
    for row in c.get("/api/templates").json():
        c.delete(f"/api/templates/{row['id']}")


def test_default_templates_seeded_once(client):
    # The identity is fixed in tests, so re-arm the owner's seed marker directly (the same way
    # test_template_owner_scoping reaches for asyncpg) to observe the first read of a new account.
    import asyncio

    import asyncpg

    c = client
    _wipe_templates(c)

    async def unseed():
        conn = await asyncpg.connect(DB_URL)
        try:
            await conn.execute("DELETE FROM template_seeds WHERE owner_id = 'dev-user'")
        finally:
            await conn.close()

    asyncio.run(unseed())
    seeded = c.get("/api/templates").json()
    assert [t["name"] for t in seeded] == ["The Killer", "The Griller", "The Chiller"]

    # The presets are the point: each is a body the create endpoint accepts unchanged.
    killer = seeded[0]
    assert (killer["hardcore"], killer["brutally_honest"], killer["human_mode"]) == (True, True, False)
    assert (killer["company_size"], killer["cynicism"]) == ("5k+", "skeptical")
    made = c.post("/api/interviews", json={k: v for k, v in killer.items() if k not in ("id", "name", "owner_id", "created_at", "updated_at")})
    assert made.status_code == 201
    assert c.delete(f"/api/interviews/{made.json()['id']}").status_code == 204
    # A later read does not seed a second copy.
    assert [t["id"] for t in c.get("/api/templates").json()] == [t["id"] for t in seeded]

    # Deleting one is permanent: the marker, not the row count, decides whether to seed again.
    assert c.delete(f"/api/templates/{killer['id']}").status_code == 204
    assert [t["name"] for t in c.get("/api/templates").json()] == ["The Griller", "The Chiller"]
    _wipe_templates(c)


def test_templates_round_trip_rename_and_cap(client):
    c = client
    _wipe_templates(c)
    # A preset body IS a create body, so the same payload has to be accepted by both endpoints.
    body = {
        "name": "Senior BE @5k",
        "role": "Backend Engineer",
        "level": "senior",
        "topic": "system design",
        "company_size": "5k+",
        "cynicism": "skeptical",
        "brutally_honest": True,
        "human_mode": False,
        "hardcore": True,
        "mix_chitchat": 1,
        "mix_behavioural": 3,
        "mix_technical": 4,
    }
    # The same dials are a valid create body: one vocabulary, two endpoints.
    made = c.post("/api/interviews", json={k: v for k, v in body.items() if k != "name"})
    assert made.status_code == 201
    assert c.delete(f"/api/interviews/{made.json()['id']}").status_code == 204

    r = c.post("/api/templates", json=body)
    assert r.status_code == 201
    preset = r.json()
    assert all(preset[k] == v for k, v in body.items())
    assert c.get("/api/templates").json()[0]["id"] == preset["id"]  # newest first

    # Unspecified dials default from the same model an interview's do.
    bare = c.post("/api/templates", json={"name": "Bare", "role": "Any Role"}).json()
    assert (bare["cynicism"], bare["human_mode"], bare["mix_technical"]) == ("neutral", True, 4)

    # PUT is a full replace; rename is just that same call with a new name.
    r = c.put(f"/api/templates/{preset['id']}", json={**body, "name": "Renamed", "cynicism": "kind"})
    assert (r.status_code, r.json()["name"], r.json()["cynicism"]) == (200, "Renamed", "kind")
    assert next(x for x in c.get("/api/templates").json() if x["id"] == preset["id"])["cynicism"] == "kind"

    assert c.delete(f"/api/templates/{preset['id']}").status_code == 204
    assert c.delete(f"/api/templates/{preset['id']}").status_code == 404
    assert [x["name"] for x in c.get("/api/templates").json()] == ["Bare"]

    # Cap per owner, and the 409 names the number instead of failing blind.
    for n in range(2, 21):
        assert c.post("/api/templates", json={"name": f"Cap {n}", "role": "Filler"}).status_code == 201
    r = c.post("/api/templates", json={"name": "Over", "role": "Filler"})
    assert r.status_code == 409 and "20" in r.json()["detail"]
    # Deleting frees a slot: the cap is a live count, not a ratchet.
    listed = c.get("/api/templates").json()
    assert c.delete(f"/api/templates/{next(x for x in listed if x['name'] == 'Cap 2')['id']}").status_code == 204
    assert c.post("/api/templates", json={"name": "Fits", "role": "Filler"}).status_code == 201

    for t in c.get("/api/templates").json():
        assert c.delete(f"/api/templates/{t['id']}").status_code == 204


def test_template_owner_scoping(client):
    # The predicate is owner_id on every statement, create included: another owner's preset is
    # invisible in the list and unreadable/unwritable by id (404, never a silent success).
    import asyncio

    import asyncpg

    c = client
    _wipe_templates(c)

    async def insert_foreign():
        conn = await asyncpg.connect(DB_URL)
        try:
            return await conn.fetchval("INSERT INTO interview_templates (owner_id, name, role) VALUES ('someone-else', 'Not yours', 'Backend Engineer') RETURNING id::text")
        finally:
            await conn.close()

    foreign = asyncio.run(insert_foreign())
    assert all(x["id"] != foreign for x in c.get("/api/templates").json())
    assert c.put(f"/api/templates/{foreign}", json={"name": "Hijack", "role": "Backend Engineer"}).status_code == 404
    assert c.delete(f"/api/templates/{foreign}").status_code == 404
    assert c.delete("/api/templates/00000000-0000-0000-0000-000000000000").status_code == 404


# --- resumes: import, library, tiers, attach (app/resumes.py + the endpoints) ---


def _wipe_resumes(c):
    """Resumes are owner-scoped AND capped, so every test here starts from an empty library: leftover
    rows would otherwise eat the tier cap and make the suite order-dependent."""
    for row in c.get("/api/resumes").json():
        c.delete(f"/api/resumes/{row['id']}")


def _resume_payload(name="CV", text="Alex Mender - platform engineer. Go, Terraform, Kubernetes."):
    return {"name": name, "text": text}


def test_resume_import_round_trip_and_list_shape(client):
    c = client
    _wipe_resumes(c)
    # The two-step import the UI performs: extract (STATELESS) then save the text the browser got.
    got = c.post("/api/resumes/extract", files={"file": ("cv.pdf", mini_pdf("Alex Mender - Platform Engineer"), "application/pdf")})
    assert got.status_code == 200
    extracted = got.json()
    assert "Alex Mender" in extracted["text"] and (extracted["pages"], extracted["truncated"]) == (1, False)

    made = c.post("/api/resumes", json={"name": "cv.pdf", "text": extracted["text"]})
    assert made.status_code == 201
    row = made.json()
    # `name` is display text, never a path: the suffix is dropped here, and nothing ever reads a file.
    assert (row["name"], row["page_count"], row["chars"]) == ("cv", 0, len(extracted["text"]))

    # The list carries no text - a 60k-char body per row is the fan-out the rate budget bans - and the
    # editor fetches the one row it opened.
    listed = c.get("/api/resumes").json()
    assert listed[0]["id"] == row["id"] and "text" not in listed[0]
    assert c.get(f"/api/resumes/{row['id']}").json()["text"] == extracted["text"]

    # PUT is a full replace, and it is how a bad extraction gets fixed.
    fixed = c.put(f"/api/resumes/{row['id']}", json={"name": "CV fixed", "text": "Corrected."})
    assert fixed.status_code == 200
    assert (fixed.json()["name"], fixed.json()["text"], fixed.json()["chars"]) == ("CV fixed", "Corrected.", 10)

    assert c.delete(f"/api/resumes/{row['id']}").status_code == 204
    assert c.delete(f"/api/resumes/{row['id']}").status_code == 404
    assert c.get(f"/api/resumes/{row['id']}").status_code == 404


def test_resume_import_rejects_documents_it_cannot_read(client):
    c = client

    # Filename and Content-Type say "pdf" on every one of these and are deliberately ignored: only the
    # bytes decide.
    def upload(data):
        return c.post("/api/resumes/extract", files={"file": ("cv.pdf", data, "application/pdf")})

    assert upload(b"<html>not a pdf at all</html>").status_code == 422
    assert "isn't a PDF" in upload(b"PK\x03\x04").json()["detail"]
    # Over the byte cap: a 413 with the paste hint, refused before any parser sees it.
    assert upload(b"%PDF-" + b" " * (resumes.MAX_BYTES + 1)).status_code == 413
    assert "password-protected" in upload(encrypted()).json()["detail"]
    # A valid PDF with no text layer (a scan or an image export): the paste fallback, not a 500.
    assert "Paste the text instead" in upload(mini_pdf("")).json()["detail"]


def test_resume_tier_caps_free_is_402_paid_is_409(client, monkeypatch):
    from app import billing

    c = client
    _wipe_resumes(c)

    # A free owner gets exactly one, and the second is a 402 - which IS the upsell path: the UI turns
    # isQuotaError(402) into its upgrade notice, so nothing new has to be built for this wall.
    tier = {"value": "free"}

    async def fake_tier(_user):
        return tier["value"]

    monkeypatch.setattr(billing, "resolve_tier", fake_tier)
    monkeypatch.setitem(billing.LIMITS["free"], "resumes", 1)
    assert c.post("/api/resumes", json=_resume_payload("Free one")).status_code == 201
    over = c.post("/api/resumes", json=_resume_payload("Free two"))
    assert over.status_code == 402 and "upgrade" in over.json()["detail"].lower()
    # The library page reads the cap from /usage, the same place it reads the tier.
    assert c.get("/api/usage").json()["resume_limit"] == 1
    # Deleting frees the slot: a live count, not a ratchet.
    assert c.delete(f"/api/resumes/{c.get('/api/resumes').json()[0]['id']}").status_code == 204
    assert c.post("/api/resumes", json=_resume_payload("Free two")).status_code == 201

    # A paid owner at the ceiling is a 409: there is nothing to sell them.
    tier["value"] = "dev"
    monkeypatch.setitem(billing.LIMITS["dev"], "resumes", 2)
    assert c.post("/api/resumes", json=_resume_payload("Paid one")).status_code == 201
    full = c.post("/api/resumes", json=_resume_payload("Paid two"))
    assert full.status_code == 409 and "maximum" in full.json()["detail"]
    _wipe_resumes(c)


def test_resume_owner_scoping(client):
    # owner_id is on every statement: another owner's resume is invisible in the list, unreadable and
    # undeletable by id, and cannot be attached to a run or a preset.
    import asyncio

    import asyncpg

    c = client
    _wipe_resumes(c)

    async def insert_foreign():
        conn = await asyncpg.connect(DB_URL)
        try:
            return await conn.fetchval("INSERT INTO resumes (owner_id, name, text) VALUES ('someone-else', 'Not yours', 'secret') RETURNING id::text")
        finally:
            await conn.close()

    foreign = asyncio.run(insert_foreign())
    assert all(x["id"] != foreign for x in c.get("/api/resumes").json())
    assert c.get(f"/api/resumes/{foreign}").status_code == 404
    assert c.put(f"/api/resumes/{foreign}", json=_resume_payload("Hijack")).status_code == 404
    assert c.delete(f"/api/resumes/{foreign}").status_code == 404
    assert c.post("/api/interviews", json={"role": "Backend Engineer", "resume_id": foreign}).status_code == 404
    assert c.post("/api/templates", json={"name": "Steal", "role": "Backend Engineer", "resume_id": foreign}).status_code == 404
    # A malformed id is a 422 from the model, not a 500 from a uuid cast in the query.
    assert c.post("/api/interviews", json={"role": "Backend Engineer", "resume_id": "not-a-uuid"}).status_code == 422


def test_resume_attaches_to_an_interview_and_outlives_its_delete(client):
    c = client
    _wipe_resumes(c)
    rid = c.post("/api/resumes", json=_resume_payload("Attach me")).json()["id"]
    made = c.post("/api/interviews", json={"role": "Backend Engineer", "resume_id": rid})
    assert made.status_code == 201
    interview = made.json()
    assert interview["resume_id"] == rid
    # Every read path carries the attach point; the shared column list is why they cannot drift.
    assert c.get(f"/api/interviews/{interview['id']}").json()["resume_id"] == rid
    assert next(x for x in c.get("/api/interviews").json() if x["id"] == interview["id"])["resume_id"] == rid

    # Deleting the resume must not delete the run: SET NULL keeps the transcript, and the run simply
    # stops being tailored to a resume that no longer exists.
    assert c.delete(f"/api/resumes/{rid}").status_code == 204
    after = c.get(f"/api/interviews/{interview['id']}")
    assert after.status_code == 200 and after.json()["resume_id"] is None
    assert c.delete(f"/api/interviews/{interview['id']}").status_code == 204


def test_template_remembers_the_resume(client):
    c = client
    _wipe_resumes(c)
    rid = c.post("/api/resumes", json=_resume_payload("Preset resume")).json()["id"]
    t = c.post("/api/templates", json={"name": "With resume", "role": "Backend Engineer", "resume_id": rid})
    assert t.status_code == 201 and t.json()["resume_id"] == rid

    # A rename is a full replace, and it must carry the attachment: a preset that silently dropped it
    # would interview against nothing (the drift this test exists to catch).
    renamed = c.put(f"/api/templates/{t.json()['id']}", json={"name": "Renamed", "role": "Backend Engineer", "resume_id": rid})
    assert renamed.json()["resume_id"] == rid
    # Omitting it detaches on purpose: nullable, not sticky.
    assert c.put(f"/api/templates/{t.json()['id']}", json={"name": "Renamed", "role": "Backend Engineer"}).json()["resume_id"] is None
    assert c.put(f"/api/templates/{t.json()['id']}", json={"name": "Renamed", "role": "Backend Engineer", "resume_id": rid}).json()["resume_id"] == rid

    # Deleting the resume leaves the preset alive and unattached.
    assert c.delete(f"/api/resumes/{rid}").status_code == 204
    assert c.get("/api/templates").json()[0]["resume_id"] is None
    assert c.delete(f"/api/templates/{t.json()['id']}").status_code == 204


def test_resume_write_paths_share_one_hygiene(client):
    # Both write paths run the same sanitizer, so a pasted resume cannot smuggle in what an extracted
    # one gets stripped. Zero-width joiners and bidi overrides are invisible to a person reading their
    # own CV and are exactly what "hidden instructions" look like to a model.
    c = client
    _wipe_resumes(c)
    made = c.post("/api/resumes", json={"name": "Hi\u200bthere", "text": "Line one\u200b\u202e\n\n\n\nLine two"})
    assert made.status_code == 201
    assert made.json()["name"] == "Hithere"
    assert c.get(f"/api/resumes/{made.json()['id']}").json()["text"] == "Line one\n\nLine two"
    # Whitespace-only is not a resume: 422 beats a row the interviewer would read as empty.
    assert c.post("/api/resumes", json={"name": "Empty", "text": "   \n\u200b  "}).status_code == 422
    assert c.put(f"/api/resumes/{made.json()['id']}", json={"name": "Empty", "text": " "}).status_code == 422
    assert c.delete(f"/api/resumes/{made.json()['id']}").status_code == 204


def test_resume_reaches_both_prompts_from_the_database(client, monkeypatch):
    # The attach point is a ROW, so what the prompts receive is what the candidate actually imported -
    # not whatever a request body might claim. Two different prompts, two different calls, same text.
    from app import llm
    from app import main as app_main

    c = client
    _wipe_resumes(c)
    rid = c.post("/api/resumes", json=_resume_payload("Fodder", "Alex ran a 40-node K3s cluster and cut p99 from 40s to 900ms.")).json()["id"]
    iid = c.post("/api/interviews", json={"role": "Platform Engineer", "resume_id": rid}).json()["id"]
    c.post(f"/api/interviews/{iid}/start")
    c.post(f"/api/interviews/{iid}/chat/kickoff")

    sent = {}

    async def _capture_stream(history, config):
        sent["interviewer"] = history[0].content
        yield "Tell me about the cluster."

    monkeypatch.setattr(llm, "stream_chat", _capture_stream)
    assert "Tell me about the cluster." in c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"}).text
    assert "40-node K3s cluster" in sent["interviewer"]
    # Still the system prompt, not a synthetic turn: the transcript the model reads is unchanged.
    assert sent["interviewer"].startswith(llm.SYSTEM_PROMPT_V1)

    # The grader is a separate prompt built by a separate call, and it gets the same resume.
    real_grader_prompt = llm.grader_prompt
    monkeypatch.setattr(llm, "grader_prompt", lambda dials=None, resume="", level="any": sent.setdefault("grader", real_grader_prompt(dials, resume, level)))

    # A non-stub config, or generate_feedback short-circuits to the deterministic stand-in before the
    # grader prompt is ever built (the test env has no provider). `_completion` below is the only thing
    # that would go to the network, and it is stubbed.
    monkeypatch.setattr(llm, "SYSTEM_CONFIG", llm.LLMConfig(base_url="http://127.0.0.1:9/v1", model="qwen-unit-test"))

    async def _prose(*_args, **_kwargs):
        return "Alex was concrete about the cluster."

    async def _no_sleep(_ms):
        return None

    monkeypatch.setattr(llm, "_completion", _prose)
    monkeypatch.setattr(app_main, "_backoff_sleep", _no_sleep)
    c.post(f"/api/interviews/{iid}/finish")
    assert "40-node K3s cluster" in sent["grader"]
    assert "A resume IS attached" in sent["grader"]
    assert llm.UNTRUSTED_INPUT in sent["grader"]  # the rule, not its wording: the prompt may be reworded
    c.delete(f"/api/interviews/{iid}")


def test_dimensions_aggregate_averages_rated_runs_and_the_newest_window(client):
    # One aggregate replaces the dashboard's per-rated-run GET /feedback fan-out, so it must produce
    # byte-identical numbers to the client math it replaces: average over the runs that SCORED a
    # dimension (absent = skipped, never 0), rounded to 1 decimal. Two series, both means: `averages`
    # over every rated run, `recent` over the newest RECENT_WINDOW of them, so the oldest run below is
    # half of the all-time numbers and none of the recent ones.
    import asyncio

    import asyncpg

    c = client

    # Seed straight to the DB: accuracy is only written by the scoring path, and the aggregate's
    # filter is the same "finished AND scored" the client applied to the list.
    async def seed(rows):
        conn = await asyncpg.connect(DB_URL)
        try:
            ids = []
            for age_min, role, status, accuracy, scores in rows:
                iid = await conn.fetchval(
                    "INSERT INTO interviews (owner_id, role, status, created_at) VALUES ($1, $2, $3, now() - make_interval(mins => $4)) RETURNING id::text",
                    "dev-user",
                    role,
                    status,
                    age_min,
                )
                await conn.execute(
                    "INSERT INTO feedback (interview_id, verdict, scores, accuracy) VALUES ($1::uuid, 'v', $2::jsonb, $3)",
                    iid,
                    json.dumps(scores),
                    accuracy,
                )
                ids.append(iid)
            return ids
        finally:
            await conn.close()

    # Ages, not insert order: "newest" means the newest FINISHED run, which is what the client took
    # from the list's created_at DESC order. The unrated and unfinished rows must not count at all,
    # even though they are newer than every rated one.
    ids = asyncio.run(
        seed(
            [
                (60, "Dim oldest", "completed", 60, {"clarity": 1, "structure": 10}),
                (50, "Dim old", "completed", 60, {"clarity": 2}),
                (40, "Dim mid", "completed", 60, {"clarity": 3}),
                (30, "Dim newer", "completed", 60, {"clarity": 4}),
                (20, "Dim recent", "completed", 60, {"clarity": 5}),
                (10, "Dim newest", "completed", 60, {"clarity": 6, "structure": 4}),
                (1, "Dim unrated", "completed", None, {"clarity": 9, "structure": 9}),
                (0, "Dim unfinished", "in_progress", 90, {"clarity": 10}),
            ]
        )
    )

    r = c.get("/api/stats/dimensions")
    assert r.status_code == 200
    d = r.json()
    assert d["count"] == 6
    # clarity: (1+2+3+4+5+6)/6 all-time, (2+3+4+5+6)/5 over the window. structure: (10+4)/2 and 4,
    # because the age-60 run that scored a 10 fell out of the window and no other run scored it.
    assert d["averages"] == {"clarity": 3.5, "structure": 7.0}
    assert d["recent_n"] == 5
    assert d["recent"] == {"clarity": 4.0, "structure": 4.0}

    for iid in ids:
        assert c.delete(f"/api/interviews/{iid}").status_code == 204

    # Nothing scored yet is an empty radar, not a 404 or a NULL-crash.
    empty = c.get("/api/stats/dimensions").json()
    assert empty == {"count": 0, "recent_n": 0, "averages": {}, "recent": {}}


def test_dimensions_are_owner_scoped(client):
    import asyncio

    import asyncpg

    async def seed_foreign():
        conn = await asyncpg.connect(DB_URL)
        try:
            iid = await conn.fetchval("INSERT INTO interviews (owner_id, role, status) VALUES ('someone-else', 'Not yours', 'completed') RETURNING id::text")
            await conn.execute("INSERT INTO feedback (interview_id, verdict, scores, accuracy) VALUES ($1::uuid, 'v', '{\"clarity\": 10}'::jsonb, 90)", iid)
            return iid
        finally:
            await conn.close()

    foreign = asyncio.run(seed_foreign())
    assert client.get("/api/stats/dimensions").json() == {"count": 0, "recent_n": 0, "averages": {}, "recent": {}}

    async def cleanup():
        conn = await asyncpg.connect(DB_URL)
        try:
            await conn.execute("DELETE FROM interviews WHERE id = $1::uuid", foreign)
        finally:
            await conn.close()

    asyncio.run(cleanup())


def test_move_review_annotates_every_candidate_turn(client):
    # The stub cycles good -> inaccuracy. Two answers is the smallest case that exercises the turn ->
    # row mapping as an ARRAY (one answer passes trivially), and accuracy must average both classes.
    c = client
    iid = c.post("/api/interviews", json={"role": "Move Review Multi"}).json()["id"]
    c.post(f"/api/interviews/{iid}/start")
    for answer in ("I shipped a cache layer in front of the read path.", "It dropped p99 by 40%."):
        assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": answer}).status_code == 200
    assert c.post(f"/api/interviews/{iid}/finish").status_code == 200

    msgs = c.get(f"/api/interviews/{iid}/messages").json()
    assert [m["move_class"] for m in msgs if m["role"] == "user"] == ["good", "inaccuracy"]
    notes = [m["comment"] for m in msgs if m["role"] == "user"]
    assert all(notes) and notes[0] != notes[1]  # one note per turn, and not the same note twice
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


def test_finish_requires_at_least_one_message(client):
    # Regression: completing a never-chatted interview produced a "completed, scoring can
    # never succeed" row (empty transcript -> 503 on every retry, no way back in).
    iv = client.post("/api/interviews", json={"role": "Empty Complete"}).json()
    iid = iv["id"]
    assert client.post(f"/api/interviews/{iid}/start").status_code == 200
    r = client.post(f"/api/interviews/{iid}/finish")
    assert r.status_code == 409
    assert client.get(f"/api/interviews/{iid}").json()["status"] == "in_progress"  # still resumable

    # The opener is a stored assistant turn, and it is not an answer: a run that only asked for the
    # resume must still refuse to finish, or the guard above would be satisfied by the interviewer.
    assert client.post(f"/api/interviews/{iid}/chat/kickoff").status_code == 200
    assert client.post(f"/api/interviews/{iid}/finish").status_code == 409

    client.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
    assert client.post(f"/api/interviews/{iid}/finish").status_code == 200
    client.delete(f"/api/interviews/{iid}")


def test_regenerate_feedback_rejects_empty_transcript(client, monkeypatch):
    # Legacy rows (completed before the /finish guard) must answer 409, not a 503 the retry
    # button can never clear. The empty-but-completed state is unreachable via the API now,
    # so stub the predicate instead of deleting rows behind the app's pool.
    from app import main as main_mod

    iv = client.post("/api/interviews", json={"role": "Empty Regen"}).json()
    iid = iv["id"]
    client.post(f"/api/interviews/{iid}/start")
    client.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
    assert client.post(f"/api/interviews/{iid}/finish").status_code == 200

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
    # /finish auto-retries, so neutralize its backoff timer to keep this test fast.
    monkeypatch.setattr(main_mod, "_backoff_sleep", _noop_sleep)
    monkeypatch.setattr(llm, "generate_feedback", _always_none)
    r = client.post(f"/api/interviews/{iid}/finish")
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


def test_review_redo_cap_is_per_run_and_charged_only_on_success(client, monkeypatch):
    from app import billing, llm
    from app import main as main_mod
    from app.models import FeedbackSummary

    # One redo, this run. The cap hangs off the dev tier, which is what the no-Clerk test identity
    # resolves to - patching the tier itself would swap the daily turn gate out from under the run.
    monkeypatch.setitem(billing.LIMITS["dev"], "redos", 1)

    iv = client.post("/api/interviews", json={"role": "Redo Cap"}).json()
    iid = iv["id"]
    client.post(f"/api/interviews/{iid}/start")
    client.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hello?"})

    # The FIRST review is included in the run: /finish auto-generates it and spends no redo, even when
    # the model comes back empty and the row is never written.
    monkeypatch.setattr(main_mod, "_backoff_sleep", _noop_sleep)
    monkeypatch.setattr(llm, "generate_feedback", _always_none)
    assert client.post(f"/api/interviews/{iid}/finish").status_code == 200
    assert client.get(f"/api/interviews/{iid}/feedback").status_code == 404

    async def _ok(history, dials=None, config=None, **_kw):
        return FeedbackSummary(scores={d: 7.0 for d in llm.FEEDBACK_DIMS}, verdict="Rebuilt", tips=["Keep going."])

    monkeypatch.setattr(llm, "generate_feedback", _ok)
    first = client.post(f"/api/interviews/{iid}/feedback/generate")
    assert first.status_code == 200 and first.json()["redos"] == 1

    # Spent: the cap is the run's, so the next rebuild is a wall, and NOT a reason to drop the review
    # that is already there. Free gets the upsell instead (402 against 409, same as the resume cap).
    over = client.post(f"/api/interviews/{iid}/feedback/generate")
    assert over.status_code == 409 and "review redos" in over.json()["detail"]
    assert client.get(f"/api/interviews/{iid}/feedback").json()["redos"] == 1

    async def _free(_user):
        return "free"

    monkeypatch.setattr(billing, "resolve_tier", _free)
    monkeypatch.setitem(billing.LIMITS["free"], "redos", 1)
    upsell = client.post(f"/api/interviews/{iid}/feedback/generate")
    assert upsell.status_code == 402 and "Pro raises" in upsell.json()["detail"]
    client.delete(f"/api/interviews/{iid}")


async def _always_none(history, dials=None, config=None, **_kw):
    return None


async def _noop_sleep(ms):
    return None  # neutralize the /finish auto-retry backoff so integration tests run instantly


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

    r = client.post(f"/api/interviews/{iid}/finish")
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

    r = client.post(f"/api/interviews/{iid}/finish")
    assert r.status_code == 200
    assert attempts["n"] == 2  # recovered on attempt 2; no 3rd attempt
    assert r.json()["status"] == "completed"
    fb = client.get(f"/api/interviews/{iid}/feedback")
    assert fb.status_code == 200
    assert fb.json()["verdict"] == "Auto recovered"
    client.delete(f"/api/interviews/{iid}")


# --- BYOK settings (app/byok.py, BYOK.md) ---


def test_byok_chat_turn_skips_the_tier_quota_but_is_still_metered(client, monkeypatch):
    # BYOK pays the provider, not us: the turn must pass with the TIER's credits exhausted. It IS
    # metered, and the BYOK ceiling still gates it - a self-asserted flag that waived both the cap and
    # the counter is a free ride (BYOK.md). The tier is read only to pick WHICH BYOK ceiling applies.
    from cryptography.fernet import Fernet

    from app import billing, byok, llm

    monkeypatch.setenv("BYOK_ENCRYPTION_KEY", Fernet.generate_key().decode())
    byok._fernet.cache_clear()
    seen = {"tiers": 0, "bumps": 0}

    async def _count_tier(*_args, **_kwargs):
        seen["tiers"] += 1
        return "free"

    async def _count_bump(_owner):
        seen["bumps"] += 1

    async def _fake_stream(_history, config):
        assert config.byok is True  # the owner's target, not the system one
        yield "Sure - "

    monkeypatch.setattr(billing, "resolve_tier", _count_tier)
    monkeypatch.setattr(billing, "bump_chat_turn", _count_bump)
    monkeypatch.setattr(llm, "stream_chat", _fake_stream)
    try:
        client.put("/api/settings/llm", json={"base_url": "https://api.example.com/v1", "model": "m", "api_key": "sk-unit-test-key-abcd"})
        iid = client.post("/api/interviews", json={"role": "BYOK quota"}).json()["id"]
        client.post(f"/api/interviews/{iid}/start")
        r = client.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
        assert r.status_code == 200
        assert "Sure - " in r.text
        assert (seen["tiers"], seen["bumps"]) == (1, 1)  # tier read for the ceiling, turn metered
        assert client.get("/api/usage").json()["byok"] is True
        client.delete(f"/api/interviews/{iid}")
    finally:
        client.delete("/api/settings/llm")
        byok._fernet.cache_clear()


def test_byok_turns_stop_at_the_byok_ceiling(client, monkeypatch):
    # The ceiling is the half of the waiver that is NOT negotiable, and it is the same number /usage
    # reports, so the counter in the UI and the 402 can never disagree. This client is the dev
    # identity, so the ceiling under test is premium's BYOK one.
    from cryptography.fernet import Fernet

    from app import billing, byok

    monkeypatch.setenv("BYOK_ENCRYPTION_KEY", Fernet.generate_key().decode())
    # LIMITS is built from the env at import, so the ceiling under test is patched where it is read.
    monkeypatch.setitem(billing.LIMITS["dev"], "byok_turns", 3)
    byok._fernet.cache_clear()

    async def _used(_owner):
        return 3  # exactly at the ceiling

    async def _refuse_to_meter(_owner):
        raise AssertionError("a refused turn must not spend a credit")

    monkeypatch.setattr(billing, "chat_turns_used", _used)
    monkeypatch.setattr(billing, "bump_chat_turn", _refuse_to_meter)
    try:
        client.put("/api/settings/llm", json={"base_url": "https://api.example.com/v1", "model": "m", "api_key": "sk-unit-test-key-abcd"})
        usage = client.get("/api/usage").json()
        assert (usage["byok"], usage["chat_turns_per_day_dev"], usage["chat_turns_remaining_today"]) == (True, 3, 0)
        iid = client.post("/api/interviews", json={"role": "BYOK ceiling"}).json()["id"]
        client.post(f"/api/interviews/{iid}/start")
        r = client.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "hi"})
        assert r.status_code == 402
        assert "your own provider" in r.json()["detail"]
        client.delete(f"/api/interviews/{iid}")
    finally:
        client.delete("/api/settings/llm")
        byok._fernet.cache_clear()


def test_byok_refuses_this_deployments_provider_and_its_network(client, monkeypatch):
    # Two rules, both about THIS deployment: its own provider while that needs no key (a junk key
    # plus the higher BYOK ceiling = a free ride on our own GPU), and anything off the public
    # internet (the backend makes the call, so a private base_url is a probe into our network).
    # Everyone else's provider stays available - see the last phase.
    from cryptography.fernet import Fernet

    from app import byok, llm

    monkeypatch.setenv("BYOK_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setattr(llm, "SYSTEM_CONFIG", llm.LLMConfig(base_url="http://100.64.2.2:8080/v1", model="qwen", api_key=""))
    byok._fernet.cache_clear()
    try:
        refused = (
            "http://100.64.2.2:8080/v1",  # the system provider, as written
            "http://100.64.2.2:8080/other",  # ...any path on that listener
            "https://100.64.2.2:8080",  # ...in its https spelling
            "http://[::ffff:100.64.2.2]:8080/v1",  # ...and as a mapped IPv6 literal
            "http://100.64.2.9:8080/v1",  # the next box on the tailnet
            "http://10.1.2.3:11434/v1",  # the LAN, and the k8s service range
            "http://192.168.1.10:11434/v1",  # a LAN box (someone's Ollama)
            "http://127.0.0.1:11434/v1",  # the pod itself
            "http://169.254.169.254/v1",  # node metadata
        )
        for url in refused:
            assert client.put("/api/settings/llm", json={"base_url": url, "model": "m", "api_key": ""}).status_code == 422, url

        # Rule 1 on its own: a KEYLESS system provider on a public host is still ours to defend.
        monkeypatch.setattr(llm, "SYSTEM_CONFIG", llm.LLMConfig(base_url="http://9.9.9.9:8080/v1", model="qwen", api_key=""))
        assert client.put("/api/settings/llm", json={"base_url": "http://9.9.9.9:8080/v1", "model": "qwen", "api_key": ""}).status_code == 422

        # ...and the moment it needs a key (the documented deepseek swap) the same origin is fine:
        # an owner bringing their OWN key for the provider we happen to pay is not abusing anything.
        monkeypatch.setattr(llm, "SYSTEM_CONFIG", llm.LLMConfig(base_url="https://9.9.9.9/v1", model="managed", api_key="sk-deployment-key"))
        assert client.put("/api/settings/llm", json={"base_url": "https://9.9.9.9/v1", "model": "managed", "api_key": "sk-own-key-1234"}).status_code == 200
        assert client.put("/api/settings/llm", json={"base_url": "http://93.184.216.34:1234/v1", "model": "m", "api_key": "sk-own-key-1234"}).status_code == 200
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


@pytest.mark.parametrize("cls", rating.FAIL_CLASSES)
def test_hardcore_ends_the_run_on_the_first_failing_answer(client, monkeypatch, cls):
    # Driven off FAIL_CLASSES, so the fail set is the coverage and the two cannot drift: vague fails a
    # hardcore run exactly like wrong does. Everything else about the run is the real code path.
    from app import llm

    note = "Named no trade-off: state what you gave up."

    async def _judge(_question, _answer, _config, _turn=1):
        return rating.Move(cls, note)

    monkeypatch.setattr(llm, "judge_answer", _judge)
    c = client
    iv = c.post("/api/interviews", json={"role": "Hardcore Judge", "hardcore": True}).json()
    assert iv["hardcore"] is True
    iid = iv["id"]
    c.post(f"/api/interviews/{iid}/start")

    body = c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "uh, I think we just retried it"}).text
    assert llm.FAIL_MESSAGE.format(cls=cls.upper()) in body  # shouted, in caps, in the transcript
    assert f'"failed": {{"turn": 1, "class": "{cls}"}}' in body  # ... and the client is told why it ended
    # The run is over for the API too, not just for the composer.
    assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "one more"}).status_code == 409
    # The failing answer keeps its class, which is what the review points at, and the note it was
    # judged with: written by that same live call rather than a second pass after the fact.
    msgs = c.get(f"/api/interviews/{iid}/messages").json()
    assert [(m["move_class"], m["comment"]) for m in msgs if m["role"] == "user"] == [(cls, note)]
    # The shout is a stored turn now, so a reloaded transcript still ends on it (stub mode writes the
    # canned line; the real path asks the model).
    assert msgs[-1]["role"] == "assistant" and msgs[-1]["content"] == llm.FAIL_MESSAGE.format(cls=cls.upper())

    assert c.post(f"/api/interviews/{iid}/finish").status_code == 200
    fb = c.get(f"/api/interviews/{iid}/feedback").json()
    assert (fb["failed_turn"], fb["failed_class"]) == (1, cls)
    assert (fb["grade"], fb["decision"]) == ("F", "reject")  # a failure overrides the average
    assert fb["verdict"].isupper()  # the stub's shout; the real path prompts the model for caps
    row = next(i for i in c.get("/api/interviews").json() if i["id"] == iid)
    assert (row["failed_turn"], row["failed_class"], row["grade"]) == (1, cls, "F")
    c.delete(f"/api/interviews/{iid}")


def test_hardcore_shout_reaches_the_client_even_if_the_store_fails(client, monkeypatch):
    # Storing the callout is best-effort: the mode's promise is that the candidate is told, so a DB
    # hiccup at that instant must cost the stored line, not the stream.
    from app import llm, main, rating

    async def _judge(_question, _answer, _config, _turn=1):
        return rating.Move("mistake", "Named no trade-off: state what you gave up.")

    real = main.fetchrow

    async def _flaky(sql, *args):
        if "'assistant'" in sql:
            raise RuntimeError("db down")
        return await real(sql, *args)

    monkeypatch.setattr(llm, "judge_answer", _judge)
    monkeypatch.setattr(main, "fetchrow", _flaky)
    c = client
    iid = c.post("/api/interviews", json={"role": "Hardcore Store", "hardcore": True}).json()["id"]
    c.post(f"/api/interviews/{iid}/start")

    body = c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "uh, we retried it"}).text
    assert llm.FAIL_MESSAGE.format(cls="MISTAKE") in body  # still delivered
    assert '"class": "mistake"' in body  # ... and the client is still told why the run ended
    # The answer landed, the shout did not: that is the trade, and the review banner still reports it.
    assert [m["role"] for m in c.get(f"/api/interviews/{iid}/messages").json()] == ["user"]
    c.delete(f"/api/interviews/{iid}")


def test_hardcore_survives_a_judge_that_comes_back_empty(client, monkeypatch):
    # A judge outage must not fail a candidate by default: no verdict, no failure, run continues.
    from app import llm

    async def _judge(_question, _answer, _config, _turn=1):
        return None

    monkeypatch.setattr(llm, "judge_answer", _judge)
    c = client
    iid = c.post("/api/interviews", json={"role": "Hardcore Outage", "hardcore": True}).json()["id"]
    c.post(f"/api/interviews/{iid}/start")
    assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "something the judge could not read"}).status_code == 200
    assert c.post(f"/api/interviews/{iid}/chat/stream", json={"interview_id": iid, "content": "the next turn still runs"}).status_code == 200
    row = next(i for i in c.get("/api/interviews").json() if i["id"] == iid)
    assert (row["failed_turn"], row["failed_class"]) == (None, None)
    c.delete(f"/api/interviews/{iid}")


def test_analytics_aggregates_the_whole_history(client):
    # One aggregate replaces a per-run fan-out, so it must agree with the rows it summarizes:
    # move classes summed over every annotated turn, accuracy averaged over the SCORED runs only
    # (an unscored run is absence, not 0%), and dial breakdowns bucketed from the create knobs.
    import asyncio

    import asyncpg

    c = client

    async def seed(rows):
        conn = await asyncpg.connect(DB_URL)
        try:
            ids = []
            for role, level, hardcore, status, accuracy, decision, classes in rows:
                iid = await conn.fetchval(
                    "INSERT INTO interviews (owner_id, role, level, hardcore, status, created_at) VALUES ($1, $2, $3, $4, $5, now() - make_interval(mins => $6)) RETURNING id::text",
                    "dev-user",
                    role,
                    level,
                    hardcore,
                    status,
                    len(ids),
                )
                for cls in classes:
                    await conn.execute(
                        "INSERT INTO messages (interview_id, role, content, move_class) VALUES ($1::uuid, 'user', 'a', $2)",
                        iid,
                        cls,
                    )
                if status == "completed" and accuracy is not None:
                    await conn.execute(
                        "INSERT INTO feedback (interview_id, verdict, scores, accuracy, decision) VALUES ($1::uuid, 'v', '{\"clarity\": 4}'::jsonb, $2, $3)",
                        iid,
                        accuracy,
                        decision,
                    )
                ids.append(iid)
            return ids
        finally:
            await conn.close()

    ids = asyncio.run(
        seed(
            [
                # role, level, hardcore, status, accuracy, decision, left-to-right move classes
                ("An senior", "senior", False, "completed", 90, "hire", ["brilliant", "great"]),
                ("An junior", "junior", False, "completed", 30, "reject", ["mistake", "blunder"]),
                ("An hardcore", "junior", True, "completed", 50, None, ["good", "inaccuracy"]),
                ("An unscored", "mid", False, "completed", None, None, []),
                ("An running", "mid", False, "in_progress", None, None, ["good"]),
            ]
        )
    )
    try:
        r = c.get("/api/stats/analytics")
        assert r.status_code == 200
        d = r.json()

        seeded = [run for run in d["runs"] if run["id"] in ids]
        assert {run["id"] for run in seeded} == set(ids)  # archived/unfinished runs are still listed
        by_id = {run["id"]: run for run in seeded}
        assert (by_id[ids[0]]["accuracy"], by_id[ids[0]]["grade"], by_id[ids[0]]["decision"]) == (90, "S", "hire")
        # The run log mixes finished and unfinished runs, so the row must say which it is; the page
        # renders incomplete rows differently rather than letting them read as a scored zero.
        assert (by_id[ids[0]]["status"], by_id[ids[4]]["status"]) == ("completed", "in_progress")
        # An ungraded run reports no dimensions and no grade, not a zeroed review.
        assert (by_id[ids[3]]["scores"], by_id[ids[3]]["grade"]) == ({}, None)
        assert by_id[ids[4]]["turns"] == 1 and by_id[ids[4]]["moves"] == {"good": 1}

        # Move distribution: every annotated turn, including the in-progress run's.
        moves = d["move_classes"]
        assert set(moves) == {"brilliant", "great", "good", "book", "inaccuracy", "mistake", "blunder"}
        assert (moves["brilliant"], moves["great"], moves["good"], moves["book"]) == (1, 1, 2, 0)
        assert (moves["inaccuracy"], moves["mistake"], moves["blunder"]) == (1, 1, 1)
        assert sum(moves.values()) == 7
        assert d["hardcore_failures"] >= 0 and isinstance(d["streak_days"], int)

        # Dials bucket COMPLETED runs only, and the level group is in the vocabulary's order.
        levels_group = {row["key"]: row for row in d["dials"]["level"]}
        assert levels_group["senior"]["runs"] == 1
        assert levels_group["senior"]["avg_accuracy"] == 90.0
        assert levels_group["junior"]["runs"] == 2
        assert levels_group["junior"]["rated"] == 2
        assert levels_group["junior"]["avg_accuracy"] == 40.0  # mean(30, 50), not diluted by the unscored run
        # `mid` has one completed-but-unscored run: it appears, with no accuracy to report.
        assert levels_group["mid"]["runs"] == 1 and levels_group["mid"]["avg_accuracy"] is None
        assert levels_group["mid"]["hire_rate"] is None  # nothing decided, not a 0% rejection rate

        hardcore_group = {row["key"]: row for row in d["dials"]["hardcore"]}
        assert hardcore_group["hardcore"]["runs"] == 1 and hardcore_group["standard"]["runs"] == 3
        # Hire rate is denominated on DECIDED runs: 1 of 2 here, unaffected by the undecided ones.
        assert levels_group["junior"]["hire_rate"] == 0 and levels_group["senior"]["hire_rate"] == 100

        # Activity: the weekly buckets the page charts, over the recent seeded runs. Without this the
        # field could silently stay empty and the panel would render its "no runs" state forever.
        assert d["activity"], "activity must be populated"
        assert all({"week", "started", "completed"} <= set(a) for a in d["activity"])
        assert sum(a["started"] for a in d["activity"]) >= 5
        assert sum(a["completed"] for a in d["activity"]) >= 4
        assert d["total_turns"] >= 5
    finally:
        for iid in ids:
            c.delete(f"/api/interviews/{iid}")


def test_analytics_is_owner_scoped(client):
    import asyncio

    import asyncpg

    async def seed_foreign():
        conn = await asyncpg.connect(DB_URL)
        try:
            iid = await conn.fetchval("INSERT INTO interviews (owner_id, role, status) VALUES ('someone-else', 'Not yours', 'completed') RETURNING id::text")
            await conn.execute("INSERT INTO messages (interview_id, role, content, move_class) VALUES ($1::uuid, 'user', 'a', 'brilliant')", iid)
            await conn.execute("INSERT INTO feedback (interview_id, verdict, scores, accuracy) VALUES ($1::uuid, 'v', '{\"clarity\": 10}'::jsonb, 100)", iid)
            return iid
        finally:
            await conn.close()

    async def cleanup(iid):
        conn = await asyncpg.connect(DB_URL)
        try:
            await conn.execute("DELETE FROM interviews WHERE id = $1::uuid", iid)
        finally:
            await conn.close()

    foreign = asyncio.run(seed_foreign())
    try:
        d = client.get("/api/stats/analytics").json()
        assert all(run["id"] != foreign for run in d["runs"])
        assert all(v == 0 for v in d["move_classes"].values())
        assert all(not group for group in d["dials"].values())
    finally:
        asyncio.run(cleanup(foreign))


def test_analytics_streak_counts_consecutive_days(client):
    # The streak is the one piece of non-obvious arithmetic in the analytics aggregate (rank vs day
    # age), so pin its edges: consecutive days, a broken run, and the "practised yesterday, not yet
    # today" case that must NOT read as zero.
    import asyncio

    import asyncpg

    from app.main import ANALYTICS_STREAK_SQL

    async def streak_for(offsets):
        """Streak for an owner whose only activity is `offsets` days ago (one run per offset)."""
        conn = await asyncpg.connect(DB_URL)
        try:
            await conn.execute("DELETE FROM interviews WHERE owner_id = 'streak-probe-owner'")
            for off in offsets:
                await conn.execute(
                    "INSERT INTO interviews (owner_id, role, status, created_at) VALUES ('streak-probe-owner', 'Streak Probe', 'pending', CURRENT_DATE - make_interval(days => $1))",
                    off,
                )
            return await conn.fetchval(ANALYTICS_STREAK_SQL, "streak-probe-owner")
        finally:
            await conn.execute("DELETE FROM interviews WHERE owner_id = 'streak-probe-owner'")
            await conn.close()

    assert asyncio.run(streak_for([0, 1, 2])) == 3  # today, yesterday, the day before
    assert asyncio.run(streak_for([1, 2, 3])) == 3  # still alive: practised yesterday, not yet today
    assert asyncio.run(streak_for([0, 3])) == 1  # today only; the older day starts a separate run
    assert asyncio.run(streak_for([5])) == 0  # a week idle is over
    assert asyncio.run(streak_for([])) == 0  # never practised
