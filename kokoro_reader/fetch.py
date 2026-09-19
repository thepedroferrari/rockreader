"""Fetch a URL and return either a downloaded file (PDF and friends) or extracted article text."""

from __future__ import annotations

import re
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import httpx
import trafilatura

USER_AGENT = "Mozilla/5.0 (Macintosh) RockReader/0.1"
MAX_BYTES = 50 * 1024 * 1024
_ARXIV_ABS = re.compile(r"^https?://arxiv\.org/abs/([\w.]+)(v\d+)?", re.I)


class FetchError(Exception):
    pass


_ARXIV_PDF = re.compile(r"^https?://arxiv\.org/pdf/([\w.]+?)(v\d+)?(?:\.pdf)?$", re.I)
_KNOWN_SUFFIXES = {".pdf", ".epub", ".txt", ".md", ".html", ".htm"}


def normalize(url: str) -> str:
    url = url.strip()
    if not urlparse(url).scheme:
        url = "https://" + url
    m = _ARXIV_ABS.match(url)
    if m:
        return f"https://arxiv.org/pdf/{m.group(1)}{m.group(2) or ''}"
    return url


def _arxiv_title(client: httpx.Client, url: str) -> str | None:
    m = _ARXIV_PDF.match(url)
    if not m:
        return None
    try:
        r = client.get(f"https://export.arxiv.org/api/query?id_list={m.group(1)}")
        t = re.search(r"<entry>.*?<title>(.*?)</title>", r.text, re.S)
        return re.sub(r"\s+", " ", t.group(1)).strip() if t else None
    except httpx.HTTPError:
        return None


def fetch(url: str) -> tuple[str, Path | None, str | None]:
    """Return (title, file_path, text). Exactly one of file_path / text is set."""
    url = normalize(url)
    try:
        with httpx.Client(follow_redirects=True, timeout=30, headers={"User-Agent": USER_AGENT}) as c:
            r = c.get(url)
            r.raise_for_status()
            arxiv_title = _arxiv_title(c, url)
    except httpx.HTTPError as e:
        raise FetchError(f"could not fetch {url}: {e}") from e
    if len(r.content) > MAX_BYTES:
        raise FetchError("file larger than 50 MB")

    ctype = r.headers.get("content-type", "").split(";")[0].strip().lower()
    path_suffix = Path(urlparse(str(r.url)).path).suffix.lower()
    name = Path(urlparse(str(r.url)).path).name
    fallback_title = arxiv_title or (Path(name).stem if path_suffix in _KNOWN_SUFFIXES else name) or urlparse(str(r.url)).netloc

    if ctype == "application/pdf" or path_suffix == ".pdf" or r.content[:5] == b"%PDF-":
        return _save(r.content, ".pdf", fallback_title)
    if ctype == "application/epub+zip" or path_suffix == ".epub":
        return _save(r.content, ".epub", fallback_title)
    if ctype.startswith("text/plain") or path_suffix in {".txt", ".md"}:
        return fallback_title, None, r.text

    extracted = trafilatura.extract(
        r.text, url=str(r.url), include_comments=False, include_tables=False, favor_precision=True
    )
    if not extracted or len(extracted) < 200:
        raise FetchError("no readable article text found on that page (try the browser extension for pages that need a login or JavaScript)")
    meta = trafilatura.extract_metadata(r.text, default_url=str(r.url))
    title = (meta.title if meta and meta.title else None) or fallback_title
    return title, None, extracted


def _save(content: bytes, suffix: str, title: str) -> tuple[str, Path, None]:
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.write(content)
    tmp.close()
    return title, Path(tmp.name), None
