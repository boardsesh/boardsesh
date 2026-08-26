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
# Writes <output-dir>[/<axis-dir>]/<board>__<treatment>.png, one full-screen
# capture each.
#
# BOARDS and TREATMENTS narrow the matrix. FIELDS, PALETTES, GLYPHS and SIZES
# vary the four axes the default run holds at the product default — the play
# field #1449 asked for, the role hues, the opt-in accessibility glyphs, and the
# width the board is rendered at:
#
#   BOARDS='grasshopper-master kilter-homewall-10x12' FIELDS='field grey light' \
#     capture-boards.sh /tmp/shots baseline outward-glow veil-glow
#   GLYPHS='off on' capture-boards.sh /tmp/shots outward-glow
#   THUMBS=1 capture-boards.sh /tmp/shots
#
# A value that is NOT the axis default lands in its own subdirectory
# (glyphs-on, size-152, field-grey__palette-equalL), keeping the filenames
# build-figures.mjs reads; the default value writes into <output-dir> itself. So
# a run that varies nothing is flat, a run that varies one axis keeps its own
# control beside it in the root, and build-figures.mjs builds the same paths from
# the same rule. Point that script at the root and give it the field the run was
# taken on:
#
#   build-figures.mjs /tmp/shots /tmp/figures field
#
# A run that NARROWED the matrix has to say so, or the first sheet demands a
# capture it never took and nothing is written — pass the same narrowing through:
#
#   BOARDS='grasshopper-master kilter-homewall-10x12' ARMS='baseline outward-glow veil-glow' \
#     build-figures.mjs /tmp/shots/field-light /tmp/figures light
set -euo pipefail

ADB="${ADB:-$HOME/.cache/boardsesh/android-sdk/platform-tools/adb}"
PACKAGE="${PACKAGE:-com.boardsesh.app.dev}"
OUT="${1:?usage: capture-boards.sh <output-dir> [treatments...]}"
shift || true

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../.." && pwd)"
FIGURES="$HERE/build-figures.mjs"

# The board, treatment, background, palette and size keys the spike screen
# actually has, printed by build-figures.mjs out of `spike-config.ts` and
# `spike-boards.ts` — the same two modules the screen itself reads. Used to pick
# the board list and to refuse a key the screen would swallow. A capture-only
# host with no node still runs, loudly, off the `*_DEFAULT` lines below.
KNOWN_KEYS=''
if command -v node >/dev/null 2>&1; then
  if ! KNOWN_KEYS="$(cd "$REPO_ROOT" && node --import tsx "$FIGURES" --keys)"; then
    echo "capture-boards.sh: '$FIGURES --keys' failed — fix that before capturing" >&2
    exit 1
  fi
else
  echo "capture-boards.sh: node not found, skipping the board/treatment key check" >&2
fi

# The four `*_DEFAULT` lines below are the matrix, and build-figures.mjs parses
# them out of this file rather than keeping a second copy: the arm list used to
# live here, in that script and in `spike-config.ts` at once, and a key that
# disagreed did not error — `board-spike.tsx` resolves an unknown treatment to
# index 0, so the run shot the wrong panel under the right caption. Keep them as
# plain single-quoted assignments; that is what the parser matches.
#
# The board list is the one default that is only a fallback: every figure iterates
# `SPIKE_BOARDS`, so a board added there and not here would have the figure
# builder demanding a shot this run never took.
BOARDS_DEFAULT='grasshopper-master tension-classic tension-mirror-12x12 kilter-homewall-10x12 kilter-original-12x12 moonboard-2016 moonboard-masters-2019'
TREATMENTS_DEFAULT='baseline outward-glow veil-tint veil-glow'
# The thumbnail sweep — the surfaces the app draws far more of than full boards.
# `thumb-baseline` and not `baseline` is the control at these widths because the
# list cell passes `filledStyle`, which is a different drawing and not a
# downsample of the full-size one.
THUMBNAIL_ARMS_DEFAULT='thumb-baseline outward-glow veil-glow veil-tint'
THUMBNAIL_SIZES_DEFAULT='152 228 384'

