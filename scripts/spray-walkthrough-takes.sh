#!/usr/bin/env bash
# Records the three Android takes behind the /help/spray-walls walkthrough
# (rendered by `vp run video:spray-walkthrough`; runbook in docs/help-clips.md).
#
#   scripts/spray-walkthrough-takes.sh create|review|later
#
# Needs a running emulator with the dev client on Metro, signed in as the help
# account, on the 1080x1920 display screenshot mode sets
# (`vp run mobile:android-shots -- --backend prod`). The taps are coordinates on
# that display, measured against the CC0 wall photo in
# marketing/spray-walkthrough/wall-photo.jpg: a new photo, a different detection
# result or a moved control means re-measuring them with `ui` below.
#
#   create  Boards → Spray wall → name → photo → corners → detected holds.
#           Start on the Boards screen with the photo pushed to the gallery:
#           adb push marketing/spray-walkthrough/wall-photo.jpg /sdcard/Pictures/
#   review  Keep a maybe, add a hold, resize one, draw a missed one, pick a look.
#           Run straight after `create`, on the review screen it ends on.
#   later   Climbs → wall name → Edit holds → remove one, add one → Publish holds.
#
# Each take is written to .boardsesh/help-clips/raw/spray-<take>.mp4.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADB="${ADB:-$HOME/.cache/boardsesh/android-sdk/platform-tools/adb}"
RAW="$ROOT/.boardsesh/help-clips/raw"

# Every visible node with text, content-desc or resource-id, with its bounds.
ui() {
  "$ADB" shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  "$ADB" exec-out cat /sdcard/ui.xml | python3 -I -c '
import sys, xml.etree.ElementTree as ET
for node in ET.fromstring(sys.stdin.read()).iter("node"):
    text, desc = node.get("text", ""), node.get("content-desc", "")
    if text or desc:
        print(node.get("bounds"), "text=%r desc=%r" % (text, desc))'
}

# Taps the centre of the first node whose text or content-desc contains $1.
tap_label() {
  local line
  line="$(ui | grep -F -- "$1" | head -1)"
  [ -n "$line" ] || { echo "spray-walkthrough-takes: '$1' is not on screen" >&2; exit 1; }
  read -r x1 y1 x2 y2 < <(echo "$line" | sed -E 's/^\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\].*/\1 \2 \3 \4/')
  "$ADB" shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
}

tap() { "$ADB" shell input tap "$1" "$2"; }
long_press() { "$ADB" shell input swipe "$1" "$2" "$1" "$2" 900; }

# A drag the gesture handler sees as a pan: down, two steps, up.
drag() {
  "$ADB" shell "input motionevent DOWN $1 $2; sleep 0.3; \
    input motionevent MOVE $((($1 * 2 + $3) / 3)) $((($2 * 2 + $4) / 3)); sleep 0.15; \
    input motionevent MOVE $((($1 + $3 * 2) / 3)) $((($2 + $4 * 2) / 3)); sleep 0.15; \
    input motionevent MOVE $3 $4; sleep 0.35; input motionevent UP $3 $4"
  sleep 0.9
}

# One finger round an ellipse centred on ($1, $2) with radii ($3, $4).
draw_loop() {
  "$ADB" shell "$(python3 -I -c '
import math, sys
cx, cy, rx, ry = map(int, sys.argv[1:])
points = [(round(cx + rx * math.cos(2 * math.pi * i / 28)), round(cy + ry * math.sin(2 * math.pi * i / 28))) for i in range(29)]
steps = ["input motionevent DOWN %d %d" % points[0]] + ["input motionevent MOVE %d %d" % point for point in points[1:]]
print("; ".join(steps + ["input motionevent UP %d %d" % points[-1]]))' "$1" "$2" "$3" "$4")"
}

take_create() {
  sleep 1.5
  tap 951 546; sleep 2.5                           # Spray wall tile
  tap 540 702; sleep 1
  "$ADB" shell input text "Home%swall"; sleep 1
  "$ADB" shell input keyevent 111; sleep 1.5       # hide the keyboard
  "$ADB" shell input swipe 540 1500 540 900 700; sleep 2
  tap 195 1626; sleep 2.5                          # Pick a photo
  tap 210 682; sleep 2.5                           # Choose a photo
  tap_label "Photo taken on"; sleep 3
  tap 132 1626; sleep 2.5                          # Next
  "$ADB" shell input swipe 540 520 540 250 600; sleep 1.5
  drag 141 516 66 456; drag 936 516 1014 456; drag 936 1308 1014 1380; drag 141 1308 66 1380
  sleep 1
  tap 240 1626                                     # Use these corners
  for _ in $(seq 1 40); do
    sleep 1
    ui | grep -q "Pick a look" && break
  done
  sleep 4
}

take_review() {
  sleep 2.5
  tap 428 866; sleep 2.2                           # keep the dashed maybe on the big volume
  tap 862 667; sleep 2.2                           # tap the wall to add a hold
  long_press 600 900; sleep 1.8
  tap 400 1631; sleep 1.0; tap 400 1631; sleep 1.8 # Bigger, twice
  tap 668 1773; sleep 2.2                          # + add missing holds
  draw_loop 832 1422 82 52; sleep 2.2              # round the bottom-right volume
  tap_label "Done"; sleep 1.8
  tap_label "Pick a look"; sleep 4.5
  tap_label "Use Aura Outline"; sleep 4
}

take_later() {
  sleep 2
  tap 315 186; sleep 2.8                           # the wall's name opens its board sheet
  tap_label "Add, move or delete"; sleep 5         # Edit holds
  long_press 465 1099; sleep 1.8                   # the black hold
  tap_label "Remove"; sleep 2.2
  tap 105 1384; sleep 2.4                          # the bottom-left volume
  tap_label "Publish holds"; sleep 6
}

record() {
  local name="$1"
  shift
  mkdir -p "$RAW"
  "$ADB" shell settings put system show_touches 1
  "$ADB" shell rm -f /sdcard/take.mp4
  "$ADB" shell screenrecord --bit-rate 16000000 --time-limit 180 /sdcard/take.mp4 &
  local recorder=$!
  sleep 1.5
  "$@"
  sleep 1
  "$ADB" shell pkill -INT screenrecord || true
  wait "$recorder" || true
  sleep 2
  "$ADB" pull /sdcard/take.mp4 "$RAW/$name.mp4" >/dev/null
  echo "$RAW/$name.mp4"
}

case "${1:-}" in
  create) record spray-create take_create ;;
  review) record spray-review take_review ;;
  later) record spray-edit-later take_later ;;
  ui) ui ;;
  *)
    echo "usage: $0 create|review|later|ui" >&2
    exit 2
    ;;
esac
