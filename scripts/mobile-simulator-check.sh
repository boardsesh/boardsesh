#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."
MOBILE_DIR="$ROOT_DIR/packages/mobile"

if ! command -v xcrun &>/dev/null || ! xcrun simctl list devices &>/dev/null 2>&1; then
  echo "[mobile-sim] Skipped: iOS simulator not available (no xcrun simctl). Use 'vp run check:mobile-bundle' for headless validation."
  exit 0
fi

if [ ! -d "$MOBILE_DIR" ]; then
  echo "[mobile-sim] FAILED: packages/mobile/ not found at $MOBILE_DIR"
  exit 1
fi

cd "$ROOT_DIR"

echo "[mobile-sim] Building and launching on iOS simulator (shared-cache expo run:ios)..."

if ! tsx scripts/mobile-ios-run.ts 2>&1; then
  echo "[mobile-sim] FAILED: mobile iOS build exited with an error"
  exit 1
fi

mkdir -p "$ROOT_DIR/.boardsesh"

LOG_FILE="$ROOT_DIR/.boardsesh/mobile-device.log"

echo "[mobile-sim] Capturing 30s of device logs..."

xcrun simctl spawn booted log stream \
  --predicate 'subsystem == "com.boardsesh.app"' \
  --timeout 30 \
  > "$LOG_FILE" 2>&1 || true

if grep -qiE '(FATAL|fatal error|crash|EXC_BAD_ACCESS|EXC_CRASH|SIGABRT)' "$LOG_FILE" 2>/dev/null; then
  echo "[mobile-sim] FAILED: Crash/fatal patterns detected in device logs. Review .boardsesh/mobile-device.log"
  exit 1
fi

echo "[mobile-sim] Build successful, 30s of device logs captured to .boardsesh/mobile-device.log"
exit 0
