#!/usr/bin/env bash
#
# Capture the #2202 board-rendering spike on a running Android emulator.
#
#   packages/mobile/scripts/spike/capture-boards.sh <output-dir> [treatments...]
#
# Requires: the emulator up, the dev client connected to Metro, and the spike
# route reachable. See docs/spike/board-rendering-2202/HANDOVER.md for the full
# sequence — this script only does the capture loop.
#
# Writes <output-dir>/<board>__<treatment>.png, one full-screen capture each.
set -euo pipefail

ADB="${ADB:-$HOME/.cache/boardsesh/android-sdk/platform-tools/adb}"
PACKAGE="${PACKAGE:-com.boardsesh.app.dev}"
OUT="${1:?usage: capture-boards.sh <output-dir> [treatments...]}"
shift || true

BOARDS="${BOARDS:-grasshopper-master tension-classic tension-mirror-12x12 kilter-homewall-10x12 kilter-original-12x12 moonboard-2016 moonboard-masters-2019}"
TREATMENTS="${*:-baseline traced-ring outward-glow glow-tint}"

mkdir -p "$OUT"
for board in $BOARDS; do
  for treatment in $TREATMENTS; do
    # Single-quote the URI for the DEVICE shell: adb concatenates arguments into
    # one command string, so an unquoted & backgrounds the command there and every
    # query parameter after the first is silently dropped.
    "$ADB" shell "am start -a android.intent.action.VIEW \
      -d 'com.boardsesh.app:///board-spike?board=${board}&treatment=${treatment}' ${PACKAGE}" >/dev/null 2>&1
    sleep 4.5
    "$ADB" exec-out screencap -p > "${OUT}/${board}__${treatment}.png"
    echo "captured ${board} ${treatment}"
  done
done
