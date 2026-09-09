from app import llm
from app.models import ChatMessage, FeedbackSummary


def test_system_prompt_includes_role_and_topic():
    p = llm.system_prompt("Software Engineer", "System Design")
    assert "Software Engineer" in p
    assert "System Design" in p
    assert "one question at a time" in p


def test_stub_mode_active_without_base_url():
    # conftest doesn't set LLM_BASE_URL -> STUB_MODE is on (deterministic, no network).
    assert llm.STUB_MODE is True


async def test_stub_stream_echoes_user():
    msgs = [ChatMessage(role="user", content="Tell me about yourself.")]
    out = "".join([d async for d in llm.stream_chat(msgs)])
    assert "Tell me about yourself." in out


def test_max_tokens_config_defaults():
    # Bounds runaway local thinking models; defaults fixed unless env-overridden.
    assert llm.LLM_MAX_TOKENS == 512
    assert llm.LLM_MAX_FEEDBACK_TOKENS == 1024


def test_chat_extras_disable_thinking_by_default():
    # Qwen-family models emit a long reasoning pass that can swallow max_tokens;
    # disable thinking by default. Non-thinking models ignore chat_template_kwargs.
    assert llm.LLM_DISABLE_THINKING is True
    assert llm._chat_extras() == {"chat_template_kwargs": {"enable_thinking": False}}


async def test_stub_feedback_is_deterministic():
    f: FeedbackSummary = await llm.generate_feedback([ChatMessage(role="user", content="hi")])
    assert set(f.scores.keys()) == {"clarity", "relevance", "structure", "confidence"}
    assert f.verdict
    assert isinstance(f.tips, list) and len(f.tips) >= 1


def test_extract_json_object_handles_prose_wrap():
    # llama.cpp-style: prose around the JSON object.
    text = 'Here is your feedback:\n```json\n{"scores": {"clarity": 8}, "verdict": "Nice", "tips": ["a"]}\n```\nGood job!'
    obj = llm._extract_json_object(text)
    assert obj["verdict"] == "Nice"
    assert obj["scores"]["clarity"] == 8
    assert obj["tips"] == ["a"]


def test_extract_json_object_no_json_returns_empty():
    assert llm._extract_json_object("no json here") == {}


def test_valid_scores_rejects_partial_and_accepts_full(monkeypatch):
    # Partial dims / non-numeric / out-of-range must be rejected so empty feedback never
    # slips through and silently drops the interview's dashboard score contribution.
    assert llm._valid_scores({}) is None
    assert llm._valid_scores({"clarity": 8}) is None  # missing dims
    assert llm._valid_scores({d: "hi" for d in llm.FEEDBACK_DIMS}) is None
    assert llm._valid_scores({d: 0 for d in llm.FEEDBACK_DIMS}) is None  # out of 1-10
    ok = llm._valid_scores({d: 6 for d in llm.FEEDBACK_DIMS})
    assert ok == {d: 6.0 for d in llm.FEEDBACK_DIMS}


async def test_generate_feedback_real_grader_and_formatter_path(monkeypatch):
    # Drives the REAL two-stage pipeline end-to-end at the _completion seam: grader prose
    # call returns notes, formatter JSON call returns a sample object -> valid FeedbackSummary.
    monkeypatch.setattr(llm, "STUB_MODE", False)
    caller = {"model": None, "msgs": None, "json": None}

    async def _completion(system, user_text, *, model, base_url, max_tokens, json_output=False):
        caller["model"] = model
        caller["msgs"] = [system, user_text]
        caller["json"] = json_output
        return "prose notes" if not json_output else '{"scores": {"clarity": 7, "relevance": 8, "structure": 6, "confidence": 5}, "verdict": "Solid.", "tips": ["Do X", "Do Y"]}'

    monkeypatch.setattr(llm, "_completion", _completion)
    out = await llm.generate_feedback([ChatMessage(role="user", content="hi")])
    assert out is not None
    assert all(1 <= out.scores[d] <= 10 for d in llm.FEEDBACK_DIMS)
    assert caller["json"] is True  # formatter hop requested JSON mode


async def test_generate_feedback_formatter_retries_on_bad_schema(monkeypatch):
    # Formatter's real retry: first attempt returns non-schema JSON (no scores), the retry
    # returns the right shape. generate_feedback should yield the recovered summary.
    monkeypatch.setattr(llm, "STUB_MODE", False)
    attempts = {"n": 0}

    async def _completion(system, user_text, *, model, base_url, max_tokens, json_output=False):
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
    # Grader OK but every formatter JSON attempt (incl. its retry) is unusable -> None, so
    # the caller writes NO feedback rather than a fabricated 6-average.
    monkeypatch.setattr(llm, "STUB_MODE", False)
    attempts = {"n": 0}

    async def _completion(system, user_text, *, model, base_url, max_tokens, json_output=False):
        if json_output:
            attempts["n"] += 1
            return '{"verdict": "nope"}'  # always schema-mismatched
        return "prose notes"

    monkeypatch.setattr(llm, "_completion", _completion)
    out = await llm.generate_feedback([ChatMessage(role="user", content="hi")])
    assert attempts["n"] == 2  # formatter exhausted its one retry
    assert out is None  # no fabricated feedback


async def test_generate_feedback_returns_none_when_grader_fails(monkeypatch):
    # Grader's real retry never yields prose -> generate stops and returns None; the
    # formatter JSON hop is never even attempted.
    monkeypatch.setattr(llm, "STUB_MODE", False)
    grader_attempts = {"n": 0}
    format_attempts = {"n": 0}

    async def _completion(system, user_text, *, model, base_url, max_tokens, json_output=False):
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
