"""LaTeX compile for the editor preview: one pdflatex run per request, in its own temp dir, with the
candidate's source as the only input. This is the only place user text reaches a compiler, so the
flags here are the security boundary, not tuning knobs."""

import asyncio
import os
import resource
import shutil
import tempfile
from pathlib import Path

import structlog

log = structlog.get_logger(__name__)

PDFLATEX = shutil.which("pdflatex") or ""
COMPILE_TIMEOUT = float(os.getenv("LATEX_TIMEOUT", "20"))
# CPU-bound and pure process: an unbounded burst is an OOMKilled pod, not a slow preview.
COMPILE_CONCURRENCY = int(os.getenv("LATEX_CONCURRENCY", "2"))
QUEUE_WAIT = float(os.getenv("LATEX_QUEUE_WAIT", "5"))
# Measured on this image (TeX Live 2025): a one-page resume peaks at 27MB RSS and compiles inside
# 128MB of address space. This is the runaway
# ceiling, and it has to stay under the pod's memory limit minus the app, or a greedy document kills the
# pod (in-flight SSE included) instead of failing its own compile.
MEMORY_MB = int(os.getenv("LATEX_MEMORY_MB", "192"))
MAX_STDOUT = 4000
LOG_TAIL = 1200

_slots = asyncio.Semaphore(COMPILE_CONCURRENCY)

# -no-shell-escape: no \write18, so the document cannot run a command.
# cnf openin_any/openout_any=p: paranoid, so \input cannot read outside the compile dir.
# -halt-on-error/-file-line-error: the first error is the one worth showing, and it carries its line.
ARGS = ("-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-cnf-line=openin_any=p", "-cnf-line=openout_any=p", "main.tex")


class CompileError(Exception):
    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class CompileBusy(Exception): ...


def available() -> bool:
    return bool(PDFLATEX)


def _limit() -> None:
    # Per-child, not per-pod: a runaway expansion dies here instead of taking the worker with it.
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_MB * 1024 * 1024, MEMORY_MB * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (int(COMPILE_TIMEOUT), int(COMPILE_TIMEOUT)))


def _first_error(log_text: str) -> str:
    lines = [line.strip() for line in log_text.splitlines() if line.strip()]
    for line in lines:
        if line.startswith("!") or ".tex:" in line:
            return line[:LOG_TAIL]
    # A document that compiles to nothing is not a compiler fault, and "Transcript written on main.log"
    # is the only line pdflatex leaves behind when the body is empty.
    if "No pages of output" in log_text:
        return "This document produces no pages: nothing is inside the body."
    return (lines[-1] if lines else "pdflatex failed without a message.")[:LOG_TAIL]


async def _run(source: str) -> bytes:
    with tempfile.TemporaryDirectory(prefix="latex-") as tmp:
        workdir = Path(tmp)
        (workdir / "main.tex").write_text(source, encoding="utf-8")
        proc = await asyncio.create_subprocess_exec(
            PDFLATEX,
            *ARGS,
            cwd=str(workdir),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={"PATH": os.getenv("PATH", "/usr/bin:/bin"), "HOME": str(workdir), "TEXMFVAR": str(workdir / ".texmf")},
            preexec_fn=_limit,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=COMPILE_TIMEOUT)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            log.warning("latex.compile.timeout")
            raise CompileError(f"pdflatex ran longer than {int(COMPILE_TIMEOUT)}s. Check the document for a runaway command.") from None
        text = out.decode("utf-8", "replace")[:MAX_STDOUT]
        pdf = workdir / "main.pdf"
        if proc.returncode != 0 or not pdf.exists():
            log.info("latex.compile.failed", returncode=proc.returncode, chars=len(text))
            raise CompileError(_first_error(text))
        log.info("latex.compile.ok", bytes=pdf.stat().st_size)
        return pdf.read_bytes()


async def compile_pdf(source: str) -> bytes:
    if not available():
        raise CompileError("No LaTeX engine is installed on this deployment.")
    # A preview is a keystroke behind, not a job worth queueing for: past the wait the honest answer is
    # "busy", because a queue of compiles is a queue of requests the client has already given up on.
    try:
        await asyncio.wait_for(_slots.acquire(), timeout=QUEUE_WAIT)
    except TimeoutError:
        log.info("latex.compile.busy")
        raise CompileBusy from None
    try:
        return await _run(source)
    finally:
        _slots.release()


# AI HERE: one engine, one file, one pass. Ceiling: a resume that needs bibtex or a second pass will
# render with unresolved references. Upgrade path: run the pass twice and bibtex between, keyed on the
# log asking for a rerun. The rlimits and `preexec_fn` are POSIX only, which is what the image is.
assert all(flag.startswith("-") for flag in ARGS[:-1]) and ARGS[-1] == "main.tex"
