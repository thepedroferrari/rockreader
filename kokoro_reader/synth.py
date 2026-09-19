"""Kokoro model wrapper plus a background worker that fills the audio cache.

The worker always generates from the listener's current position forward, so
jumping around the document reprioritises what gets synthesised next.
"""

from __future__ import annotations

import logging
import threading
import wave
from pathlib import Path
from typing import Iterator

import numpy as np

from . import store

log = logging.getLogger(__name__)

MODEL_ID = "mlx-community/Kokoro-82M-bf16"
SAMPLE_RATE = 24000
_LANG_BY_PREFIX = {"a": "a", "b": "b", "e": "e", "f": "f", "h": "h", "i": "i", "j": "j", "p": "p", "z": "z"}


class Synth:
    def __init__(self) -> None:
        self._model = None
        self._lock = threading.Lock()

    def load(self) -> None:
        from mlx_audio.tts.utils import load_model

        with self._lock:
            if self._model is None:
                log.info("loading %s", MODEL_ID)
                self._model = load_model(MODEL_ID)

    def voices(self) -> list[str]:
        from huggingface_hub import snapshot_download

        p = Path(snapshot_download(MODEL_ID, allow_patterns=["voices/*.safetensors"])) / "voices"
        return sorted(x.stem for x in p.glob("*.safetensors"))

    def stream(self, text: str, voice: str, speed: float = 1.0) -> Iterator[np.ndarray]:
        """Yield float32 audio chunks. Serialised: the model is not thread safe."""
        self.load()
        lang = _LANG_BY_PREFIX.get(voice[:1], "a")
        with self._lock:
            for r in self._model.generate(text=text, voice=voice, speed=speed, lang_code=lang):
                yield np.asarray(r.audio, dtype=np.float32)

    def synth(self, text: str, voice: str) -> np.ndarray:
        chunks = list(self.stream(text, voice))
        return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)


def to_pcm16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes()


def write_wav(path: Path, audio: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(to_pcm16(audio))
    tmp.replace(path)


def wav_header(nframes: int = 0x7FFFFFFF // 2) -> bytes:
    """A WAV header with an oversized length, so browsers play a stream of unknown size."""
    import io

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.setnframes(nframes)
        w.writeframes(b"")
    return buf.getvalue()


class Worker:
    """Single background thread. Generates the focused document from its position onward."""

    def __init__(self, synth: Synth) -> None:
        self.synth = synth
        self._wake = threading.Event()
        self._focus: tuple[str, int] | None = None
        self._thread = threading.Thread(target=self._run, daemon=True, name="kokoro-worker")
        self.current: tuple[str, int] | None = None

    def start(self) -> None:
        self._thread.start()

    def focus(self, doc_id: str, from_index: int) -> None:
        self._focus = (doc_id, from_index)
        self._wake.set()

    def _next_job(self) -> tuple[str, str, int, str] | None:
        """The focused document first, from its position onward. Then any other unfinished document."""
        candidates: list[tuple[str, int]] = []
        if self._focus is not None:
            candidates.append(self._focus)
        candidates += [(m.id, m.position["segment"]) for m in store.list_docs(include_ephemeral=True)]
        for doc_id, start in candidates:
            try:
                meta = store.load_meta(doc_id)
                segments = store.load_segments(doc_id)
            except FileNotFoundError:
                continue
            done = store.generated_indices(doc_id, meta.voice)
            order = list(range(start, len(segments))) + list(range(0, start))
            for i in order:
                if i not in done:
                    return doc_id, meta.voice, i, segments[i]
        return None

    def _run(self) -> None:
        while True:
            job = self._next_job()
            if job is None:
                self.current = None
                self._wake.wait(timeout=30)
                self._wake.clear()
                continue
            doc_id, voice, index, text = job
            self.current = (doc_id, index)
            try:
                audio = self.synth.synth(text, voice)
                write_wav(store.audio_path(doc_id, voice, index), audio)
            except Exception:
                log.exception("segment %s/%d failed", doc_id, index)
                write_wav(store.audio_path(doc_id, voice, index), np.zeros(SAMPLE_RATE // 4, dtype=np.float32))
