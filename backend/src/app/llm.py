import os
from collections.abc import AsyncIterator

import httpx
import structlog

from app import levels
from app.models import ChatMessage, FeedbackSummary

log = structlog.get_logger(__name__)

# --- config (D7): OpenAI-compatible, local on dev, DeepSeek on prod ---
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "").rstrip("/")
LLM_MODEL = os.getenv("LLM_MODEL", "")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")

# Two-stage feedback pipeline (grader -> formatter). Stage-1 (grader) reads the FULL
# transcript and writes free-text analysis because a permissive chat model is unreliable
# at emitting strict JSON over a long context; stage-2 (formatter) re-shapes that small,
# fresh analysis into the exact schema where schema adherence is cheapest. Each stage can
# ride a different model/provider: LLM_GRADER_* override the shared LLM_*_URL/MODEL when
# set (e.g. prod points the grader at a stronger model and keeps the cheap one for the
# formatter), else stage 1==stage 2==the single configured model.
LLM_GRADER_BASE_URL = os.getenv("LLM_GRADER_BASE_URL", LLM_BASE_URL).rstrip("/")
LLM_GRADER_MODEL = os.getenv("LLM_GRADER_MODEL", LLM_MODEL)

# Token ceilings to bound runaway local thinking models (Qwen emits long reasoning).
# Env-overridable: LLM_MAX_TOKENS caps streaming replies; LLM_MAX_GRADER_TOKENS caps the
# grader's free-text analysis; LLM_MAX_FEEDBACK_TOKENS caps the formatter's JSON.
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "512"))
LLM_MAX_GRADER_TOKENS = int(os.getenv("LLM_MAX_GRADER_TOKENS", "1024"))
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


def system_prompt(role: str, level: str, topic: str = "") -> str:
    """Build the versioned system prompt for an interview.

    `role` is the target title; `level` is the target seniority slug from app.levels
    (e.g. 'mid', 'senior'); `any` means "Not sure": calibrate dynamically off the
    candidate's demonstrated answers. `topic` is an optional focus area.

    Now teaches the interviewer its own resume/background opener (so it remembers it
    asked) and the bio -> behavioural -> technical arc it should run even when the
    candidate declines to share a resume.
    """
    parts = [SYSTEM_PROMPT_V1, f"The candidate is interviewing for the role: {role}."]
    if level and level != "any":
        parts.append(f"Target the {levels.label(level).lower()} experience band; tailor question difficulty and scope expectations to that band.")
    else:
        parts.append("The target seniority is unspecified. Probe incrementally and calibrate question difficulty to the candidate's demonstrated experience as the interview proceeds.")
    if topic:
        parts.append(f"Focus area / topic: {topic}.")
    # Resume/opener protocol + flowing arc. The opener may or may not be surfaced to the
    # candidate as a UI bubble (never as a persisted turn), so the interviewer must stay
    # coherent either way: it never re-livens a resume ask it already posed, and it always
    # steers bio rapport -> behavioural -> role technical regardless of whether a resume is
    # supplied (relevant for the grader's self-presentation rule, not a blocker in-chat).
    parts.append(
        "Assume the candidate may or may not have been invited, before speaking, to open by sharing their background/resume."
        " If your first outbound message is still pending, that opening invitation is what you should send - ask once, briefly."
        " If the candidate supplies background/resume, use it to tailor questions."
        " If they supply none, you may ask one short follow-up to capture background, then move on - never block or keep re-asking for a resume."
        " Run the interview in this order: a short natural/bio rapport exchange, then behavioural questions about their past experience, then technical questions suited to the target role and level."
        " Ask one question at a time and wait for each answer before moving on."
    )
    return " ".join(parts)


GRADER_PROMPT_V1 = """You are maxterview's interview grader. You will be given an interview transcript between an interviewer and a candidate applying for a software role.

Background: the interviewer opened by inviting the candidate to share their resume / background so it could tailor questions, and interviews went: a short bio/rapport warm-up, then behavioural questions, then role-specific technical questions.

Assess ONLY the candidate's answers against these four dimensions, each on a 1-10 scale:
- clarity: how well-structured and easy to follow each answer was.
- relevance: how directly the answer addressed the question and the role.
- structure: use of a clear framework (e.g. STAR) with a beginning/middle/end.
- confidence: DELIVERY ONLY — hedging, vague phrasing, whether they commit to a position. Do NOT count missing resume/metrics/experience here; that belongs under relevance/structure.

Calibration: resist 10s. Reserve 9-10 for near-flawless, concrete, evidence-backed answers. If you can name no real weakness for a dimension, probe harder rather than defaulting to a perfect score;
a strong interview that 'has no flaws' should still land around 7-9 with an explicit weaker spot, not a flat 10 across the board.

Grounding: never attribute an achievement, metric, project, "team", employer, or result to the candidate unless it is stated IN the transcript. If evidence is missing, score the relevant dimension down and say exactly what was absent. Do not invent specifics to justify a high score.

Self-presentation rule: the candidate's first answers should establish their background/resume.
If they never supplied any background/resume to anchor their answers, be strict: score relevance/structure
low when answers stay vague or disconnected from the role, and call the omission out in your verdict and
tips as a real reason points were lost. Do NOT let the omission pass silently — but still grade the
technical/behavioural content they DID give on its own merit.

Write a short paragraph PER dimension: name the dimension, give one concrete thing from the candidate's answers as evidence, then a single suggested integer score for it. Then write a 2-3 sentence overall verdict and 2-4 specific, actionable tips.

Use PLAIN PROSE. Do NOT wrap everything in JSON — you are the reviewer, a separate step turns your notes into the final format. Be strict but fair; award high scores only with evidence."""


