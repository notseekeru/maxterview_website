import asyncio
import io
import os
import re
import unicodedata
from dataclasses import dataclass

import structlog
from pypdf import PdfReader

log = structlog.get_logger(__name__)

MAX_BYTES = int(os.getenv("RESUME_MAX_BYTES", str(2 * 1024 * 1024)))
MAX_PAGES = int(os.getenv("RESUME_MAX_PAGES", "15"))
MAX_CHARS = int(os.getenv("RESUME_MAX_CHARS", "60000"))
# pypdf is synchronous and pure-Python, so each parse holds a whole document in RAM: with `replicas: 1`
# an unbounded surge is an OOMKill, not a slow upload.
PARSE_CONCURRENCY = int(os.getenv("RESUME_PARSE_CONCURRENCY", "2"))

_PDF_MAGIC = b"%PDF-"
_parse_slots = asyncio.Semaphore(PARSE_CONCURRENCY)
_SPACES = re.compile(r" {2,}")
_BLANK_LINES = re.compile(r"\n{3,}")


class ExtractError(Exception): ...


@dataclass(frozen=True)
class Extracted:
    text: str
    pages: int
    truncated: bool


def sanitize(text: str, limit: int = MAX_CHARS) -> str:
    text = unicodedata.normalize("NFKC", text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " "))
    text = "".join(c for c in text if c == "\n" or unicodedata.category(c) not in ("Cc", "Cf"))
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    return _BLANK_LINES.sub("\n\n", _SPACES.sub(" ", text)).strip()[:limit]


# AI HERE: one framework-free self-check (AGENTS rule 5). The invisible-character cases are the
# security-relevant ones: if an edit drops the Cf filter, hidden-text injection returns silently.
assert sanitize("A\u200bb\u00ad\n\n\n\nB\t\tC ") == "Ab\n\nB C"


def _has_pdf_header(data: bytes) -> bool:
    return _PDF_MAGIC in data[:1024]


def _parse(data: bytes) -> Extracted:
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
        raise ExtractError("No selectable text in that PDF: it looks like a scan or an image export. Paste the text instead.")
    return Extracted(text=text, pages=pages, truncated=truncated)


async def extract_pdf(data: bytes) -> Extracted:
    if len(data) > MAX_BYTES:
        raise ExtractError(f"That file is larger than {MAX_BYTES // (1024 * 1024)} MB. Trim it down, or paste the text instead.")
    if not _has_pdf_header(data):
        raise ExtractError("That file isn't a PDF. Upload a PDF, or paste the text instead.")
    async with _parse_slots:
        extracted = await asyncio.to_thread(_parse, data)
        # Lengths and counts only, never the text: logs carry no bodies.
    log.info("resume.extracted", bytes=len(data), pages=extracted.pages, chars=len(extracted.text), truncated=extracted.truncated)
    return extracted
