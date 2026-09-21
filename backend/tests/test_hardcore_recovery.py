"""Hardcore reconciliation: a run whose live judge missed a turn must still be judged at review time.

Regression for a silent pass. `judge_answer` returns None when the model will not produce a verdict,
so that turn stores `move_class` NULL; a hardcore run skips the moves pass (`annotate=not hardcore`);
and the review then banded the run off those NULLs - no failure recorded, no F, nothing to explain.
A hardcore run that was never fully judged read as an ordinary pass.

The same hole-filling pass covers the note column: a run annotated before migration 0016 holds classes
and no notes, and a review of bare badges is the other silent pass this guards.

No DB and no model: the two hops that need either are the ones under test's control.
"""

from app import llm, main, rating

INTERVIEW = {**llm.Dials().model_dump(), "hardcore": True, "failed_turn": None, "failed_class": None, "resume_text": None}
SUMMARY = llm.FeedbackSummary(scores={}, verdict="ok", tips=["a", "b"], decision="hire", certainty=80, moves={})


def _rows(classes: list[str | None], comments: list[str | None] | None = None) -> list[dict]:
    """Stored transcript: one candidate turn per entry, each followed by the interviewer's reply.

    `comments` is the note column. A run annotated before migration 0016 holds classes and no notes,
    which is the second case this module covers."""
    notes = comments if comments is not None else [f"note {n}" for n in range(1, len(classes) + 1)]
    rows: list[dict] = []
    for n, (cls, note) in enumerate(zip(classes, notes, strict=True), 1):
        rows.append({"id": f"u{n}", "role": "user", "content": f"answer {n}", "move_class": cls, "comment": note})
        rows.append({"id": f"a{n}", "role": "assistant", "content": f"question {n}", "move_class": None, "comment": None})
    return rows


async def _run(monkeypatch, classes, backfill=None, comments=None):
    """Drive the real `_generate_and_persist_feedback` with the DB and the model faked out."""
    rows = _rows(classes, comments)
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
        return [moves[n].cls for n in range(1, len(candidate_ids) + 1) if n in moves]

    async def fake_classify(history, config):
        seen["classify"] += 1
        return {n: rating.Move(cls, f"note {n}") for n, cls in (backfill or {}).items()}

    async def fake_generate_feedback(history, dials, config, failure=None, annotate=True, resume=""):
        seen["failure_arg"] = failure
        return SUMMARY

    async def fake_upsert(interview_id, scores, verdict, tips, decision, certainty, accuracy):
        seen["accuracy"] = accuracy

    async def fake_row(interview_id):
        return {"id": interview_id}

    monkeypatch.setattr(main, "fetch", fake_fetch)
    monkeypatch.setattr(main, "fetchrow", fake_fetchrow)
    monkeypatch.setattr(main, "_persist_moves", fake_persist)
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
    assert seen["moves"] == {1: ("great", "note 1"), 2: ("good", "note 2"), 3: ("blunder", "note 3")}, seen["moves"]
    assert seen["failed"] == (3, "blunder"), "the backfilled failure must be recorded, or the review shows an F with nothing"
    assert seen["accuracy"] == 62  # great 1.0 + good 0.85 + blunder 0.0, mean 61.67 -> half-up 62
    assert seen["failure_arg"] is None, "the failure is discovered AFTER the model call, so it cannot be handed to it"


async def test_hardcore_backfills_notes_for_a_run_graded_before_notes_existed(monkeypatch):
    # A hardcore run completed before migration 0016 holds classes and no notes. Nothing needs
    # re-judging, so the annotator is asked for notes only and its CLASSES are dropped: the verdict the
    # candidate was shown wins, and a bare badge run does not stay bare.
    seen = await _run(monkeypatch, ["great", "good"], comments=[None, None], backfill={1: "book", 2: "mistake"})

    assert seen["classify"] == 1
    assert seen["moves"] == {1: ("great", "note 1"), 2: ("good", "note 2")}, seen["moves"]
    assert seen["failed"] is None, "the annotator's 'mistake' is a note source, not a verdict to record"
    assert seen["accuracy"] == 93


async def test_hardcore_judged_cleanly_costs_no_extra_call(monkeypatch):
    seen = await _run(monkeypatch, ["great", "good"])
    assert seen["classify"] == 0, "a fully judged hardcore run must not spend a call on backfill"
    assert seen["failed"] is None
    assert seen["accuracy"] == 93  # great 1.0 + good 0.85 -> 92.5, half-up 93
