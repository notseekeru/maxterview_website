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


async def test_stub_feedback_is_deterministic():
    f: FeedbackSummary = await llm.generate_feedback([ChatMessage(role="user", content="hi")])
    assert set(f.scores.keys()) == {"clarity", "relevance", "structure", "confidence"}
    assert f.verdict
    assert isinstance(f.tips, list) and len(f.tips) >= 1
