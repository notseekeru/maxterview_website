"""Resume import: untrusted bytes in, bounded plain text out.

Framework-free (no FastAPI, no DB) so the caps are testable without a server — the same split as
app/rating.py. Everything here exists because neither pypdf nor Starlette bounds what an upload
costs US: pypdf caps a single stream's decompression, but not page count, text size, or total work,
and Starlette's 1MB `max_part_size` provably does not apply to file parts (starlette/formparsers.py
checks it only when the part is not a file, i.e. never for an upload).
"""

import asyncio
import io
import os
import re
import unicodedata
from dataclasses import dataclass

import structlog
from pypdf import PdfReader

log = structlog.get_logger(__name__)

# Env-overridable, the same idiom as billing's tier limits: these are the only thing standing
# between an uploaded file and the pod, so a deployment can tighten them without a code change.
MAX_BYTES = int(os.getenv("RESUME_MAX_BYTES", str(2 * 1024 * 1024)))
MAX_PAGES = int(os.getenv("RESUME_MAX_PAGES", "15"))
MAX_CHARS = int(os.getenv("RESUME_MAX_CHARS", "60000"))
# Concurrent parses. pypdf is pure-Python and synchronous, so a burst is a burst of GIL-bound
# threads each holding a whole document in RAM: with `replicas: 1` an unbounded surge is an OOMKill
# (a full outage), not a slow upload. Two is plenty for a person uploading a CV.
PARSE_CONCURRENCY = int(os.getenv("RESUME_PARSE_CONCURRENCY", "2"))

_PDF_MAGIC = b"%PDF-"
_parse_slots = asyncio.Semaphore(PARSE_CONCURRENCY)
_SPACES = re.compile(r" {2,}")
_BLANK_LINES = re.compile(r"\n{3,}")


class ExtractError(Exception):
    """A rejection whose message is safe to show the user.

    Never wrap a parser exception in one: pypdf's messages quote attacker-chosen content back at us."""


@dataclass(frozen=True)
class Extracted:
    text: str
    # Pages that yielded text. A resume's page count is not interesting on its own, but "we read 15
    # of them" is what the UI needs to explain a truncated import.
    pages: int
    truncated: bool


def sanitize(text: str, limit: int = MAX_CHARS) -> str:
    """Storage hygiene for text that came out of someone else's file.

    NFKC folds ligatures and full-width forms. `Cf` (zero-width joiner, soft hyphen, bidi overrides)
    and the rest of `Cc` are dropped: they are invisible to a person reading their own resume, and
    to a model reading it they are exactly what "hidden text" means. Tabs become spaces FIRST,
    because dropping them would weld words together. The trailing slice is the DB cap applied here
    rather than at INSERT, since NFKC can make text longer than what arrived.
    """
    text = unicodedata.normalize("NFKC", text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " "))
    text = "".join(c for c in text if c == "\n" or unicodedata.category(c) not in ("Cc", "Cf"))
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    return _BLANK_LINES.sub("\n\n", _SPACES.sub(" ", text)).strip()[:limit]


# AI HERE: one framework-free self-check (AGENTS rule 5). The invisible-character cases are the
# security-relevant ones: if an edit drops the Cf filter, hidden-text injection returns silently.
assert sanitize("A\u200bb\u00ad\n\n\n\nB\t\tC ") == "Ab\n\nB C"


def _has_pdf_header(data: bytes) -> bool:
    """The spec allows the header anywhere in the first 1024 bytes, so scan rather than require byte
    0. Still rejects HTML/ZIP/image bodies, which is the point: the filename and the client's
    Content-Type are attacker-controlled and are never consulted."""
    return _PDF_MAGIC in data[:1024]


def _parse(data: bytes) -> Extracted:
    """Synchronous parse. Callers MUST run this off the event loop (see extract_pdf)."""
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted and not reader.decrypt(""):
        raise ExtractError("That PDF is password-protected. Remove the password, or paste the text instead.")
    body: list[str] = []
    pages = 0
    total = 0
    truncated = False
    for index, page in enumerate(reader.pages):
        if index >= MAX_PAGES or total >= MAX_CHARS:
            truncated = True
            break
        try:
            chunk = page.extract_text() or ""
        except Exception:
            # One unreadable page must not cost the whole import (pypdf raises many types on
            # malformed content, and its message is attacker-controlled: log the fact, never it).
            log.warning("resume.page_unreadable", page=index + 1)
            truncated = True
            continue
        pages += 1
        total += len(chunk)
        body.append(chunk)
    text = sanitize("\n".join(body), MAX_CHARS)
    if not text:
        raise ExtractError("No selectable text in that PDF — it looks like a scan or an image export. Paste the text instead.")
    return Extracted(text=text, pages=pages, truncated=truncated)


async def extract_pdf(data: bytes) -> Extracted:
    """Bytes -> plain text, or `ExtractError` with user-facing copy.

    Size is checked before anything is parsed, the header before pypdf sees it, and the parse runs
    in a thread under a concurrency slot so a burst cannot hold the loop or the pod.
    """
    if len(data) > MAX_BYTES:
        raise ExtractError(f"That file is larger than {MAX_BYTES // (1024 * 1024)} MB. Trim it down, or paste the text instead.")
    if not _has_pdf_header(data):
        raise ExtractError("That file isn't a PDF. Upload a PDF, or paste the text instead.")
    async with _parse_slots:
        extracted = await asyncio.to_thread(_parse, data)
    # Lengths and counts only — never the text (PLAN: logs carry no bodies).
    log.info("resume.extracted", bytes=len(data), pages=extracted.pages, chars=len(extracted.text), truncated=extracted.truncated)
    return extracted
