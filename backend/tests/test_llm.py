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
