"""FastAPI app: the reader UI, its JSON API, and an OpenAI-style streaming speech endpoint."""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import store
from .extract import document_segments
from .synth import Synth, Worker, to_pcm16, wav_header

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)

STATIC = Path(__file__).parent / "static"
ALLOWED = {".pdf", ".epub", ".txt", ".md", ".markdown", ".xps", ".mobi", ".fb2"}

synth = Synth()
worker = Worker(synth)


@asynccontextmanager
async def lifespan(app: FastAPI):
    import threading

    threading.Thread(target=synth.load, daemon=True).start()
    worker.start()
    yield


app = FastAPI(title="RockReader", lifespan=lifespan)


# ---------- documents ----------


@app.get("/api/docs")
def api_list_docs():
    return [asdict(m) for m in store.list_docs()]


@app.post("/api/docs")
async def api_upload(file: UploadFile, voice: str = "af_heart"):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED:
        raise HTTPException(400, f"unsupported file type {suffix!r}")
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = Path(tmp.name)
    try:
        title, segments = document_segments(tmp_path, Path(file.filename or 'Document').stem)
        if not segments:
            raise HTTPException(400, "no readable text found in document")
        meta = store.create_doc(title, file.filename or "upload", segments, tmp_path, voice)
    finally:
        tmp_path.unlink(missing_ok=True)
    worker.focus(meta.id, 0)
    return asdict(meta)


@app.get("/api/docs/{doc_id}")
def api_doc(doc_id: str):
    try:
        meta = store.load_meta(doc_id)
    except FileNotFoundError:
        raise HTTPException(404)
    return {"meta": asdict(meta), "segments": store.load_segments(doc_id)}


@app.delete("/api/docs/{doc_id}")
def api_delete(doc_id: str):
    store.delete_doc(doc_id)
    return {"ok": True}


class Position(BaseModel):
    segment: int
    offset: float = 0.0


@app.put("/api/docs/{doc_id}/position")
def api_position(doc_id: str, pos: Position):
    meta = store.load_meta(doc_id)
    meta.position = {"segment": max(0, min(pos.segment, meta.segment_count - 1)), "offset": max(0.0, pos.offset)}
    store.save_meta(meta)
    worker.focus(doc_id, meta.position["segment"])
    return meta.position


class VoiceChange(BaseModel):
    voice: str


@app.put("/api/docs/{doc_id}/voice")
def api_voice(doc_id: str, body: VoiceChange):
    if body.voice not in synth.voices():
        raise HTTPException(400, "unknown voice")
    meta = store.load_meta(doc_id)
    meta.voice = body.voice
    store.save_meta(meta)
    worker.focus(doc_id, meta.position["segment"])
    return {"voice": meta.voice}


@app.get("/api/docs/{doc_id}/status")
def api_status(doc_id: str):
    meta = store.load_meta(doc_id)
    done = store.generated_indices(doc_id, meta.voice)
    cur = worker.current
    return {
        "generated": sorted(done),
        "total": meta.segment_count,
        "generating": cur[1] if cur and cur[0] == doc_id else None,
        "voice": meta.voice,
    }


@app.get("/api/docs/{doc_id}/audio/{index}")
def api_audio(doc_id: str, index: int):
    meta = store.load_meta(doc_id)
    p = store.audio_path(doc_id, meta.voice, index)
    if not p.exists():
        raise HTTPException(404, "not generated yet")
    return FileResponse(p, media_type="audio/wav", headers={"Cache-Control": "no-cache"})


@app.get("/api/docs/{doc_id}/export")
def api_export(doc_id: str):
    """Concatenate every generated segment into one MP3 with ffmpeg."""
    meta = store.load_meta(doc_id)
    done = store.generated_indices(doc_id, meta.voice)
    if len(done) < meta.segment_count:
        raise HTTPException(409, f"only {len(done)}/{meta.segment_count} segments generated")
    if not shutil.which("ffmpeg"):
        raise HTTPException(500, "ffmpeg not installed (brew install ffmpeg)")
    out = store.doc_dir(doc_id) / f"{meta.voice}.mp3"
    if not out.exists():
        listing = store.doc_dir(doc_id) / "concat.txt"
        listing.write_text("".join(f"file '{store.audio_path(doc_id, meta.voice, i)}'\n" for i in range(meta.segment_count)))
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-b:a", "96k", str(out)],
            check=True,
        )
    safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in meta.title)[:80] or "audiobook"
    return FileResponse(out, media_type="audio/mpeg", filename=f"{safe}.mp3")


@app.get("/api/voices")
def api_voices():
    return synth.voices()


# ---------- raw speech API (OpenAI-shaped, streams PCM or WAV) ----------


class SpeechRequest(BaseModel):
    input: str
    voice: str = "af_heart"
    speed: float = 1.0
    response_format: str = "wav"  # "wav" or "pcm" (16-bit mono 24 kHz)
    model: str = "kokoro"


@app.post("/v1/audio/speech")
def api_speech(req: SpeechRequest):
    if req.response_format not in {"wav", "pcm"}:
        raise HTTPException(400, "response_format must be wav or pcm")

    def gen():
        if req.response_format == "wav":
            yield wav_header()
        for chunk in synth.stream(req.input, req.voice, req.speed):
            yield to_pcm16(chunk)

    return StreamingResponse(gen(), media_type=f"audio/{req.response_format}")


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
