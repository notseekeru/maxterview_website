import os
from collections.abc import AsyncIterator

import httpx

from app.models import ChatMessage, FeedbackSummary

# --- config (D7): OpenAI-compatible, local on dev, DeepSeek on prod ---
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "").rstrip("/")
LLM_MODEL = os.getenv("LLM_MODEL", "")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")

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


def feedback_prompt() -> str:
    return FEEDBACK_PROMPT_V1


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
    }
    headers = {"Authorization": f"Bearer {LLM_API_KEY}"} if LLM_API_KEY else {}
    async with httpx.AsyncClient(base_url=LLM_BASE_URL, timeout=httpx.Timeout(60.0, read=30.0)) as client:
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
                yield _extract_delta(data)


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


async def generate_feedback(history: list[ChatMessage]) -> FeedbackSummary:
    """Generate structured feedback (scores/verdict/tips) from the whole transcript.

    STUB_MODE: returns a deterministic FeedbackSummary so tests/MVP work without a model.
    """
    if STUB_MODE:
        return FeedbackSummary(
            scores={"clarity": 6, "relevance": 6, "structure": 6, "confidence": 6},
            verdict="Good overall; practice keeping answers concise and structured.",
            tips=["Use STAR format.", "Be more specific with metrics.", "Slow down and breathe."],
        )

    payload = {
        "model": LLM_MODEL,
        "messages": [
            {"role": "system", "content": feedback_prompt()},
            *[m.model_dump() for m in history],
        ],
        "stream": False,
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {LLM_API_KEY}"} if LLM_API_KEY else {}
    async with httpx.AsyncClient(base_url=LLM_BASE_URL, timeout=httpx.Timeout(120.0)) as client:
        resp = await client.post("/chat/completions", json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        obj = _extract_json_object(content)
        return FeedbackSummary(
            scores=obj.get("scores", {}),
            verdict=obj.get("verdict", ""),
            tips=obj.get("tips", []),
        )


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
