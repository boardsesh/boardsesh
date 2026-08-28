#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# CI points TMPDIR at a restored cache directory (see the Expo web bundle check
# step in ci.yml), which does not exist yet on a cold cache — mktemp would fail
# before the guard ever ran. Create it rather than trust the caller.
mkdir -p "${TMPDIR:-/tmp}"
OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-mobile-web-export.XXXXXX")"
SOURCE_GLUE="$ROOT_DIR/packages/board-renderer/wasm/pkg/board_renderer_wasm.js"
SOURCE_WASM="$ROOT_DIR/packages/board-renderer/wasm/pkg/board_renderer_wasm_bg.wasm"
PUBLIC_GLUE="$ROOT_DIR/packages/mobile/public/wasm/board_renderer_wasm.js"
PUBLIC_WASM="$ROOT_DIR/packages/mobile/public/wasm/board_renderer_wasm_bg.wasm"
WEB_PUBLIC_GLUE="$ROOT_DIR/packages/web/public/wasm/board_renderer_wasm.js"
WEB_PUBLIC_WASM="$ROOT_DIR/packages/web/public/wasm/board_renderer_wasm_bg.wasm"

cleanup() {
  rm -rf "$OUTPUT_DIR"
}
trap cleanup EXIT

verify_synced_artifact() {
  local source_file="$1"
  local public_file="$2"
  local artifact_name="$3"

  if [[ ! -f "$source_file" || ! -f "$public_file" ]]; then
    echo "[mobile-web-bundle] missing source or public board-renderer $artifact_name" >&2
    exit 1
  fi

  if ! cmp -s "$source_file" "$public_file"; then
    echo "[mobile-web-bundle] public board-renderer $artifact_name is stale; run 'bash scripts/sync-mobile-board-renderer-wasm.sh'" >&2
    exit 1
  fi
}

verify_synced_artifact "$SOURCE_GLUE" "$PUBLIC_GLUE" "JavaScript glue"
verify_synced_artifact "$SOURCE_WASM" "$PUBLIC_WASM" "WASM"

# www serves a third copy to its own board-render worker. It has no build step of
# its own, and before issue #4495 nothing checked it — which is how it drifted
# onto an artifact that ignored stroke_width_multiplier. The sync script writes
# it; this asserts someone ran the script.
verify_synced_artifact "$SOURCE_GLUE" "$WEB_PUBLIC_GLUE" "www JavaScript glue"
verify_synced_artifact "$SOURCE_WASM" "$WEB_PUBLIC_WASM" "www WASM"

# Single export recipe shared with the production build path (Dockerfile.web /
# `vp run build:expo-web`); it also asserts the shell and WASM assets landed.
#
# This is the ONE caller that opts out of the export's `--clear` cache wipe. The
# wipe exists because expo export reuses Metro's transform cache across
# EXPO_PUBLIC_* changes and once shipped a bundle with stale origins inlined
# (2026-07-18) — but this check bakes no EXPO_PUBLIC_*, asserts no baked URLs,
# and throws the export away below. It only proves the web graph still resolves,
# transforms and serializes, so a cold Metro was ~95s of CI spent on nothing.
# In exchange the export script scopes its transform store by a hash of every
# env value it inlines, so a change in baked env lands in a different cache
# directory instead of hitting a stale shard. Do not set this anywhere an
# artifact is kept.
BOARDSESH_EXPORT_KEEP_METRO_CACHE=1 \
  bash "$ROOT_DIR/scripts/build-expo-web-export.sh" "$OUTPUT_DIR"

# The off-main-thread render worker is a static asset loaded by runtime URL, so
# it must be copied into the export verbatim (Metro never bundles it).
if [[ ! -f "$OUTPUT_DIR/wasm/board-render.worker.js" ]]; then
  echo "[mobile-web-bundle] missing board-render worker asset" >&2
  exit 1
fi

echo "[mobile-web-bundle] Expo web export is complete and contains the required shell and WASM assets"
