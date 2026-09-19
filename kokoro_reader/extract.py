"""Turn a document (PDF, EPUB, TXT, MD) into a list of readable text segments.

A segment is roughly one paragraph, capped in length so each one synthesizes
in a second or two and the listener can jump between them.
"""

from __future__ import annotations

import re
from pathlib import Path

import pymupdf

MAX_SEGMENT_CHARS = 700
MIN_SEGMENT_CHARS = 40

_PAGE_NUMBER = re.compile(r"^\s*(?:page\s+)?\d{1,4}(?:\s*(?:of|/)\s*\d{1,4})?\s*$", re.I)
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'(\[])")
_CITATION_BRACKETS = re.compile(r"\s*\[\d+(?:[,–-]\s*\d+)*\]")
_URL = re.compile(r"https?://\S+|www\.\S+|\S+@\S+\.\w+")


def extract_text(path: Path, fallback_title: str | None = None) -> tuple[str, str]:
    """Return (title, raw text) for a document. PyMuPDF handles PDF, EPUB, XPS, MOBI, TXT."""
    fallback = fallback_title or path.stem
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".markdown"}:
        return fallback, path.read_text(encoding="utf-8", errors="replace")
    doc = pymupdf.open(path)
    title = ((doc.metadata or {}).get("title") or "").strip()
    pages = [page.get_text("text") for page in doc]
    return title or fallback, "\n\f\n".join(pages)


def clean_text(raw: str) -> str:
    """Repair the most common PDF extraction artefacts before segmenting."""
    lines = raw.replace("\r", "").split("\n")
    kept: list[str] = []
    for line in lines:
        if _PAGE_NUMBER.match(line):
            continue
        kept.append(line.rstrip())
    text = "\n".join(kept)
    # Words split across lines with a hyphen: "informa-\ntion" -> "information".
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    # Single line breaks inside a paragraph become spaces. Blank lines stay as paragraph breaks.
    text = re.sub(r"(?<!\n)\n(?!\n)", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = _CITATION_BRACKETS.sub("", text)
    text = _URL.sub("", text)
    text = re.sub(r" {2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _split_long(paragraph: str) -> list[str]:
    if len(paragraph) <= MAX_SEGMENT_CHARS:
        return [paragraph]
    sentences = _SENTENCE_END.split(paragraph)
    out: list[str] = []
    buf = ""
    for s in sentences:
        if buf and len(buf) + len(s) + 1 > MAX_SEGMENT_CHARS:
            out.append(buf)
            buf = s
        else:
            buf = f"{buf} {s}".strip()
    if buf:
        out.append(buf)
    return out


def segment(text: str) -> list[str]:
    """Split cleaned text into segments. Tiny fragments (headings, stray numbers) are merged forward."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n|\f", text) if p.strip()]
    segments: list[str] = []
    carry = ""
    for p in paragraphs:
        p = re.sub(r"\s+", " ", p)
        if carry:
            # A heading merged into its paragraph gets a full stop so the voice pauses.
            sep = " " if carry.endswith((".", ":", "!", "?")) else ". "
            p = f"{carry}{sep}{p}"
            carry = ""
        if len(p) < MIN_SEGMENT_CHARS:
            carry = p
            continue
        segments.extend(_split_long(p))
    if carry:
        if segments:
            segments[-1] = f"{segments[-1]} {carry}"
        else:
            segments.append(carry)
    return segments


def document_segments(path: Path, fallback_title: str | None = None) -> tuple[str, list[str]]:
    title, raw = extract_text(path, fallback_title)
    return title, segment(clean_text(raw))
