#!/usr/bin/env bash
set -euo pipefail

# Builds the static Expo web export and verifies the shell and board-renderer
# WASM assets landed. This is the single export recipe shared by:
#   - `vp run build:expo-web` (defaults to packages/web/public/app so a local
#     BOARDSESH_WEB=1 `vp run build:web` serves /app exactly like production),
#   - Dockerfile.web's builder stage (same default target),
#   - scripts/mobile-web-bundle-check.sh (temp dir; export-only validation).
#
# Two serving targets share the recipe, selected by --subdomain:
#   - default          → baseUrl /app, the Next dev proxy + legacy prod-static
#                        path (output packages/web/public/app).
#   - --subdomain      → baseUrl /, a STANDALONE export a host/CDN serves at the
#                        root of app.boardsesh.com (output
#                        packages/web/public/app-standalone unless overridden).
#                        The host must SPA-fallback deep routes to index.html.
#
# Usage: bash scripts/build-expo-web-export.sh [--subdomain] [output-dir]
#
# The output directory is wiped first, so never point it at a directory with
# hand-maintained content. See docs/expo-web-deployment.md.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# /app is the default so the dev proxy and the legacy prod-static path are
# unchanged; --subdomain flips it to root-serving for app.boardsesh.com.
WEB_BASE_URL="/app"
DEFAULT_OUTPUT_DIR="$ROOT_DIR/packages/web/public/app"
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --subdomain)
      WEB_BASE_URL="/"
      DEFAULT_OUTPUT_DIR="$ROOT_DIR/packages/web/public/app-standalone"
      shift
      ;;
    --)
      shift
      ;;
    *)
      OUTPUT_DIR="$1"
      shift
      ;;
  esac
done

OUTPUT_DIR="${OUTPUT_DIR:-$DEFAULT_OUTPUT_DIR}"
if [[ "$OUTPUT_DIR" != /* ]]; then
  OUTPUT_DIR="$PWD/$OUTPUT_DIR"
fi

if [[ "$OUTPUT_DIR" == "$ROOT_DIR" || "$ROOT_DIR" == "$OUTPUT_DIR"/* ]]; then
  echo "[build-expo-web-export] refusing to export over $OUTPUT_DIR" >&2
  exit 1
fi

WEB_RUNTIME_DIR="$ROOT_DIR/packages/mobile/web-runtime"
if [[ ! -d "$WEB_RUNTIME_DIR/node_modules/react-native-web" ]]; then
  # The web-only renderer lives in an isolated nested install so it never
  # enters the native fingerprint graph. `vp run build:expo-web` installs it
  # via its task dependency; direct callers (Docker) land here.
  echo "[build-expo-web-export] installing packages/mobile/web-runtime dependencies"
  bun install --cwd "$WEB_RUNTIME_DIR" --frozen-lockfile
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

cd "$ROOT_DIR/packages/mobile"

# TAILSCALE_HOSTS= short-circuits app.config.ts's tailscale-CLI probe when the
# caller has not expressed a preference (CI/Docker have no tailscaled anyway).
export TAILSCALE_HOSTS="${TAILSCALE_HOSTS-}"

# app.config.ts's resolveWebPlatforms reads BOARDSESH_WEB_BASE_URL (default
# /app). Setting it explicitly here keeps the export deterministic regardless of
# any ambient value; --subdomain sets it to / for root serving.
BOARDSESH_WEB=1 BOARDSESH_WEB_BASE_URL="$WEB_BASE_URL" EXPO_NO_WEB_SETUP=1 EXPO_NO_TELEMETRY=1 \
  bunx expo export --platform web --output-dir "$OUTPUT_DIR"

if [[ ! -f "$OUTPUT_DIR/index.html" ]]; then
  echo "[build-expo-web-export] missing index.html in $OUTPUT_DIR" >&2
  exit 1
fi

if [[ ! -f "$OUTPUT_DIR/wasm/board_renderer_wasm.js" || ! -f "$OUTPUT_DIR/wasm/board_renderer_wasm_bg.wasm" ]]; then
  echo "[build-expo-web-export] missing board-renderer WASM assets in $OUTPUT_DIR" >&2
  exit 1
fi

echo "[build-expo-web-export] Expo web export (baseUrl $WEB_BASE_URL) written to $OUTPUT_DIR"
