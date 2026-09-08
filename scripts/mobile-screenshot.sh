#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."

if ! command -v xcrun &>/dev/null || ! xcrun simctl list devices &>/dev/null 2>&1; then
  echo "[mobile-screenshot] Skipped: iOS simulator not available."
  exit 0
fi

# Resolve once and hold ownership across the entire command, including launch/logs.
if [ -z "${BOARDSESH_SIMULATOR_LEASE_TOKEN:-}" ]; then
  cd "$ROOT_DIR"
  exec vp exec tsx scripts/mobile-simulator-lease.ts bash "$SCRIPT_DIR/mobile-screenshot.sh" "$@"
fi
vp exec tsx "$SCRIPT_DIR/mobile-simulator-lease.ts" --assert-only

DELAY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delay)
      DELAY="${2:?'--delay requires a value in seconds'}"
      shift 2
      ;;
    *)
      echo "[mobile-screenshot] Unknown argument: $1"
      exit 1
      ;;
  esac
done

BOOTED_DEVICES="$(xcrun simctl list devices booted 2>/dev/null | grep -c 'Booted' || true)"
if [ "$BOOTED_DEVICES" -eq 0 ]; then
  echo "[mobile-screenshot] Skipped: No simulator is booted. Start the app first with 'vp run check:mobile-simulator'."
  exit 0
fi

if [ "$DELAY" -gt 0 ]; then
  echo "[mobile-screenshot] Waiting ${DELAY}s before capture..."
  sleep "$DELAY"
fi

SCREENSHOT_DIR="$ROOT_DIR/.boardsesh/screenshots"
mkdir -p "$SCREENSHOT_DIR"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
SCREENSHOT_PATH="$SCREENSHOT_DIR/mobile-${TIMESTAMP}.png"

xcrun simctl io "$BOARDSESH_IOS_SIMULATOR_UDID" screenshot "$SCREENSHOT_PATH"

echo "[mobile-screenshot] Saved: .boardsesh/screenshots/mobile-${TIMESTAMP}.png"
exit 0
