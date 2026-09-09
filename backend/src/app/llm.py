import os
from collections.abc import AsyncIterator

import httpx
import structlog

from app.models import ChatMessage, FeedbackSummary

log = structlog.get_logger(__name__)

# --- config (D7): OpenAI-compatible, local on dev, DeepSeek on prod ---
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "").rstrip("/")
LLM_MODEL = os.getenv("LLM_MODEL", "")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")

# Token ceilings to bound runaway local thinking models (Qwen emits long reasoning).
# Env-overridable: LLM_MAX_TOKENS caps streaming replies; LLM_MAX_FEEDBACK_TOKENS caps feedback.
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "512"))
LLM_MAX_FEEDBACK_TOKENS = int(os.getenv("LLM_MAX_FEEDBACK_TOKENS", "1024"))
LLM_DISABLE_THINKING = os.getenv("LLM_DISABLE_THINKING", "true").lower() == "true"


def _chat_extras() -> dict:
    # Qwen-family models emit a long reasoning pass before content, which can exceed
    # max_tokens and yield no answer. Disable thinking by default (safe: non-thinking
    # models ignore chat_template_kwargs).
    if LLM_DISABLE_THINKING:
        return {"chat_template_kwargs": {"enable_thinking": False}}
    return {}


# If no base URL is configured, the LLM runs in STUB mode (deterministic, no network).
# This lets MVP dev and tests run without a model (D7 / MONETIZATION).
STUB_MODE = not LLM_BASE_URL


# --- prompt registry (typed + versioned, per PLAN §4; never inlined in routers) ---

SYSTEM_PROMPT_V1 = "You are maxterview, an AI mock-interview coach. You conduct a simulated interview one question at a time, in a natural, encouraging tone. Stay in character as an interviewer. Do not answer the candidate's questions on their behalf. After the interview ends, provide detailed feedback."


def system_prompt(role: str, topic: str = "") -> str:
    """Build the versioned system prompt for an interview."""
    parts = [SYSTEM_PROMPT_V1, f"The candidate is interviewing for the role: {role}."]
    if topic:
        parts.append(f"Focus area / topic: {topic}.")
    parts.append("Ask one question at a time. Keep responses concise. Reply as the interviewer.")
    return " ".join(parts)


FEEDBACK_PROMPT_V1 = 'Review the full interview transcript. Return a JSON object ONLY, with keys: "scores" (object with numeric 1-10 values for keys clarity, relevance, structure, confidence), "verdict" (string, 2-3 sentences overall assessment), and "tips" (array of 2-4 short actionable strings).'


# --- HTTP / streaming helpers ---


async def stream_chat(messages: list[ChatMessage]) -> AsyncIterator[str]:
    """Stream the assistant reply as incremental text deltas (SSE).

    STUB_MODE: yields the last user message echoed back, tokenized by whitespace,
    so the frontend wire-format can be tested without a live model.
    """
    if STUB_MODE:
        last = [_m for _m in messages if _m.role == "user"]
        reply = last[-1].content if last else "Understood. Tell me more."
        for token in reply.split(" "):
            yield token + " "
        return

    payload = {
        "model": LLM_MODEL,
        "messages": [m.model_dump() for m in messages],
        "stream": True,
        "max_tokens": LLM_MAX_TOKENS,
        **_chat_extras(),
    }
    headers = {"Authorization": f"Bearer {LLM_API_KEY}"} if LLM_API_KEY else {}
    async with httpx.AsyncClient(base_url=LLM_BASE_URL, timeout=httpx.Timeout(300.0, read=120.0)) as client:
        async with client.stream("POST", "/chat/completions", json=payload, headers=headers) as resp:
            resp.raise_for_status()
            # Server-Sent-Event line format: data: {json}\n\n
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                # heuristically strip the delta content; tolerate non-JSON fragments
                delta = _extract_delta(data)
                if delta:
                    yield delta


def _extract_delta(chunk: str) -> str:
    """Pull the content delta from an OpenAI SSE data chunk."""
    import json

    try:
        obj = json.loads(chunk)
        choices = obj.get("choices", [])
        if choices:
            # content may be null on role/tool/thinking chunks; never yield None (TypeError later)
            return choices[0].get("delta", {}).get("content") or ""
    except (ValueError, KeyError, TypeError):
        return ""
    return ""


# --- feedback generation + structured-output guard ---

# The dimension keys we expect from a model. If a response omits any of them we treat it
# as a failed structured-parse (never accept partial scores) and give up on that attempt.
FEEDBACK_DIMS = ("clarity", "relevance", "structure", "confidence")
DEFAULT_TIPS = ["Use STAR format.", "Be more specific with metrics.", "Slow down and breathe."]


