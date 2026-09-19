"""Minimal client: POST text, receive audio chunks as they are produced.

Run: uv run python examples/stream_client.py "Hello there" out.wav
Uses only the standard library so it can be copied anywhere.
"""

import json
import sys
import time
import urllib.request

URL = "http://localhost:8880/v1/audio/speech"
MODEL = "kokoro"


def stream(text: str, voice: str = "af_heart", fmt: str = "wav"):
    body = json.dumps(
        {
            "model": MODEL,
            "input": text,
            "voice": voice,
            "stream": True,
            
            "response_format": fmt,
        }
    ).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        while chunk := resp.read(4096):
            yield chunk


if __name__ == "__main__":
    text = sys.argv[1] if len(sys.argv) > 1 else "The quick brown fox jumps over the lazy dog."
    out = sys.argv[2] if len(sys.argv) > 2 else "out.wav"
    t0 = time.time()
    first = None
    total = 0
    with open(out, "wb") as f:
        for chunk in stream(text):
            if first is None:
                first = time.time() - t0
            total += len(chunk)
            f.write(chunk)
    print(f"first byte after {first:.2f}s, {total} bytes total in {time.time() - t0:.2f}s -> {out}")
