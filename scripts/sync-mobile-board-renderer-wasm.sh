#!/usr/bin/env bash
set -euo pipefail

# Copy the board-renderer WASM artifacts into the mobile app's public/ folder so
# Expo serves them below the configured /app base path for the web board renderer
# (packages/mobile/modules/board-renderer/src/index.web.ts, which loads the glue
# at runtime by URL). These MUST be real files under public/ — Metro cannot
# bundle them and Expo's static middleware / `expo export` only see real files.
#
# Source of truth is the wasm-pack build output in
# packages/board-renderer/wasm/pkg (git-tracked). Regenerate it first with
# `vp run build:wasm` when the Rust core changes, then run this script and commit
# both the pkg and the public copies.

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
src_dir="${repo_root}/packages/board-renderer/wasm/pkg"
dest_dir="${repo_root}/packages/mobile/public/wasm"

mkdir -p "${dest_dir}"

for file in board_renderer_wasm.js board_renderer_wasm_bg.wasm; do
  src="${src_dir}/${file}"
  dest="${dest_dir}/${file}"
  if [ ! -f "${src}" ]; then
    echo "error: ${src} missing. Run 'vp run build:wasm' first." >&2
    exit 1
  fi
  cp "${src}" "${dest}"
  src_sum="$(sha256sum "${src}" | cut -d' ' -f1)"
  dest_sum="$(sha256sum "${dest}" | cut -d' ' -f1)"
  if [ "${src_sum}" != "${dest_sum}" ]; then
    echo "error: checksum mismatch after copying ${file}" >&2
    exit 1
  fi
  echo "synced ${file} (${src_sum})"
done

echo "WASM web artifacts synced to packages/mobile/public/wasm/"