# Concrete JSON example inlined (DeepSeek's JSON-mode docs require a shape example, and
# it hard-codes the schema so a weak local backend cannot drift the field names). The
# formatter runs on fresh, SHORT grader notes rather than the long raw transcript.
FEEDBACK_PROMPT_V1 = """Convert the interview grader notes in your user message into a JSON object ONLY, exactly matching this shape:
{"scores": {"clarity": 7, "relevance": 6, "structure": 8, "confidence": 5}, "verdict": "Overall assessment in 2-3 sentences.", "tips": ["tip one", "tip two"]}
Rules: scores are integers 1-10 for exactly clarity/relevance/structure/confidence; verdict is 2-3 sentences; tips is an array of 2-4 short strings. Return ONLY the JSON object, no prose, no markdown."""


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


async def _completion(
    system: str,
    user_text: str,
    *,
    model: str,
    base_url: str,
    max_tokens: int,
    json_output: bool = False,
) -> str | None:
    """One non-streaming completion. Returns the raw assistant text, or None on failure.

    Logs transport/empty failures only (never content or transcript bodies), and never
    raises so a model outage can't 500 the caller that would otherwise leave an interview
    half-finished."""
    payload: dict = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user_text}],
        "stream": False,
        "max_tokens": max_tokens,
        **_chat_extras(),
    }
    if json_output:
        payload["response_format"] = {"type": "json_object"}
    headers = {"Authorization": f"Bearer {LLM_API_KEY}"} if LLM_API_KEY else {}
    try:
        async with httpx.AsyncClient(base_url=base_url, timeout=httpx.Timeout(300.0)) as client:
            resp = await client.post("/chat/completions", json=payload, headers=headers)
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
    except Exception as exc:  # httpx.HTTPError + malformed/truncated response bodies
        log.warning("llm.feedback.transport_error", reason=type(exc).__name__)
        return None
    if not isinstance(content, str) or not content.strip():
        log.warning("llm.feedback.empty_output")
        return None
    return content


async def _request_grader_notes(history: list[ChatMessage]) -> str | None:
    """Stage 1: grade the FULL transcript in free text. Retries once on quirkiness.

    Runs on LLM_GRADER_* (falls back to the shared model). Fresh prompt + role-labelled
    transcript, so the heavy "read the whole thing" work is clean and schema-free — the
    model is far more reliable at prose critique than strict JSON over a long context."""
    transcript = _format_transcript(history)
    if not transcript:
        log.warning("llm.feedback.empty_transcript")
        return None
    for _ in range(2):
        notes = await _completion(
            GRADER_PROMPT_V1,
            transcript,
            model=LLM_GRADER_MODEL,
            base_url=LLM_GRADER_BASE_URL,
            max_tokens=LLM_MAX_GRADER_TOKENS,
        )
        if notes is not None:
            return notes
    log.error("llm.feedback.grader_unavailable")
    return None


def _format_transcript(history: list[ChatMessage]) -> str:
    """Render the stored chat turns into a clean role-labelled transcript for the grader,
    so it can attribute answers instead of reading an undifferentiated message dump."""
    lines: list[str] = []
    for m in history:
        if m.role == "system":
            continue  # interviewer system framing is not grading material
        who = "Candidate" if m.role == "user" else "Interviewer"
        lines.append(f"{who}: {m.content}")
    return "\n".join(lines)


async def _request_format(notes: str) -> FeedbackSummary | None:
    """Stage 2: turn the grader's short notes into the exact JSON schema.

    Fresh, SMALL context (just the notes) is where schema adherence is cheap and reliable.
    Retries once — this is the fragile hop, so it gets the same two-shot retry the old
    single-fat-call got. Parses + validates strictly; never trusts partial/empty output."""
    for _ in range(2):
        content = await _completion(
            FEEDBACK_PROMPT_V1,
            notes,
            model=LLM_MODEL,
            base_url=LLM_BASE_URL,
            max_tokens=LLM_MAX_FEEDBACK_TOKENS,
            json_output=True,
        )
        if content is None:
            continue
        obj = _extract_json_object(content)
        if not obj:
            log.warning("llm.feedback.no_json")
            continue
        verdict = obj.get("verdict", "")
        scores = _valid_scores(obj.get("scores"))
        if scores is None:
            log.warning("llm.feedback.schema_mismatch", field="scores", has_verdict=bool(verdict))
            continue
        if not isinstance(verdict, str) or not verdict.strip():
            log.warning("llm.feedback.schema_mismatch", field="verdict")
            continue
        tips_list = obj.get("tips")
        tips = [t for t in tips_list if isinstance(t, str) and t.strip()] if isinstance(tips_list, list) else []
        return FeedbackSummary(scores=scores, verdict=verdict.strip(), tips=tips)
    log.error("llm.feedback.formatter_unavailable")
    return None


async def generate_feedback(history: list[ChatMessage]) -> FeedbackSummary | None:
    """Return structured feedback for a completed transcript, or None when it is genuinely
    unavailable.

    Two-mode, two-stage pipeline:
      - STUB_MODE: no model configured -> deterministic stand-in (dev/seed/tests only).
      - Real: grader (full transcript -> prose) then formatter (prose -> strict JSON). On
        either stage failing after its retry, return None -- the caller must NOT write
        feedback, so the interview surfaces as unscored rather than carrying fabricated 6s.
    """
    if STUB_MODE:
        log.warning("llm.feedback.stub_deterministic")
        return _deterministic_summary()
    notes = await _request_grader_notes(history)
    if notes is None:
        return None
    return await _request_format(notes)


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
