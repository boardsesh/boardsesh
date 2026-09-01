#!/usr/bin/env bash
# Static-export Expo-web dev loop, reachable over Tailscale.
#
# The Metro-proxy loop (`vp run dev:mobile:web`) gives fast refresh but cold-
# bundles on every start (--clear) and races the orchestrator's readiness
# window on loaded machines. This loop trades fast refresh for robustness and
# prod-parity: it bakes a static export (the exact thing production serves)
# with the Tailscale origin inlined, then starts the regular dev stack with
# BOARDSESH_WEB=1 so Next serves the export at /app. Re-run the export (or
# this script) to pick up mobile-code changes; web code hot-reloads as usual.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Resolve the Tailscale MagicDNS name; fall back to localhost (http) when
# Tailscale is unavailable so the loop still works off-tailnet.
TS_HOST=$(tailscale status --json 2>/dev/null | python3 -c '
import json, sys
try:
    dns = json.load(sys.stdin).get("Self", {}).get("DNSName", "")
    print(dns.rstrip("."))
except Exception:
    pass
' || true)

if [[ -n "$TS_HOST" ]]; then
  WEB_ORIGIN="https://${TS_HOST}:3000"
  BACKEND_ORIGIN="https://${TS_HOST}:8081"
  WS_ORIGIN="wss://${TS_HOST}:8081/graphql"
else
  echo "[dev-expo-web-static] Tailscale unavailable — falling back to localhost (http)." >&2
  WEB_ORIGIN="http://localhost:3000"
  BACKEND_ORIGIN="http://localhost:8081"
  WS_ORIGIN="ws://localhost:8081/graphql"
fi

# expo export reuses Metro's transform cache even when EXPO_PUBLIC_* values
# change, silently shipping a bundle with the previous env inlined. Wipe the
# cache so the origins above genuinely land in the bundle.
rm -rf "${TMPDIR:-/tmp}"/metro-cache "${TMPDIR:-/tmp}"/metro-file-map-expo-* 2>/dev/null || true

echo "[dev-expo-web-static] Baking export for ${WEB_ORIGIN} (backend ${BACKEND_ORIGIN})..."
vp exec pnpm --dir packages/mobile/web-runtime install --frozen-lockfile
EXPO_PUBLIC_WEB_URL="$WEB_ORIGIN" \
EXPO_PUBLIC_BACKEND_URL="$BACKEND_ORIGIN" \
EXPO_PUBLIC_WS_URL="$WS_ORIGIN" \
  bash scripts/build-expo-web-export.sh

echo "[dev-expo-web-static] Export ready — starting the dev stack (/app serves the export)..."
BOARDSESH_WEB=1 exec ./node_modules/.bin/tsx scripts/dev-orchestrator.ts "$@"
