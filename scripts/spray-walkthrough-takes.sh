#!/usr/bin/env bash
# Capture and assemble the current iPhone app takes for /help/spray-walls.
# Source: d669419a6b (main 5992ed8e8005), captured 2026-10-10.
# Run from a signed-in iPhone 17 Pro Max simulator on this checkout's Metro JS.
# The supplied photo is marketing/spray-walkthrough/wall-photo.jpg.
#
#   scripts/spray-walkthrough-takes.sh import-photo
#   scripts/spray-walkthrough-takes.sh record create
#   scripts/spray-walkthrough-takes.sh record create-rest
#   scripts/spray-walkthrough-takes.sh record review
#   scripts/spray-walkthrough-takes.sh record later
#   scripts/spray-walkthrough-takes.sh assemble
#   vp run video:spray-walkthrough -- --stills
#   vp run video:spray-walkthrough
#
# Press Ctrl-C to finish each recording. The simulator writes a valid MP4 on
# SIGINT. Recordings and cut sources remain gitignored under .boardsesh/.
# The edit manifest uses the assembled 30 fps clips, so the long picker,
# scanning and navigation waits never become renderer frame extracts.
#
# Current flow: Boards > Spray wall > name/angle > photo > optional corners >
# hold detection > Select (Keep a maybe, selected-ring size controls) > Add
# (Draw or Corners) > Done > background Photo > hold look > publish.
# Later: activate the wall > Climbs > wall capsule > Edit holds > select an off
# ring > Delete > Add mode > Publish holds. Select-mode empty taps do not add.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="$ROOT/.boardsesh/help-clips/raw"
SIMULATOR="${SPRAY_WALKTHROUGH_SIMULATOR:-C9C5B242-4950-4428-9B01-5D7272F977CE}"
PHOTO="$ROOT/marketing/spray-walkthrough/wall-photo.jpg"

record() {
  local name="$1"
  mkdir -p "$RAW"
  xcrun simctl io "$SIMULATOR" recordVideo --codec h264 --force "$RAW/spray-$name.mp4"
}

# Trim and normalize each window, then concat without re-encoding. These source
# windows were checked against the captured app UI; edit.json supplies captions.
assemble_take() {
  local name="$1"
  shift
  local cut_dir="$RAW/cuts/$name"
  local list_file="$cut_dir/concat.txt"
  local index=0
  mkdir -p "$cut_dir"
  : > "$list_file"
  while (( $# > 0 )); do
    local source="$1" start="$2" duration="$3"
    shift 3
    local clip="$cut_dir/$(printf '%02d' "$index").mp4"
    ffmpeg -hide_banner -loglevel error -y -ss "$start" -i "$RAW/$source" \
      -an -vf "setpts=PTS-STARTPTS,fps=30,scale=900:-2:flags=lanczos,tpad=stop_mode=clone:stop_duration=$duration,trim=duration=$duration,setpts=PTS-STARTPTS" \
      -frames:v "$((duration * 30))" -c:v libx264 -preset veryfast -crf 21 \
      -pix_fmt yuv420p -r 30 "$clip"
    printf "file '%s'\n" "$clip" >> "$list_file"
    index=$((index + 1))
  done
  ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "$list_file" \
    -c copy -movflags +faststart "$RAW/spray-$name-cut.mp4"
  ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 \
    "$RAW/spray-$name-cut.mp4"
}

assemble() {
  # Boards/name, photo selection, optional corners, scan, first editor frame.
  assemble_take create \
    spray-create.mp4 26 4 \
    spray-create.mp4 76 5 \
    spray-create.mp4 198 5 \
    spray-create-rest.mp4 15 5 \
    spray-create-rest.mp4 57 5 \
    spray-create-rest.mp4 69 6

  # Keep a maybe; adjust a selected ring; Add a missed hold; background/look.
  assemble_take review \
    spray-review.mp4 21 5 \
    spray-review.mp4 80 4 \
    spray-review.mp4 101 5 \
    spray-review.mp4 148 5 \
    spray-review.mp4 163 5 \
    spray-review.mp4 208 5 \
    spray-review.mp4 221 5 \
    spray-review.mp4 278 2 \
    spray-review.mp4 312 5

  # Live wall sheet, Edit holds, an already-off ring, Delete, Add, Publish.
  assemble_take edit-later \
    spray-edit-later.mp4 450 5 \
    spray-edit-later.mp4 520 5 \
    spray-edit-later.mp4 582 5 \
    spray-edit-later.mp4 627 4 \
    spray-edit-later.mp4 664 8 \
    spray-edit-later.mp4 674 3
}

case "${1:-}" in
  import-photo) xcrun simctl addmedia "$SIMULATOR" "$PHOTO" ;;
  record) record "${2:?expected create, create-rest, review, or later}" ;;
  assemble) assemble ;;
  *) echo "usage: $0 import-photo|record <create|create-rest|review|later>|assemble" >&2; exit 2 ;;
esac
