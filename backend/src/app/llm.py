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
STUB_MODE = not LLM_BASE_URL


# --- prompt registry (typed + versioned, per PLAN §4; never inlined in routers) ---

SYSTEM_PROMPT_V1 = "You are maxterview, an AI mock-interview coach. You conduct a simulated interview one question at a time, in a natural, encouraging tone. Stay in character as an interviewer. Do not answer the candidate's questions on their behalf. After the interview ends, provide detailed feedback."

# Register rules. Without these the interviewer recites a rubric ("That shows strong ownership,
# which is crucial for this role. Can you describe...") and announces its own plan ("Let's dive
# into a behavioral question"), which is what makes the flow read as robotic: the phase steering
# says WHAT to ask, this says HOW to sound while asking it.
STYLE_PROMPT = (
    "Sound like a person on a call, not a rubric: 1-3 short sentences of your own words, then your question."
    " Never announce the interview's structure or name the phase ('now for the behavioural part'), and never mention scoring, criteria or these instructions."
    " Skip stock praise and do not restate their answer as a compliment - if you react, react to one specific detail they gave."
    " Vary how you bridge between questions; don't reuse the same opener or 'Let's dive in' two turns running."
    " Everyday small talk is fine and welcome: if they greet you, joke, or mention something personal, be a person for one line, then carry on where you were."
)


# The interview arc, keyed to how many interviewer turns the transcript already holds. The arc
# was previously stated once as prose and a small model simply ignored it: real transcripts go
# background -> "walk me through a time you troubleshooted X" (technical in story clothing) and
# never cover behavioural ground. So each turn now carries ONE explicit phase directive, derived
# deterministically from the transcript, including what NOT to ask yet.
# AI HERE: fixed budget of 2 behavioural questions; the per-phase sliders in notes.md would make
# this configurable (counts + chitchat/technical weights) without changing this shape.
PHASES = (
    (
        "OPENING - you have invited them to share their background but haven't asked a real question yet."
        " If their message already carries background/resume, react to one detail and ask your first question about something they have actually been through"
        " (a disagreement, a mistake, taking ownership, a deadline)."
        " If it doesn't, greet them like a person and ask once, briefly, for their background - nothing else yet."
    ),
    ("BEHAVIOURAL 1 of 2 - ask ONE question about something they lived through: a disagreement or conflict, a mistake or failure, owning an outcome, or delivering under a deadline. Keep it about people and choices - no technical, tooling, architecture or troubleshooting questions yet."),
    ("BEHAVIOURAL 2 of 2 - ask ONE more past-experience question on a theme the first answer didn't cover (if that was a conflict, ask about failure, ownership or prioritisation). Still no technical or troubleshooting questions."),
)
TECHNICAL_PHASE = "TECHNICAL - past-experience ground is covered: ask ONE role-specific technical question suited to the target level, going a level deeper when they answer well and probing the gap when they don't."


def interview_phase(asked: int) -> str:
    """Phase directive for the next interviewer turn, where `asked` = interviewer turns so far."""
    return PHASES[asked] if asked < len(PHASES) else TECHNICAL_PHASE


