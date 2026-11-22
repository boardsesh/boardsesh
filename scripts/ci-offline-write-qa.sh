#!/usr/bin/env bash
# CI starts only its own Metro process. The driver owns the device lease and
# verifies an actual runtime reload inside the same native process.
set -euo pipefail

platform="${1:?platform is required}"
device="${2:?explicit device is required}"
app_path="${3:?matching native dev client is required}"
case "$platform" in android|ios) ;; *) echo "Unsupported platform: $platform" >&2; exit 1 ;; esac

output_dir="$PWD/.boardsesh/offline-write-qa/$platform"
mkdir -p "$output_dir" "$PWD/.boardsesh/tmp/offline-write-qa"
export TMPDIR="$PWD/.boardsesh/tmp/offline-write-qa"
export BOARDSESH_METRO_PORT="${BOARDSESH_METRO_PORT:-8095}"
export CI=1
export EXPO_PUBLIC_OFFLINE_WRITE_QA=1
# The isolated route must use native SQLite, never capture/replay shortcuts.
unset EXPO_PUBLIC_SCREENSHOT_MODE EXPO_PUBLIC_STORY_MODE

cat > .boardsesh/qa-notes.md <<'QA'
Open the isolated offline-write checks on the dedicated test device.
Ticks, favorites and follows survive reopening their test database.
Reload during a held write; committed saves survive and interrupted saves roll back.
The new runtime saves another tick without restarting the app process.
A deliberate prolonged lock reports failure, then releases for another save.
QA

metro_pid=""
cleanup() {
  if [ -n "$metro_pid" ]; then kill -TERM "$metro_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
vp run dev:mobile -- --host localhost --port "$BOARDSESH_METRO_PORT" > "$output_dir/metro.log" 2>&1 &
metro_pid=$!
ready=false
for attempt in $(seq 1 180); do
  if ! kill -0 "$metro_pid" 2>/dev/null; then
    echo "Metro exited before becoming ready; see $output_dir/metro.log" >&2
    exit 1
  fi
  if curl --silent --fail --max-time 2 "http://127.0.0.1:$BOARDSESH_METRO_PORT/status" | grep -q 'packager-status:running'; then
    ready=true
    break
  fi
  sleep 2
done
if [ "$ready" != true ]; then echo "Metro readiness timed out" >&2; exit 1; fi
if ! grep -Fq '[dev:mobile] QA notes:' "$output_dir/metro.log"; then
  echo "Metro did not confirm the QA notes file" >&2
  exit 1
fi
vp exec tsx scripts/mobile-offline-write-qa.ts --platform "$platform" --device "$device" --app-path "$app_path" --output-dir "$output_dir"
