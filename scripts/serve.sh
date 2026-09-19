#!/usr/bin/env bash
# Start RockReader (web UI + JSON API + /v1/audio/speech streaming endpoint).
set -euo pipefail
cd "$(dirname "$0")/.."
export KOKORO_HOST="${KOKORO_HOST:-0.0.0.0}"
export KOKORO_PORT="${KOKORO_PORT:-8880}"
mkdir -p logs data
exec uv run uvicorn kokoro_reader.app:app --host "$KOKORO_HOST" --port "$KOKORO_PORT" --no-access-log
