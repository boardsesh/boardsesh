#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/boardsesh-mobile-web-export.XXXXXX")"
SOURCE_GLUE="$ROOT_DIR/packages/board-renderer/wasm/pkg/board_renderer_wasm.js"
SOURCE_WASM="$ROOT_DIR/packages/board-renderer/wasm/pkg/board_renderer_wasm_bg.wasm"
PUBLIC_GLUE="$ROOT_DIR/packages/mobile/public/wasm/board_renderer_wasm.js"
PUBLIC_WASM="$ROOT_DIR/packages/mobile/public/wasm/board_renderer_wasm_bg.wasm"

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

# Single export recipe shared with the production build path (Dockerfile.web /
# `vp run build:expo-web`); it also asserts the shell and WASM assets landed.
bash "$ROOT_DIR/scripts/build-expo-web-export.sh" "$OUTPUT_DIR"

# The off-main-thread render worker is a static asset loaded by runtime URL, so
# it must be copied into the export verbatim (Metro never bundles it).
if [[ ! -f "$OUTPUT_DIR/wasm/board-render.worker.js" ]]; then
  echo "[mobile-web-bundle] missing board-render worker asset" >&2
  exit 1
fi

echo "[mobile-web-bundle] Expo web export is complete and contains the required shell and WASM assets"
