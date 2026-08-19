#!/usr/bin/env bash
set -euo pipefail

# Copy the board-renderer WASM artifacts into every public/ folder that serves
# them:
#
#   packages/mobile/public/wasm  — Expo serves these below the configured /app
#     base path for the web board renderer
#     (packages/mobile/modules/board-renderer/src/index.web.ts, which loads the
#     glue at runtime by URL).
#   packages/web/public/wasm     — the Next.js board-render worker
#     (packages/web/app/lib/board-render-worker/board-render.worker.ts) loads the
#     same glue from the site root.
#
# These MUST be real files under public/ — Metro cannot bundle them and Expo's
# static middleware / `expo export` only see real files.
#
# Before issue #4495 only the mobile copy was scripted, so www's silently drifted
# onto an artifact that ignored stroke_width_multiplier. Keep all three in one
# place; scripts/mobile-web-bundle-check.sh fails CI on any byte difference.
#
# Source of truth is the wasm-pack build output in
# packages/board-renderer/wasm/pkg (git-tracked). Regenerate it first with
# `vp run build:wasm` when the Rust core changes, then run this script and commit
# both the pkg and the public copies.

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
src_dir="${repo_root}/packages/board-renderer/wasm/pkg"
dest_dirs="${repo_root}/packages/mobile/public/wasm ${repo_root}/packages/web/public/wasm"

for dest_dir in ${dest_dirs}; do
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
    echo "synced ${file} -> ${dest_dir#"${repo_root}/"} (${src_sum})"
  done
done

echo "WASM web artifacts synced to packages/mobile/public/wasm/ and packages/web/public/wasm/"
