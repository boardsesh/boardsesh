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
# The output directory is wiped first. As a guard, the script refuses to wipe a
# non-empty directory that isn't already an Expo web export (no `_expo/`), and
# refuses any target at or above the repo root. See docs/expo-web-deployment.md.

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
      # vp forwards the literal `--` separator into a script's argv (known repo
      # footgun), so `vp run build:expo-web -- <dir>` arrives here as `-- <dir>`.
      # Drop it so the output dir isn't taken as "--" (an export into ./--).
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
# Strip ALL trailing slashes (shell tab-completion appends one; `<root>//` needs
# more than one strip) before the guards — otherwise `<root>/` slips past the
# repo-root check and rm -rf wipes the repo.
while [[ "$OUTPUT_DIR" == */ ]]; do OUTPUT_DIR="${OUTPUT_DIR%/}"; done

if [[ -z "$OUTPUT_DIR" || "$OUTPUT_DIR" == "$ROOT_DIR" || "$ROOT_DIR" == "$OUTPUT_DIR"/* ]]; then
  echo "[build-expo-web-export] refusing to export over $OUTPUT_DIR" >&2
  exit 1
fi

# Refuse to wipe a directory that isn't already an Expo web export. The guard
# above only protects the repo root and its ancestors; a one-segment typo like
# `packages/web/public` (instead of `.../public/app`) or any real directory
# outside the repo would otherwise be rm -rf'd. The marker is the `_expo/`
# directory, which `expo export --platform web` always emits — index.html is NOT
# a safe marker because the committed `packages/web/public` (the exact typo this
# guards against) already carries one. Only wipe when the target is absent,
# empty, or a prior export.
if [[ -d "$OUTPUT_DIR" && -n "$(ls -A "$OUTPUT_DIR" 2>/dev/null)" && ! -d "$OUTPUT_DIR/_expo" ]]; then
  echo "[build-expo-web-export] refusing to wipe non-empty $OUTPUT_DIR (no _expo/ — not a previous Expo web export)" >&2
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

# Inject favicon + OpenGraph/Twitter tags into the static index.html. Expo's
# `output: 'single'` export ships a default shell and only runs app/+html.tsx
# inside the JS bundle, so link unfurlers (Discord/Slack/iMessage) — which read
# the static HTML without executing JS — never saw a favicon or OG image. Assets
# live in packages/mobile/public/{favicon,og}.png and ship at the export root.
# The OG image must be an absolute URL, so it depends on the serve origin:
#   --subdomain (baseUrl /) → app.boardsesh.com ; /app (default) → www.boardsesh.com.
ASSET_BASE="${WEB_BASE_URL%/}" # '' for the subdomain root, '/app' for the legacy path
if [[ "$WEB_BASE_URL" == "/" ]]; then
  OG_ORIGIN="https://app.boardsesh.com"
else
  OG_ORIGIN="https://www.boardsesh.com"
fi
BOARDSESH_ASSET_BASE="$ASSET_BASE" BOARDSESH_OG_ORIGIN="$OG_ORIGIN" \
  python3 - "$OUTPUT_DIR/index.html" <<'PY'
import os, sys

index_path = sys.argv[1]
asset_base = os.environ["BOARDSESH_ASSET_BASE"]
og_origin = os.environ["BOARDSESH_OG_ORIGIN"]
favicon = f"{asset_base}/favicon.png"
og_image = f"{og_origin}{asset_base}/og.png"
description = "One app for your climbing boards. Browse climbs, build a queue, and climb with your crew."

html = open(index_path, encoding="utf-8").read()
if "data-boardsesh-og" in html:
    sys.exit(0)  # already injected (idempotent)

tags = f'''<link rel="icon" type="image/png" href="{favicon}" data-boardsesh-og>
    <link rel="apple-touch-icon" href="{favicon}">
    <meta name="theme-color" content="#15101e">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Boardsesh">
    <meta property="og:title" content="Boardsesh">
    <meta property="og:description" content="{description}">
    <meta property="og:image" content="{og_image}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="Boardsesh">
    <meta name="twitter:description" content="{description}">
    <meta name="twitter:image" content="{og_image}">
  '''

marker = "</head>"
if marker not in html:
    sys.stderr.write("[build-expo-web-export] no </head> in index.html; cannot inject OG tags\n")
    sys.exit(1)
open(index_path, "w", encoding="utf-8").write(html.replace(marker, tags + marker, 1))
print(f"[build-expo-web-export] injected favicon + OG tags (image {og_image})")
PY

if [[ ! -f "$OUTPUT_DIR/wasm/board_renderer_wasm.js" || ! -f "$OUTPUT_DIR/wasm/board_renderer_wasm_bg.wasm" ]]; then
  echo "[build-expo-web-export] missing board-renderer WASM assets in $OUTPUT_DIR" >&2
  exit 1
fi

echo "[build-expo-web-export] Expo web export (baseUrl $WEB_BASE_URL) written to $OUTPUT_DIR"
