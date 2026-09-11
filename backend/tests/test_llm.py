import json

import respx
from httpx import Response

from app import llm
from app.models import ChatMessage, FeedbackSummary


def test_system_prompt_any_level_and_topic():
    p = llm.system_prompt("Software Engineer", "any", "System Design")
    assert "Software Engineer" in p
    assert "System Design" in p
    assert "one question at a time" in p


def test_system_prompt_calibrates_to_explicit_level():
    p = llm.system_prompt("Software Engineer", "mid", "")
    assert "mid-level experience band" in p


def test_system_prompt_walks_the_arc_by_interviewer_turn_count():
    # Regression: the arc used to be one prose sentence that a small model ignored, so real
    # transcripts skipped straight from background to technical. Each turn now names its phase.
    opener = llm.system_prompt("Software Engineer", "mid", "", asked=0)
    assert "Current phase: OPENING" in opener

    for asked in (1, 2):
        behavioural = llm.system_prompt("Software Engineer", "mid", "", asked=asked)
        assert "Current phase: BEHAVIOURAL" in behavioural
        assert "Do not ask technical" in behavioural or "no technical" in behavioural

    technical = llm.system_prompt("Software Engineer", "mid", "", asked=3)
    assert "Current phase: TECHNICAL" in technical
    assert "Current phase: TECHNICAL" in llm.system_prompt("Software Engineer", "mid", "", asked=9)


def test_stub_mode_active_without_base_url():
    assert llm.STUB_MODE is True


async def test_stub_stream_echoes_user():
    msgs = [ChatMessage(role="user", content="Tell me about yourself.")]
    out = "".join([d async for d in llm.stream_chat(msgs)])
    assert "Tell me about yourself." in out


def test_max_tokens_config_defaults():
    # Bounds runaway local thinking models (Qwen emits long reasoning).
    assert llm.LLM_MAX_TOKENS == 512
    assert llm.LLM_MAX_FEEDBACK_TOKENS == 1024


def test_chat_extras_disable_thinking_by_default():
    # Non-thinking models ignore chat_template_kwargs, so this is safe by default.
    assert llm.LLM_DISABLE_THINKING is True
    assert llm._chat_extras() == {"chat_template_kwargs": {"enable_thinking": False}}


async def test_stub_feedback_is_deterministic():
    f: FeedbackSummary = await llm.generate_feedback([ChatMessage(role="user", content="hi")])
    assert set(f.scores.keys()) == {"clarity", "relevance", "structure", "confidence"}
    assert f.verdict
    assert isinstance(f.tips, list) and len(f.tips) >= 1


def test_extract_json_object_handles_prose_wrap():
    text = 'Here is your feedback:\n```json\n{"scores": {"clarity": 8}, "verdict": "Nice", "tips": ["a"]}\n```\nGood job!'
    obj = llm._extract_json_object(text)
    assert obj["verdict"] == "Nice"
    assert obj["scores"]["clarity"] == 8
    assert obj["tips"] == ["a"]


def test_extract_json_object_no_json_returns_empty():
    assert llm._extract_json_object("no json here") == {}


def test_valid_scores_rejects_partial_and_accepts_full(monkeypatch):
    assert llm._valid_scores({}) is None
    assert llm._valid_scores({"clarity": 8}) is None  # missing dims
    assert llm._valid_scores({d: "hi" for d in llm.FEEDBACK_DIMS}) is None
    assert llm._valid_scores({d: None for d in llm.FEEDBACK_DIMS}) is None
    ok = llm._valid_scores({d: 6 for d in llm.FEEDBACK_DIMS})
    assert ok == {d: 6.0 for d in llm.FEEDBACK_DIMS}


def test_valid_scores_coerces_range_and_string_drift():
    # Regression: the wall-clock failure was the model scoring 0 on a transcript where the
    # candidate said nothing, which the validator used to reject outright (503).
    floored = llm._valid_scores({d: 0 for d in llm.FEEDBACK_DIMS})
    assert floored == {d: 1.0 for d in llm.FEEDBACK_DIMS}
    assert llm._valid_scores({d: 11 for d in llm.FEEDBACK_DIMS}) == {d: 10.0 for d in llm.FEEDBACK_DIMS}
    assert llm._valid_scores({"clarity": "7", "relevance": "7/10", "structure": 7.5, "confidence": 7}) == {
        "clarity": 7.0,
        "relevance": 7.0,
        "structure": 7.5,
        "confidence": 7.0,
    }
    assert llm._valid_scores({"clarity": [7], "relevance": {"score": 7}, "structure": 7, "confidence": 7}) is None


async def test_generate_feedback_real_grader_and_formatter_path(monkeypatch):
    monkeypatch.setattr(llm, "STUB_MODE", False)
    caller = {"model": None, "msgs": None, "json": None, "schema": None}

    async def _completion(system, user_text, *, model, base_url, max_tokens, json_output=False, json_schema=None, **kw):
        caller["model"] = model
        caller["msgs"] = [system, user_text]
        caller["json"] = json_output
        caller["schema"] = json_schema
        return "prose notes" if not json_output else '{"scores": {"clarity": 7, "relevance": 8, "structure": 6, "confidence": 5}, "verdict": "Solid.", "tips": ["Do X", "Do Y"]}'

    monkeypatch.setattr(llm, "_completion", _completion)
    out = await llm.generate_feedback([ChatMessage(role="user", content="hi")])
    assert out is not None
    assert all(1 <= out.scores[d] <= 10 for d in llm.FEEDBACK_DIMS)
    assert caller["json"] is True  # formatter hop requested JSON mode
    assert caller["schema"] is llm.FEEDBACK_JSON_SCHEMA  # ... under the grammar schema when supported


