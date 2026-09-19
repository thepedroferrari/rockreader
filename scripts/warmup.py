"""Download the Kokoro weights and run one synthesis so the first real request is fast."""

import time

from mlx_audio.tts.utils import load_model

MODEL = "mlx-community/Kokoro-82M-bf16"

t0 = time.time()
model = load_model(MODEL)
print(f"model loaded in {time.time() - t0:.1f}s")

t0 = time.time()
for result in model.generate(text="Warm up complete.", voice="af_heart", lang_code="a"):
    print(f"generated {result.audio.shape[0] / result.sample_rate:.2f}s of audio in {time.time() - t0:.2f}s")
