#!/usr/bin/env bash
# Stream speech from the server and play it as it arrives.
# Usage: scripts/speak.sh "text to say" [voice]
set -euo pipefail
TEXT="${1:?usage: speak.sh \"text\" [voice]}"
VOICE="${2:-af_heart}"
HOST="${KOKORO_URL:-http://localhost:8880}"
command -v ffplay >/dev/null || { echo "ffplay missing: brew install ffmpeg" >&2; exit 1; }

curl -sN -X POST "$HOST/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"input":sys.argv[1],"voice":sys.argv[2],"stream":True,"response_format":"wav"}))' "$TEXT" "$VOICE")" \
  | ffplay -nodisp -autoexit -loglevel error -i -