async def test_generate_feedback_recovers_from_out_of_range_scores(monkeypatch):
    # Regression for the reported 503: verdict present, scores all 0 -> still writable.
    monkeypatch.setattr(llm, "STUB_MODE", False)
    attempts = {"n": 0}

    async def _completion(system, user_text, *, json_output=False, **kw):
        if json_output:
            attempts["n"] += 1
            return '{"scores": {"clarity": 0, "relevance": 0, "structure": 0, "confidence": 0}, "verdict": "Nothing usable was said.", "tips": ["Answer the question", "Share your background"]}'
        return "prose notes"

    monkeypatch.setattr(llm, "_completion", _completion)
    out = await llm.generate_feedback([ChatMessage(role="user", content="hello")])
    assert attempts["n"] == 1  # no wasted retry
    assert out is not None and out.scores == {d: 1.0 for d in llm.FEEDBACK_DIMS}


async def test_generate_feedback_formatter_retries_on_bad_schema(monkeypatch):
    monkeypatch.setattr(llm, "STUB_MODE", False)
    attempts = {"n": 0}

    async def _completion(system, user_text, *, json_output=False, **kw):
        if json_output:
            attempts["n"] += 1
            if attempts["n"] == 1:
                return '{"verdict": "no scores"}'
            return '{"scores": {"clarity": 9, "relevance": 9, "structure": 9, "confidence": 9}, "verdict": "Great.", "tips": ["A"]}'
        return "prose notes"

    monkeypatch.setattr(llm, "_completion", _completion)
    out = await llm.generate_feedback([ChatMessage(role="user", content="hi")])
    assert attempts["n"] == 2  # schema mismatch triggered the formatter retry
    assert out is not None and out.verdict == "Great."


async def test_generate_feedback_returns_none_when_formatter_never_valid(monkeypatch):
    # Every formatter attempt (incl. retry) unusable -> None, so the caller writes NO
    # feedback rather than a fabricated 6-average.
    monkeypatch.setattr(llm, "STUB_MODE", False)
    attempts = {"n": 0}

    async def _completion(system, user_text, *, json_output=False, **kw):
        if json_output:
            attempts["n"] += 1
            return '{"verdict": "nope"}'  # always schema-mismatched
        return "prose notes"

    monkeypatch.setattr(llm, "_completion", _completion)
    out = await llm.generate_feedback([ChatMessage(role="user", content="hi")])
    assert attempts["n"] == 2  # formatter exhausted its one retry
    assert out is None  # no fabricated feedback


async def test_generate_feedback_returns_none_when_grader_fails(monkeypatch):
    # Grader retry never yields prose -> stop; the formatter JSON hop is never attempted.
    monkeypatch.setattr(llm, "STUB_MODE", False)
    grader_attempts = {"n": 0}
    format_attempts = {"n": 0}

    async def _completion(system, user_text, *, json_output=False, **kw):
        if json_output:
            format_attempts["n"] += 1
            return None
        grader_attempts["n"] += 1
        return None

    monkeypatch.setattr(llm, "_completion", _completion)
    out = await llm.generate_feedback([ChatMessage(role="user", content="hi")])
    assert grader_attempts["n"] == 2  # grader retried once
    assert format_attempts["n"] == 0  # formatter never invoked
    assert out is None


async def test_completion_is_greedy_and_downgrades_json_schema_to_json_object():
    with respx.mock(base_url="http://llm.test") as mock:
        route = mock.post("/chat/completions")
        route.side_effect = [
            Response(400, json={"error": {"message": "response_format json_schema is not supported"}}),
            Response(200, json={"choices": [{"message": {"content": '{"scores": {}}'}}]}),
        ]
        out = await llm._completion(
            "sys",
            "notes",
            model="qwen",
            base_url="http://llm.test",
            max_tokens=64,
            json_output=True,
            json_schema=llm.FEEDBACK_JSON_SCHEMA,
        )
    assert out == '{"scores": {}}'
    assert len(route.calls) == 2  # schema attempt, then the json_object fallback
    first = json.loads(route.calls[0].request.content)
    assert first["response_format"]["type"] == "json_schema"
    assert first["response_format"]["json_schema"]["schema"] == llm.FEEDBACK_JSON_SCHEMA
    assert first["temperature"] == 0.0  # rubric edges are not left to a sampler
    assert json.loads(route.calls[1].request.content)["response_format"] == {"type": "json_object"}


async def test_completion_does_not_retry_repeated_server_errors():
    with respx.mock(base_url="http://llm.test") as mock:
        route = mock.post("/chat/completions")
        route.side_effect = [Response(500, json={"error": "boom"})]
        out = await llm._completion("sys", "notes", model="qwen", base_url="http://llm.test", max_tokens=64, json_schema=llm.FEEDBACK_JSON_SCHEMA)
    assert out is None
    assert len(route.calls) == 1  # only the json-schema capability 400/404/422 is downgraded
