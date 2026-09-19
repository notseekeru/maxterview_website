"""Hardcore reconciliation: a run whose live judge missed a turn must still be judged at review time.

Regression for a silent pass. `judge_answer` returns None when the model will not produce a verdict,
so that turn stores `move_class` NULL; a hardcore run skips the moves pass (`annotate=not hardcore`);
and the review then banded the run off those NULLs - no failure recorded, no F, nothing to explain.
A hardcore run that was never fully judged read as an ordinary pass.

No DB and no model: the two hops that need either are the ones under test's control.
"""

from app import llm, main

INTERVIEW = {**llm.Dials().model_dump(), "hardcore": True, "failed_turn": None, "failed_class": None, "resume_text": None}
SUMMARY = llm.FeedbackSummary(scores={}, verdict="ok", tips=["a", "b"], decision="hire", certainty=80, moves={})


def _rows(classes: list[str | None]) -> list[dict]:
    """Stored transcript: one candidate turn per entry, each followed by the interviewer's reply."""
    rows: list[dict] = []
    for n, cls in enumerate(classes, 1):
        rows.append({"id": f"u{n}", "role": "user", "content": f"answer {n}", "move_class": cls})
        rows.append({"id": f"a{n}", "role": "assistant", "content": f"question {n}", "move_class": None})
    return rows


async def _run(monkeypatch, classes, backfill=None):
    """Drive the real `_generate_and_persist_feedback` with the DB and the model faked out."""
    rows = _rows(classes)
    seen: dict = {"classify": 0, "moves": None, "failed": None, "accuracy": None, "failure_arg": "unset"}

    async def fake_fetch(sql, *args):
        return rows

    async def fake_fetchrow(sql, *args):
        if "UPDATE interviews SET failed_turn" in sql:
            seen["failed"] = args[1:]
            return None
        return INTERVIEW

    async def fake_persist(interview_id, candidate_ids, moves):
        seen["moves"] = moves
        return [moves.get(n) for n in range(1, len(candidate_ids) + 1)]

    async def fake_classify(history, config):
        seen["classify"] += 1
        return dict(backfill or {})

    async def fake_generate_feedback(history, dials, config, failure=None, annotate=True, resume=""):
        seen["failure_arg"] = failure
        return SUMMARY

    async def fake_upsert(interview_id, scores, verdict, tips, decision, certainty, accuracy):
        seen["accuracy"] = accuracy

    async def fake_row(interview_id):
        return {"id": interview_id}

    monkeypatch.setattr(main, "fetch", fake_fetch)
    monkeypatch.setattr(main, "fetchrow", fake_fetchrow)
    monkeypatch.setattr(main, "_persist_move_classes", fake_persist)
    monkeypatch.setattr(main, "_upsert_feedback", fake_upsert)
    monkeypatch.setattr(main, "_feedback_row", fake_row)
    monkeypatch.setattr(llm, "generate_feedback", fake_generate_feedback)
    monkeypatch.setattr(llm, "classify_turns", fake_classify)

    await main._generate_and_persist_feedback("iid", llm.LLMConfig(base_url="", model=""))
    return seen


async def test_hardcore_backfills_the_turn_the_live_judge_missed(monkeypatch):
    # Turn 1 was judged live ('great'), turns 2 and 3 came back None. The classifier disagrees with the
    # stored verdict on turn 1 on purpose: the verdict the candidate was already shown must win.
    seen = await _run(monkeypatch, ["great", None, None], backfill={1: "book", 2: "good", 3: "blunder"})

    assert seen["classify"] == 1, "a hardcore run with a NULL class must re-read the transcript"
    assert seen["moves"] == {1: "great", 2: "good", 3: "blunder"}, seen["moves"]
    assert seen["failed"] == (3, "blunder"), "the backfilled failure must be recorded, or the review shows an F with nothing"
    assert seen["accuracy"] == 62  # great 1.0 + good 0.85 + blunder 0.0, mean 61.67 -> half-up 62
    assert seen["failure_arg"] is None, "the failure is discovered AFTER the model call, so it cannot be handed to it"


async def test_hardcore_judged_cleanly_costs_no_extra_call(monkeypatch):
    seen = await _run(monkeypatch, ["great", "good"])
    assert seen["classify"] == 0, "a fully judged hardcore run must not spend a call on backfill"
    assert seen["failed"] is None
    assert seen["accuracy"] == 93  # great 1.0 + good 0.85 -> 92.5, half-up 93
