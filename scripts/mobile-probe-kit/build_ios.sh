#!/bin/bash
# Build the current checkout as a Release app with the probes in, install it on the phone, and put the tree back.
#
#   BOARDSESH_PROBE_UDID=<udid> build_ios.sh <log-file> [apply_probes.py flags and extra patch scripts ...]
#
# Run it from the repo root, on the commit you want to measure, with a clean tree.
# Arguments that start with -- go to apply_probes.py; anything else is a patch
# script to run after it with the repo root as its argument.
#
# The three EXPO_PUBLIC values mirror what a store build is made with and change
# what the JS does: without the snapshot URL an offline download falls back to a
# paged crawl that takes many minutes. Telemetry keys are deliberately absent.
set -uo pipefail
: "${BOARDSESH_PROBE_UDID:?Set BOARDSESH_PROBE_UDID to the phone UDID}"
KIT="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(git rev-parse --show-toplevel)"
LOG="$1"; shift
cd "$ROOT"
if [ -n "$(git status --porcelain)" ]; then echo "The tree is not clean; commit or set work aside first."; exit 1; fi
FLAGS=(); PATCHES=()
for argument in "$@"; do case "$argument" in --*) FLAGS+=("$argument");; *) PATCHES+=("$argument");; esac; done
revert() { git checkout -q -- packages/mobile packages/shared && command rm -f packages/mobile/src/lib/perf-probe.ts; }
python3 -I "$KIT/probe/apply_probes.py" "$ROOT" ${FLAGS[@]+"${FLAGS[@]}"} || { revert; exit 1; }
for patch in ${PATCHES[@]+"${PATCHES[@]}"}; do python3 -I "$patch" "$ROOT" || { revert; exit 1; }; done
EXPO_PUBLIC_PERF_PROBE=1 EXPO_PUBLIC_USE_RN_FETCH=1 \
EXPO_PUBLIC_SNAPSHOT_BASE_URL=https://snapshots.boardsesh.com/board-snapshots/v1-gzip \
SENTRY_DISABLE_AUTO_UPLOAD=true CI=0 \
  vp run mobile:ios -- --device "$BOARDSESH_PROBE_UDID" --configuration Release >| "$LOG" 2>&1
STATUS=$?
grep -E "Build Succeeded|Complete 100|error:" "$LOG" | tail -2 | cut -c1-120
revert
echo "tree: $(git status --porcelain | wc -l | tr -d ' ') changed files, at $(git rev-parse --short HEAD)"
exit $STATUS
