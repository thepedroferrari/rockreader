"""Build kokoro_reader/voices.json: one entry per voice with accent, gender, official grade,
and character words measured from a synthesised sample (pitch, pitch movement, pace).

Run once after a model update: uv run python scripts/build_voice_catalog.py
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np

from kokoro_reader.synth import SAMPLE_RATE, Synth

OUT = Path(__file__).resolve().parent.parent / "kokoro_reader" / "voices.json"

# Overall grade from the model card (hexgrad/Kokoro-82M VOICES.md). Missing = ungraded.
GRADES = {
    "af_heart": "A", "af_bella": "A-", "af_nicole": "B-", "af_aoede": "C+", "af_kore": "C+", "af_sarah": "C+",
    "af_alloy": "C", "af_nova": "C", "af_sky": "C-", "af_jessica": "D", "af_river": "D",
    "am_fenrir": "C+", "am_michael": "C+", "am_puck": "C+", "am_echo": "D", "am_eric": "D", "am_liam": "D",
    "am_onyx": "D", "am_santa": "D-", "am_adam": "F+",
    "bf_emma": "B-", "bf_isabella": "C", "bf_alice": "D", "bf_lily": "D",
    "bm_fable": "C", "bm_george": "C", "bm_lewis": "D+", "bm_daniel": "D",
    "jf_alpha": "C+", "jf_gongitsune": "C", "jf_tebukuro": "C", "jf_nezumi": "C-", "jm_kumo": "C-",
    "zf_xiaobei": "D", "zf_xiaoni": "D", "zf_xiaoxiao": "D", "zf_xiaoyi": "D",
    "zm_yunjian": "D", "zm_yunxi": "D", "zm_yunxia": "D", "zm_yunyang": "D",
    "ff_siwis": "B-", "hf_alpha": "C", "hf_beta": "C", "hm_omega": "C", "hm_psi": "C", "if_sara": "C", "im_nicola": "C",
}
LANG = {"a": "American English", "b": "British English", "e": "Spanish", "f": "French", "h": "Hindi",
        "i": "Italian", "j": "Japanese", "p": "Portuguese", "z": "Mandarin"}
SAMPLES = {
    "a": "The committee reviewed the evidence carefully, and after some discussion, agreed to publish the findings next spring.",
    "b": "The committee reviewed the evidence carefully, and after some discussion, agreed to publish the findings next spring.",
    "e": "El comité revisó las pruebas con cuidado y, tras cierta discusión, acordó publicar los resultados la próxima primavera.",
    "f": "Le comité a examiné les preuves avec soin et, après discussion, a décidé de publier les résultats au printemps prochain.",
    "h": "समिति ने साक्ष्यों की सावधानी से समीक्षा की और कुछ चर्चा के बाद अगले वसंत में निष्कर्ष प्रकाशित करने पर सहमति जताई।",
    "i": "Il comitato ha esaminato attentamente le prove e, dopo una discussione, ha deciso di pubblicare i risultati la prossima primavera.",
    "j": "委員会は証拠を慎重に検討し、議論の末、来春に調査結果を公表することで合意した。",
    "p": "O comitê analisou as evidências com cuidado e, após alguma discussão, concordou em publicar os resultados na próxima primavera.",
    "z": "委员会仔细审查了证据，经过讨论后，同意在明年春天发布调查结果。",
}


def pitch_track(audio: np.ndarray, sr: int) -> np.ndarray:
    """Median-free F0 estimate per 40 ms frame via autocorrelation. Returns voiced frames only."""
    frame, hop = int(0.04 * sr), int(0.02 * sr)
    lo, hi = int(sr / 400), int(sr / 60)  # 60-400 Hz
    f0s = []
    for start in range(0, len(audio) - frame, hop):
        x = audio[start : start + frame]
        if np.sqrt(np.mean(x**2)) < 0.02:
            continue  # silence
        x = x - x.mean()
        ac = np.correlate(x, x, mode="full")[frame - 1 :]
        if ac[0] <= 0:
            continue
        ac = ac / ac[0]
        seg = ac[lo:hi]
        k = int(np.argmax(seg)) + lo
        if ac[k] > 0.5:
            f0s.append(sr / k)
    return np.array(f0s)


def describe(f0: np.ndarray, seconds: float, words: int, gender: str) -> tuple[list[str], dict]:
    words_out: list[str] = []
    med = float(np.median(f0)) if len(f0) else 0.0
    spread = float(np.std(f0) / med) if med else 0.0  # relative pitch movement
    wps = words / seconds if seconds else 0.0
    # Pitch bands differ by gender: a "deep" male voice sits far below a "deep" female one.
    bands = [(105, "deep"), (135, "low"), (170, "mid-range")] if gender == "male" else [(165, "deep"), (195, "low"), (230, "mid-range")]
    words_out.append(next((label for limit, label in bands if med < limit), "high"))
    words_out.append("flat" if spread < 0.14 else "steady" if spread < 0.20 else "expressive" if spread < 0.27 else "lively")
    words_out.append("slow" if wps < 2.3 else "measured" if wps < 2.75 else "brisk" if wps < 3.1 else "fast")
    return words_out, {"pitch_hz": round(med), "pitch_spread": round(spread, 3), "words_per_sec": round(wps, 2)}


def main() -> None:
    synth = Synth()
    synth.load()
    catalog = []
    for voice in synth.voices():
        lang, gender = voice[0], "female" if voice[1] == "f" else "male"
        text = SAMPLES[lang]
        t0 = time.time()
        try:
            audio = synth.synth(text, voice)
        except ImportError as e:
            # Japanese and Mandarin need misaki[ja] / misaki[zh]; hide the voice until installed.
            print(f"{voice:14s} unavailable: {str(e).splitlines()[0][:80]}")
            catalog.append({"id": voice, "name": voice.split("_", 1)[1].capitalize(), "language": LANG[lang], "lang_code": lang,
                            "gender": gender, "grade": GRADES.get(voice), "character": [], "metrics": {}, "available": False})
            continue
        seconds = len(audio) / SAMPLE_RATE
        words = len(text.split()) if lang not in "jz" else int(len(text) / 2.5)  # rough word count for CJK
        f0 = pitch_track(audio, SAMPLE_RATE)
        character, metrics = describe(f0, seconds, words, gender)
        catalog.append({
            "id": voice,
            "name": voice.split("_", 1)[1].capitalize(),
            "language": LANG[lang],
            "lang_code": lang,
            "gender": gender,
            "grade": GRADES.get(voice),
            "character": character,
            "metrics": metrics,
            "available": True,
        })
        print(f"{voice:14s} {gender:6s} {GRADES.get(voice) or '-':3s} {', '.join(character):28s} {metrics}  ({time.time()-t0:.1f}s)")
    OUT.write_text(json.dumps(catalog, ensure_ascii=False, indent=1))
    print(f"wrote {OUT} ({len(catalog)} voices)")


if __name__ == "__main__":
    main()
