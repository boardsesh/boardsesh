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
#
# BOARDS and TREATMENTS narrow the matrix. FIELDS and PALETTES add the two axes
# the deep link carries but the default run holds fixed — the play field #1449
# asked for, and the role hues:
#
#   FIELDS='field grey' capture-boards.sh /tmp/shots baseline outward-glow
#
# Each combination lands in its own subdirectory (field-grey,
# field-grey__palette-equalL) keeping the filenames build-figures.mjs reads, so
# point that at one subdirectory and give it that field's hex. Left unset, the
# links and the filenames are the ones this script has always emitted — but the
# screen keeps the last field it was handed, so after a run that varied one,
# name the field you want rather than relying on the default.
set -euo pipefail

ADB="${ADB:-$HOME/.cache/boardsesh/android-sdk/platform-tools/adb}"
PACKAGE="${PACKAGE:-com.boardsesh.app.dev}"
OUT="${1:?usage: capture-boards.sh <output-dir> [treatments...]}"
shift || true

BOARDS="${BOARDS:-grasshopper-master tension-classic tension-mirror-12x12 kilter-homewall-10x12 kilter-original-12x12 moonboard-2016 moonboard-masters-2019}"
TREATMENTS="${*:-baseline outward-glow glow-tint}"
# `none` is the sentinel for "leave this axis to the screen" — no board or
# palette key is called that — and it is the default, so an unset FIELDS still
# runs the loop once with the parameter omitted.
FIELDS="${FIELDS:-none}"
PALETTES="${PALETTES:-none}"

for field in $FIELDS; do
  for palette in $PALETTES; do
    axes=''
    subdir=''
    if [ "$field" != none ]; then
      axes="${axes}&field=${field}"
      subdir="${subdir}__field-${field}"
    fi
    if [ "$palette" != none ]; then
      axes="${axes}&palette=${palette}"
      subdir="${subdir}__palette-${palette}"
    fi
    dir="${OUT}${subdir:+/${subdir#__}}"

    mkdir -p "$dir"
    for board in $BOARDS; do
      for treatment in $TREATMENTS; do
        uri="com.boardsesh.app:///board-spike?board=${board}&treatment=${treatment}${axes}"
        # Single-quote the URI for the DEVICE shell: adb concatenates arguments into
        # one command string, so an unquoted & backgrounds the command there and every
        # query parameter after the first is silently dropped.
        "$ADB" shell "am start -a android.intent.action.VIEW -d '${uri}' ${PACKAGE}" >/dev/null 2>&1
        sleep 4.5
        "$ADB" exec-out screencap -p > "${dir}/${board}__${treatment}.png"
        echo "captured ${board} ${treatment}${subdir:+ ${subdir#__}}"
      done
    done
  done
done
