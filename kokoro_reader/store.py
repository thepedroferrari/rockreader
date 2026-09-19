"""On-disk storage: one folder per document with its segments, audio cache and reading position."""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

DATA_DIR = Path(os.environ.get("KOKORO_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
DOCS_DIR = DATA_DIR / "docs"

# Guards every read-modify-write of meta.json. Concurrent position and voice
# updates from the UI otherwise interleave their writes and corrupt the file.
META_LOCK = threading.RLock()


@dataclass
class DocMeta:
    id: str
    title: str
    filename: str
    created: float
    segment_count: int
    voice: str = "af_heart"
    position: dict = field(default_factory=lambda: {"segment": 0, "offset": 0.0})


def doc_dir(doc_id: str) -> Path:
    if not doc_id.isalnum():
        raise ValueError("bad id")
    return DOCS_DIR / doc_id


def audio_path(doc_id: str, voice: str, index: int) -> Path:
    return doc_dir(doc_id) / "audio" / voice / f"{index:05d}.wav"


def create_doc(title: str, filename: str, segments: list[str], source: Path, voice: str) -> DocMeta:
    doc_id = secrets.token_hex(6)
    d = doc_dir(doc_id)
    (d / "audio").mkdir(parents=True)
    (d / f"source{source.suffix}").write_bytes(source.read_bytes())
    (d / "segments.json").write_text(json.dumps(segments, ensure_ascii=False))
    meta = DocMeta(id=doc_id, title=title, filename=filename, created=time.time(), segment_count=len(segments), voice=voice)
    save_meta(meta)
    return meta


def create_text_doc(title: str, source: str, segments: list[str], text: str, voice: str) -> DocMeta:
    doc_id = secrets.token_hex(6)
    d = doc_dir(doc_id)
    (d / "audio").mkdir(parents=True)
    (d / "source.txt").write_text(text)
    (d / "segments.json").write_text(json.dumps(segments, ensure_ascii=False))
    meta = DocMeta(id=doc_id, title=title, filename=source, created=time.time(), segment_count=len(segments), voice=voice)
    save_meta(meta)
    return meta


def save_meta(meta: DocMeta) -> None:
    with META_LOCK:
        tmp = doc_dir(meta.id) / f"meta.{secrets.token_hex(4)}.tmp"
        tmp.write_text(json.dumps(asdict(meta)))
        tmp.replace(doc_dir(meta.id) / "meta.json")


def load_meta(doc_id: str) -> DocMeta:
    with META_LOCK:
        return DocMeta(**json.loads((doc_dir(doc_id) / "meta.json").read_text()))


def update_meta(doc_id: str, **changes) -> DocMeta:
    """Atomic read-modify-write."""
    with META_LOCK:
        meta = load_meta(doc_id)
        for k, v in changes.items():
            setattr(meta, k, v)
        save_meta(meta)
        return meta


def load_segments(doc_id: str) -> list[str]:
    return json.loads((doc_dir(doc_id) / "segments.json").read_text())


def list_docs() -> list[DocMeta]:
    if not DOCS_DIR.exists():
        return []
    metas = []
    for d in DOCS_DIR.iterdir():
        if (d / "meta.json").exists():
            try:
                metas.append(load_meta(d.name))
            except (ValueError, TypeError):
                continue  # one damaged document must not hide the rest
    return sorted(metas, key=lambda m: m.created, reverse=True)


def delete_doc(doc_id: str) -> None:
    import shutil

    shutil.rmtree(doc_dir(doc_id), ignore_errors=True)


def generated_indices(doc_id: str, voice: str) -> set[int]:
    folder = doc_dir(doc_id) / "audio" / voice
    if not folder.exists():
        return set()
    return {int(p.stem) for p in folder.glob("*.wav")}
