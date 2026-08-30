#!/usr/bin/env bash
set -euo pipefail

# Builds the static Expo web export and verifies the shell, the board-renderer
# WASM assets and the PWA manifest wiring landed. This is the single export
# recipe shared by:
#   - production-deploy.yml's deploy-app-web job (--subdomain) — the only caller
#     whose artifact reaches users,
#   - `vp run build:expo-web` and scripts/dev-expo-web-static.sh (default
#     target packages/web/public/app, served at /app by the DEV server only),
#   - scripts/mobile-web-bundle-check.sh (temp dir; export-only validation).
#
# Two serving targets share the recipe, selected by --subdomain:
#   - default          → baseUrl /app. Dev + CI validation only since W-24
#                        (#4438) retired the /app static path: Dockerfile.web no
#                        longer calls this script and next.config.mjs bakes no
#                        /app rewrite outside NODE_ENV=development (output
#                        packages/web/public/app).
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
#
# BOARDSESH_EXPORT_KEEP_METRO_CACHE=1 trades the `--clear` cache wipe for an
# env-scoped transform store — throwaway validation only, never a shipped
# artifact. See the block above the export invocation for the full reasoning.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# /app is the default so the dev proxy and the dev:mobile:web-static bake are
# unchanged; --subdomain flips it to root-serving for app.boardsesh.com. There
# is no prod-static path left for the default to keep working — W-24 (#4438)
# retired it (see the header block).
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
  # via its task dependency; direct callers land here and still let Vite+
  # provide the pinned package manager.
  echo "[build-expo-web-export] installing packages/mobile/web-runtime dependencies"
  vp exec pnpm --dir "$WEB_RUNTIME_DIR" install --frozen-lockfile
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
#
# --clear: expo export reuses Metro's transform cache across EXPO_PUBLIC_* env
# changes, silently shipping a stale bundle with old env values inlined
# (verified 2026-07-18..20). It stays ON by default, for every caller that
# produces an artifact somebody serves: Dockerfile.web's builder stage,
# production-deploy.yml's standalone export, `vp run build:expo-web`, and
# scripts/dev-expo-web-static.sh. Those bake real origins in, so a stale shard
# ships; none of them sets the opt-out below.
EXPORT_CLEAR_FLAG='--clear'

# The one caller that gains nothing from the wipe is the CI bundle check
# (scripts/mobile-web-bundle-check.sh): it bakes no EXPO_PUBLIC_*, sets no
# BOARDSESH_EXPORT_EXPECT_URLS, and deletes its own output directory. It asserts
# only that the web graph still resolves, transforms and serializes, and that
# the shell + WASM assets land — yet it paid a fully cold Metro (~95s) on every
# run, and would also have deleted any cache restored for it.
#
# The opt-out does not drop the 2026-07-18 guarantee, it re-buys it a different
# way: the transform store moves into a directory named after a hash of every
# env value this export bakes in. A changed value therefore cannot *reach* a
# shard transformed under the old one — it lands in a different directory. Never
# ship the flag gate without the hashed root; the flag alone is the stale-bundle
# bug again.
# A bare `-n` test would read BOARDSESH_EXPORT_KEEP_METRO_CACHE=0 as "on" — and
# `=0` is the first spelling anyone reaches for to turn a speed-up OFF. For a
# flag whose wrong answer is a reused cache, unsetting must not be the only way
# to say no. Off-shaped values are off; anything else (1, true, yes) opts in.
KEEP_METRO_CACHE=1
case "${BOARDSESH_EXPORT_KEEP_METRO_CACHE:-}" in
  '' | 0 | false | FALSE | no | NO) KEEP_METRO_CACHE=0 ;;
esac

if [[ "$KEEP_METRO_CACHE" == 1 && -n "${BOARDSESH_EXPORT_EXPECT_URLS:-}" ]]; then
  # Interlock. BOARDSESH_EXPORT_EXPECT_URLS means this export is an artifact
  # with real origins baked in — exactly the shape --clear was bought for. No
  # caller sets both today; if one ever does, the wipe wins over the speed-up.
  echo "[build-expo-web-export] BOARDSESH_EXPORT_EXPECT_URLS is set — ignoring BOARDSESH_EXPORT_KEEP_METRO_CACHE and keeping --clear" >&2