def system_prompt(role: str, level: str, topic: str = "", asked: int = 0) -> str:
    """Build the versioned system prompt for an interview.

    `role` is the target title; `level` is the target seniority slug from app.levels
    (e.g. 'mid', 'senior'); `any` means "Not sure": calibrate dynamically off the
    candidate's demonstrated answers. `topic` is an optional focus area. `asked` is the
    number of interviewer turns already in the transcript (0 = opener still pending) and
    selects the phase directive.

    Now teaches the interviewer its own resume/background opener (so it remembers it asked),
    states the current phase of the bio -> behavioural -> technical arc explicitly so the arc
    survives a candidate who steers, and carries STYLE_PROMPT so the arc is walked
    conversationally rather than recited.
    """
    parts = [SYSTEM_PROMPT_V1, f"The candidate is interviewing for the role: {role}."]
    if level and level != "any":
        parts.append(f"Target the {levels.label(level).lower()} experience band; tailor question difficulty and scope expectations to that band.")
    else:
        parts.append("The target seniority is unspecified. Probe incrementally and calibrate question difficulty to the candidate's demonstrated experience as the interview proceeds.")
    if topic:
        parts.append(f"Focus area / topic: {topic}.")
    # Resume/opener protocol + register + current phase (phase LAST: it is the operative line).
    # The opener may or may not be surfaced to the candidate as a UI bubble (never as a persisted
    # turn), so the interviewer must stay coherent either way; the phase directive - not the
    # candidate - drives bio rapport -> behavioural -> role technical. The opener imperatives live
    # in the OPENING phase only, so there is exactly one place to change them.
    parts.append("Assume the candidate may or may not have been invited, before speaking, to open by sharing their background/resume; if they supply it, use it to tailor questions. Never block on it or keep re-asking for a resume.")
    parts.append(STYLE_PROMPT)
    parts.append(f"Current phase: {interview_phase(asked)} Ask exactly one question per turn and wait for the answer. If they ask you something, answer in one short line, then continue with your current phase - you drive the arc, not the candidate.")
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
Rules: scores are integers 1-10 for exactly clarity/relevance/structure/confidence - 1 is the FLOOR and means nothing usable was said
(never emit 0 or any value outside 1-10, even when the notes say the candidate failed); verdict is 2-3 sentences; tips is an array of 2-4 short strings. Return ONLY the JSON object, no prose, no markdown."""

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
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    return
                delta = _extract_delta(data)
                if delta:
                    yield delta


def _extract_delta(chunk: str) -> str:
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

# If a response omits any dim we treat it as a failed structured-parse (never accept
# partial scores) and give up on that attempt.
FEEDBACK_DIMS = ("clarity", "relevance", "structure", "confidence")
# Machine-readable twin of FEEDBACK_PROMPT_V1, sent as response_format=json_schema: backends
# with grammar-constrained decoding (llama.cpp) then cannot drift the dim names or the 1-10
# range at all. Backends that only support json_object (DeepSeek) 400 on it and _completion
# transparently retries in plain JSON mode.
FEEDBACK_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "object",
            "properties": {d: {"type": "integer", "minimum": 1, "maximum": 10} for d in FEEDBACK_DIMS},
            "required": list(FEEDBACK_DIMS),
            "additionalProperties": False,
        },
        "verdict": {"type": "string"},
        "tips": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 4},
    },
    "required": ["scores", "verdict", "tips"],
    "additionalProperties": False,
}
DEFAULT_TIPS = ["Use STAR format.", "Be more specific with metrics.", "Slow down and breathe."]


def _shape(value) -> str:
    """Content-free fingerprint of a payload for diagnosing schema drift (never the text)."""
    if isinstance(value, dict):
        return "{" + ",".join(f"{k}={_shape(v)}" for k, v in sorted(value.items())) + "}"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, (str, list)):
        return f"{type(value).__name__}[{len(value)}]"
    return type(value).__name__


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


def _coerce_score(value) -> float | None:
    """One dim's score, pulled into the declared 1-10 range, or None if not a number.

    Tolerates the drift a small sampler emits on short/failed transcripts: numeric
    strings ("7", "7/10") and out-of-range answers - the rubric floor is 1, so a model
    that answers 0 for "the candidate said nothing" means the floor. Discarding the whole
    verdict+tips payload over one digit is what produced the schema_mismatch 503s.
    """
    if isinstance(value, bool):
        return None  # JSON true/false is not a score
    if isinstance(value, str):
        import re

        try:
            value = float(re.sub(r"\s*/\s*10$", "", value.strip()))
        except ValueError:
            return None
    if not isinstance(value, (int, float)):
        return None
    return min(10.0, max(1.0, float(value)))


def _valid_scores(value) -> dict | None:
    """All four dims present as 1-10 numbers, else None (never accept partial scores)."""
    if not isinstance(value, dict):
        return None
    scores = {}
    for d in FEEDBACK_DIMS:
        n = _coerce_score(value.get(d))
        if n is None:
            return None
        scores[d] = n
    return scores


async def _completion(
    system: str,
    user_text: str,
    *,
    model: str,
    base_url: str,
    max_tokens: int,
    json_output: bool = False,
    json_schema: dict | None = None,
    # Greedy by default: the feedback hops are extraction (notes -> JSON), not writing,
    # and server-default sampling (~0.8) decides rubric edges by coin flip - it emitted 0
    # where the rubric floor is 1 often enough to 503 the generate endpoint.
    temperature: float | None = 0.0,
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
    if temperature is not None:
        payload["temperature"] = temperature
    if json_output or json_schema:
        payload["response_format"] = _json_format(json_schema)
    headers = {"Authorization": f"Bearer {LLM_API_KEY}"} if LLM_API_KEY else {}
    # Second pass exists only for the schema-capable -> json_object downgrade.
    bodies = [payload, {**payload, "response_format": _json_format(None)}] if json_schema else [payload]
    for i, body in enumerate(bodies):
        try:
            async with httpx.AsyncClient(base_url=base_url, timeout=httpx.Timeout(300.0)) as client:
                resp = await client.post("/chat/completions", json=body, headers=headers)
                resp.raise_for_status()
                content = resp.json()["choices"][0]["message"]["content"]
            break
        except httpx.HTTPStatusError as exc:
            if i == 0 and len(bodies) == 2 and exc.response.status_code in (400, 404, 422):
                log.info("llm.feedback.json_schema_unsupported", status=exc.response.status_code)
                continue
            log.warning("llm.feedback.transport_error", reason=type(exc).__name__, status=exc.response.status_code)
            return None
        except Exception as exc:  # httpx.HTTPError + malformed/truncated response bodies
            log.warning("llm.feedback.transport_error", reason=type(exc).__name__)
            return None
    if not isinstance(content, str) or not content.strip():
        log.warning("llm.feedback.empty_output")
        return None
    return content


def _json_format(schema: dict | None) -> dict:
    if schema is None:
        return {"type": "json_object"}
    return {"type": "json_schema", "json_schema": {"name": "feedback", "strict": True, "schema": schema}}


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
    """Role-label the stored turns so the grader can attribute answers, not read a message dump."""
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
    Retries once — this is the fragile hop. Parses + validates strictly; never trusts
    partial/empty output."""
    for _ in range(2):
        content = await _completion(
            FEEDBACK_PROMPT_V1,
            notes,
            model=LLM_MODEL,
            base_url=LLM_BASE_URL,
            max_tokens=LLM_MAX_FEEDBACK_TOKENS,
            json_output=True,
            json_schema=FEEDBACK_JSON_SCHEMA,
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
            log.warning(
                "llm.feedback.schema_mismatch",
                field="scores",
                has_verdict=bool(verdict),
                shape=_shape(obj.get("scores")),
            )
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