if [ -n "$KNOWN_KEYS" ]; then
  BOARDS_FROM_SCREEN="$(printf '%s\n' "$KNOWN_KEYS" | sed -n 's/^board //p' | tr '\n' ' ')"
else
  BOARDS_FROM_SCREEN="$BOARDS_DEFAULT"
fi
BOARDS="${BOARDS:-$BOARDS_FROM_SCREEN}"
# `none` is the sentinel for "this axis is not varied": the link still pins the
# screen's own default for it, and the captures go in the run's root rather than
# a subdirectory. No board, palette or size key is called `none`.
FIELDS="${FIELDS:-none}"
PALETTES="${PALETTES:-none}"
# Off is the product default: the glyphs are an opt-in accessibility mode that
# REPLACES the shipped per-role marker shapes (#3204), not a layer every render
# carries. A default run captures the state a climber actually sees.
GLYPHS="${GLYPHS:-off}"

if [ -n "${THUMBS:-}" ]; then
  SIZES="${SIZES:-$THUMBNAIL_SIZES_DEFAULT}"
  TREATMENTS="${*:-$THUMBNAIL_ARMS_DEFAULT}"
else
  SIZES="${SIZES:-full}"
  TREATMENTS="${*:-$TREATMENTS_DEFAULT}"
fi

# Both ways the screen swallows a key it does not know are silent, and they are
# not the same silence: board and treatment go through `findIndex` and a -1 is
# clamped to 0, so the run shoots the FIRST one under the caption you asked for;
# field, palette and size resolve to `undefined` and leave the axis on whatever
# the screen was last handed, so the run inherits a previous one.
require_key() {
  kind="$1"
  value="$2"
  if [ -z "$KNOWN_KEYS" ]; then return 0; fi
  if ! printf '%s\n' "$KNOWN_KEYS" | grep -qx "${kind} ${value}"; then
    case "$kind" in
      board | treatment) fate='the screen would shoot the first one instead' ;;
      *) fate='the screen would keep the one it was last handed' ;;
    esac
    echo "capture-boards.sh: no ${kind} '${value}' in the spike screen — ${fate}" >&2
    exit 1
  fi
}

for board in $BOARDS; do require_key board "$board"; done
for treatment in $TREATMENTS; do require_key treatment "$treatment"; done
for size in $SIZES; do require_key size "$size"; done
for field in $FIELDS; do
  if [ "$field" != none ]; then require_key background "$field"; fi
done
for palette in $PALETTES; do
  if [ "$palette" != none ]; then require_key palette "$palette"; fi
done
for glyphs in $GLYPHS; do
  if [ "$glyphs" != on ] && [ "$glyphs" != off ]; then
    echo "capture-boards.sh: GLYPHS takes 'on' or 'off', got '${glyphs}'" >&2
    exit 1
  fi
done

for field in $FIELDS; do
  for palette in $PALETTES; do
    for glyphs in $GLYPHS; do
      for size in $SIZES; do
        # Every axis is named in the link, none inherited. The screen keeps
        # whatever it was last handed, so one stale chip press — `LEDs: off`, or
        # a `Halos: on` that adds 966 casing strokes to every panel — silently
        # rewrites a whole run, and the caption in the shot does not say so.
        field_key="$field"
        palette_key="$palette"
        subdir=''
        if [ "$field" = none ]; then field_key='field'; else subdir="${subdir}__field-${field}"; fi
        if [ "$palette" = none ]; then palette_key='shipped'; else subdir="${subdir}__palette-${palette}"; fi
        if [ "$glyphs" != off ]; then subdir="${subdir}__glyphs-${glyphs}"; fi
        if [ "$size" != full ]; then subdir="${subdir}__size-${size}"; fi
        axes="&leds=on&halos=auto&field=${field_key}&palette=${palette_key}&glyphs=${glyphs}&size=${size}"
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
  done
done
