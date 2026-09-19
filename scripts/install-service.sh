#!/usr/bin/env bash
# Register the server as a user launchd service so it starts at login and restarts if it crashes.
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents/com.rockreader.plist"
mkdir -p "$PROJECT_DIR/logs" "$HOME/Library/LaunchAgents"
sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$PROJECT_DIR/launchd/com.rockreader.plist" > "$DEST"
launchctl bootout "gui/$(id -u)" "$DEST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "Service installed and started. Logs: $PROJECT_DIR/logs/"
echo "Stop:  launchctl bootout gui/$(id -u) $DEST"