elif [[ "$KEEP_METRO_CACHE" == 1 ]]; then
  # macOS ships `shasum`, Linux and the alpine builder ship GNU `sha256sum`.
  if command -v sha256sum >/dev/null 2>&1; then
    hash_inlined_env() { sha256sum; }
  elif command -v shasum >/dev/null 2>&1; then
    hash_inlined_env() { shasum -a 256; }
  else
    hash_inlined_env() { return 1; }
  fi

  INLINED_ENV_HASH="$(
    {
      # BOARDSESH_WEB_BASE_URL is set on the export command line below rather
      # than exported, so `env` cannot see it — feed the effective value in by
      # hand. --subdomain flips it, and it decides every asset URL in
      # index.html, which is exactly the kind of staleness --clear guarded.
      printf 'BOARDSESH_WEB_BASE_URL=%s\n' "$WEB_BASE_URL"
      # Deliberately broad. EXPO_PUBLIC_* are inlined into the JS by babel; the
      # rest steer app.config.ts, whose resolved config is serialized into the
      # bundle too. Over-inclusion costs at most a cache miss (slow); a missing
      # name is the 2026-07-18 bug (wrong).
      #
      # The trailing `[^=]*=` is load-bearing twice over: those entries are name
      # PREFIXES, so binding the `=` straight to the group (`^(EXPO_|...)=`)
      # would only ever match a variable named exactly `EXPO_`, silently hashing
      # nothing — and requiring a `NAME=` shape also skips the continuation
      # lines of any multi-line value, which cannot be attributed to a name.
      #
      # KNOWN LIMIT, so nobody reads this as "every inlined value": the Expo CLI
      # also loads packages/mobile/.env* from inside the node process, after
      # this snapshot, so EXPO_PUBLIC_* set THERE are inlined without reaching
      # the hash. That file is gitignored (a local-dev thing; CI has none), and
      # the only caller that opts in throws its export away — but it is exactly
      # why the opt-out must never move to a path that keeps its output.
      env | grep -E '^(EXPO_|BOARDSESH_|EAS_BUILD|TAILSCALE_HOSTS|GOOGLE_MAPS_API_KEY)[^=]*=' || true
    } | LC_ALL=C sort | hash_inlined_env | cut -c1-16
  )" || INLINED_ENV_HASH=''

  if [[ -z "$INLINED_ENV_HASH" ]]; then
    # No sha256 tool means no scoped root, and an unscoped reused cache is the
    # thing we refuse to ship. Slow is an acceptable failure here; stale is not.
    echo "[build-expo-web-export] no sha256sum/shasum available — keeping --clear despite BOARDSESH_EXPORT_KEEP_METRO_CACHE" >&2
  else
    # @expo/metro-config hard-codes the transform store to
    # os.tmpdir()/metro-cache, so TMPDIR is the only supported way to move it.
    # (Do NOT reach for a cacheStores override in metro.config.js — that file is
    # a native-fingerprint input and editing it invalidates every OTA binary.)
    export TMPDIR="${TMPDIR:-/tmp}/metro-web-env-$INLINED_ENV_HASH"
    mkdir -p "$TMPDIR"
    EXPORT_CLEAR_FLAG=''
    echo "[build-expo-web-export] reusing Metro's transform cache under $TMPDIR (inlined-env $INLINED_ENV_HASH)"
  fi
fi

BOARDSESH_WEB=1 BOARDSESH_WEB_BASE_URL="$WEB_BASE_URL" EXPO_NO_WEB_SETUP=1 EXPO_NO_TELEMETRY=1 \
  vp exec expo export --platform web --output-dir "$OUTPUT_DIR" ${EXPORT_CLEAR_FLAG:+"$EXPORT_CLEAR_FLAG"}

if [[ ! -f "$OUTPUT_DIR/index.html" ]]; then
  echo "[build-expo-web-export] missing index.html in $OUTPUT_DIR" >&2
  exit 1
fi

if [[ ! -f "$OUTPUT_DIR/wasm/board_renderer_wasm.js" || ! -f "$OUTPUT_DIR/wasm/board_renderer_wasm_bg.wasm" ]]; then
  echo "[build-expo-web-export] missing board-renderer WASM assets in $OUTPUT_DIR" >&2
  exit 1
fi

# --- PWA manifest (W-24, #4438) -------------------------------------------
# index.html is a checked-in template (packages/mobile/public/index.html) whose
# manifest href is a fixed `/app/manifest.json`, and manifest.json is copied
# verbatim out of public/. Neither knows this export's baseUrl. On the
# --subdomain export that href points at a path with no file behind it, so
# Cloudflare Pages' `/* /index.html 200` catch-all answers it with the SPA
# shell: the browser parses HTML as a manifest, logs an error every load, and
# never offers the install prompt. Rewrite the href and the manifest's
# start_url/scope from WEB_BASE_URL, then assert the rewrite actually landed —
# a silent no-op here is the exact failure mode being fixed.
#
# It runs in BOTH modes even though only --subdomain ships. The CI gate
# (`vp run check:mobile-web-bundle`) only ever exercises the default mode, so a
# uniform code path means a broken patcher reds CI; a --subdomain-only patch
# would stay untested until a production deploy, which is how the bug it fixes
# survived in the first place.
if [[ "$WEB_BASE_URL" == "/" ]]; then
  MANIFEST_BASE=""
else
  MANIFEST_BASE="${WEB_BASE_URL%/}"
fi
node "$ROOT_DIR/scripts/lib/patch-expo-web-pwa-manifest.mjs" \
  "$OUTPUT_DIR" \
  "$MANIFEST_BASE" \
  "$ROOT_DIR/packages/shared/static-assets/src/generated/catalog.json"

# BOARDSESH_EXPORT_EXPECT_URLS (space-separated substrings, e.g.
# "https://ws.boardsesh.com https://www.boardsesh.com") is the direct detector
# for the stale-cache bug the --clear flag above guards against: assert every
# substring actually landed in an emitted JS bundle. CI deploy workflows set
# this so a regression of --clear fails loudly instead of shipping a bundle
# with stale baked-in origins.
assert_baked_urls() {
  local js_dir="$OUTPUT_DIR/_expo/static/js/web"
  if [[ ! -d "$js_dir" ]]; then
    echo "[build-expo-web-export] BOARDSESH_EXPORT_EXPECT_URLS is set but no JS bundles were found in $js_dir" >&2
    exit 1
  fi

  local missing=()
  local expected_url
  for expected_url in $BOARDSESH_EXPORT_EXPECT_URLS; do
    if ! grep -rqF -- "$expected_url" "$js_dir"; then
      missing+=("$expected_url")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "[build-expo-web-export] expected URL(s) not found in any bundle under $js_dir:" >&2
    local missing_url
    for missing_url in "${missing[@]}"; do
      echo "  - $missing_url" >&2
    done
    exit 1
  fi

  echo "[build-expo-web-export] verified baked URL(s): $BOARDSESH_EXPORT_EXPECT_URLS"
}

if [[ -n "${BOARDSESH_EXPORT_EXPECT_URLS:-}" ]]; then
  assert_baked_urls
fi

echo "[build-expo-web-export] Expo web export (baseUrl $WEB_BASE_URL) written to $OUTPUT_DIR"
