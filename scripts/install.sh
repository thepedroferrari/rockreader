#!/usr/bin/env bash
# One-shot setup on a fresh Mac (Apple Silicon). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v brew >/dev/null; then
  echo "Homebrew missing. Install from https://brew.sh then re-run." >&2; exit 1
fi
command -v uv >/dev/null || brew install uv
# espeak-ng is the fallback phonemizer. English works without it; other languages need it.
brew list espeak-ng >/dev/null 2>&1 || brew install espeak-ng

uv python install 3.12
uv sync

echo "Downloading model weights and warming up (first run only)..."
uv run python scripts/warmup.py
echo "Done. Start with scripts/serve.sh, or scripts/install-service.sh to run at login."
