from io import BytesIO

import pytest
from pypdf import PdfReader, PdfWriter

from app import resumes


def mini_pdf(text: str = "Hello Resume") -> bytes:
    content = f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode() if text else b""
    bodies = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(bodies, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(bodies) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(bodies) + 1, xref_at)
    return bytes(out)


def replicated(pages: int, text: str = "Hello Resume") -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_page(PdfReader(BytesIO(mini_pdf(text))).pages[0])
    out = BytesIO()
    writer.write(out)
    return out.getvalue()


def encrypted(password: str = "hunter2") -> bytes:
    writer = PdfWriter(clone_from=PdfReader(BytesIO(mini_pdf())))
    writer.encrypt(password)
    out = BytesIO()
    writer.write(out)
    return out.getvalue()


async def test_extracts_text_from_a_real_pdf():
    got = await resumes.extract_pdf(mini_pdf("Alex Mender — Platform Engineer"))
    assert "Alex Mender" in got.text and "Platform Engineer" in got.text
    assert (got.pages, got.truncated) == (1, False)


async def test_rejects_a_body_that_is_not_a_pdf():
    for body in (b"<html>hello</html>", b"PK\x03\x04zip", b"", b"\x89PNG\r\n\x1a\n"):
        with pytest.raises(resumes.ExtractError, match="isn't a PDF"):
            await resumes.extract_pdf(body)


async def test_magic_bytes_are_found_past_byte_zero():
    # The spec allows junk before the header, so this must still parse — and it is why the check is a
    # scan, not a `startswith`.
    got = await resumes.extract_pdf(b"garbage-prefix\n" + mini_pdf())
    assert "Hello Resume" in got.text


async def test_rejects_oversize_before_parsing(monkeypatch):
    monkeypatch.setattr(resumes, "MAX_BYTES", 64)
    # A valid PDF header over the cap: rejected on size, never handed to pypdf.
    with pytest.raises(resumes.ExtractError, match="larger than"):
        await resumes.extract_pdf(mini_pdf() + b" " * 64)


async def test_page_cap_reads_only_the_first_n(monkeypatch):
    monkeypatch.setattr(resumes, "MAX_PAGES", 3)
    got = await resumes.extract_pdf(replicated(10))
    assert got.pages == 3
    assert got.truncated is True


async def test_char_cap_stops_early(monkeypatch):
    monkeypatch.setattr(resumes, "MAX_CHARS", 40)
    got = await resumes.extract_pdf(replicated(10))
    assert len(got.text) <= 40
    assert got.truncated is True


async def test_password_protected_is_rejected_not_decoded():
    with pytest.raises(resumes.ExtractError, match="password-protected"):
        await resumes.extract_pdf(encrypted())


async def test_image_only_pdf_reports_the_paste_path():
    # What a phone scan or a Canva export looks like: a valid PDF whose page carries no text operator.
    with pytest.raises(resumes.ExtractError, match="Paste the text instead"):
        await resumes.extract_pdf(mini_pdf(""))


def test_sanitize_folds_expands_and_strips_invisibles():
    # NFKC widens some characters (not only folds), which is why the DB cap is applied after it.
    assert resumes.sanitize("\ufb01le  \u00a0name") == "file name"
    assert resumes.sanitize("a\u200bb\u202ec") == "abc"
    assert resumes.sanitize("x" * 100, limit=10) == "x" * 10