def _deterministic_summary() -> FeedbackSummary:
    """Deterministic stand-in feedback for STUB_MODE ONLY (no LLM configured).

    Used when running model-free dev/seed/tests so the UI has a real-looking shape.
    The REAL-model path never fabricates scores: on genuine failure it surfaces absence
    (None) and writes no feedback, rather than poisoning dashboard stats with fake 6s."""
    return FeedbackSummary(
        scores={d: 6 for d in FEEDBACK_DIMS},
        verdict="Good overall; practice keeping answers concise and structured.",
        tips=list(DEFAULT_TIPS),
    )


def _valid_scores(value) -> dict | None:
    """Return scores if `value` is a dict with all dims as finite 1-10 numbers, else None."""
    if not isinstance(value, dict):
        return None
    numeric = []
    for d in FEEDBACK_DIMS:
        v = value.get(d)
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        numeric.append((d, float(v)))
    if not all(1 <= n <= 10 for _, n in numeric):
        return None
    return dict(numeric)


async def _request_feedback(history: list[ChatMessage]) -> FeedbackSummary | None:
    """One real-model feedback call. Returns None when the output is not usable.

    Classifies + logs WHY it failed (so operators can tell transport errors apart from
    schema-mismatch / junk-JSON instead of guessing), but never raises: an uncaught
    exception here would 500 the whole /complete and leave an interview half-finished.

    Logs message COUNTS, never content/keys, per the observability doc's secret rule."""
    msgs = len(history)
    try:
        payload = {
            "model": LLM_MODEL,
            "messages": [{"role": "system", "content": FEEDBACK_PROMPT_V1}, *[m.model_dump() for m in history]],
            "stream": False,
            "response_format": {"type": "json_object"},
            "max_tokens": LLM_MAX_FEEDBACK_TOKENS,
            **_chat_extras(),
        }
        headers = {"Authorization": f"Bearer {LLM_API_KEY}"} if LLM_API_KEY else {}
        async with httpx.AsyncClient(base_url=LLM_BASE_URL, timeout=httpx.Timeout(300.0)) as client:
            resp = await client.post("/chat/completions", json=payload, headers=headers)
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
    except Exception as exc:  # httpx.HTTPError + malformed/truncated response bodies
        log.warning("llm.feedback.transport_error", reason=type(exc).__name__, history_msgs=msgs)
        return None
    if not isinstance(content, str) or not content.strip():
        log.warning("llm.feedback.empty_output", history_msgs=msgs)
        return None
    obj = _extract_json_object(content)
    if not obj:
        log.warning("llm.feedback.no_json", history_msgs=msgs)
        return None
    verdict = obj.get("verdict", "")
    scores = _valid_scores(obj.get("scores"))
    if scores is None:
        log.warning("llm.feedback.schema_mismatch", field="scores", has_verdict=bool(verdict), history_msgs=msgs)
        return None
    if not isinstance(verdict, str) or not verdict.strip():
        log.warning("llm.feedback.schema_mismatch", field="verdict", history_msgs=msgs)
        return None
    tips_list = obj.get("tips")
    tips = [t for t in tips_list if isinstance(t, str) and t.strip()] if isinstance(tips_list, list) else []
    return FeedbackSummary(scores=scores, verdict=verdict.strip(), tips=tips)


async def generate_feedback(history: list[ChatMessage]) -> FeedbackSummary | None:
    """Return structured feedback for a completed transcript, or None when it is genuinely
    unavailable (real model unusable after the retry).

    Single path for both modes:
      - STUB_MODE: no model configured -> deterministic stand-in (dev/seed only, called with
        a clear signal that no LLM scored it).
      - Real model: ask for JSON, validate it; if unusable (or the model/network errors)
        retry once. On double-failure return None -- the caller must NOT write feedback,
        so the interview surfaces as unscored rather than carrying fabricated 6s.

    Guardrail note (flag, NOT implemented here): the feedback request is fed the raw
    interview transcript, and asking a permissive chat model to strictly emit JSON while
    also echoing user-supplied interview content is prompt-injection-prone. A hardened
    grader should run in a dedicated system context / separate endpoint with output-only
    surface - tracked as a follow-up, deliberately out of scope for this fix."""
    if STUB_MODE:
        log.warning("llm.feedback.stub_deterministic")
        return _deterministic_summary()
    for _ in range(2):
        summary = await _request_feedback(history)
        if summary is not None:
            return summary
    log.error("llm.feedback.unavailable_after_retry", history_msgs=len(history))
    return None


def _extract_json_object(text: str) -> dict:
    """Robustly pull the first JSON object out of a model response.

    Some OpenAI-compatible backends (e.g. llama.cpp) may wrap the JSON in prose or
    markdown fencing, so a strict json.loads can fail. Find the first '{' .. matching '}'.
    """
    import json

    start = text.find("{")
    if start == -1:
        return {}
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except (ValueError, json.JSONDecodeError):
                        return {}
    return {}
