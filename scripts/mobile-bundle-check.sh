#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$SCRIPT_DIR/../packages/mobile"

if [ ! -d "$MOBILE_DIR" ]; then
  echo "[mobile-bundle] FAILED: packages/mobile/ not found at $MOBILE_DIR"
  exit 1
fi

cd "$MOBILE_DIR"

EXPORT_DIR="$MOBILE_DIR/.bundle-check-output"
trap 'rm -rf "$EXPORT_DIR"' EXIT

format_size() {
  local bytes="$1"
  if [ "$bytes" -ge 1048576 ]; then
    awk "BEGIN { printf \"%.1f MB\", $bytes / 1048576 }"
  elif [ "$bytes" -ge 1024 ]; then
    awk "BEGIN { printf \"%.1f KB\", $bytes / 1024 }"
  else
    echo "${bytes} B"
  fi
}

FAILED=0

for PLATFORM in ios android; do
  PLATFORM_DIR="$EXPORT_DIR/$PLATFORM"
  echo "[mobile-bundle] Bundling $PLATFORM..."

  if ! vp exec expo export --platform "$PLATFORM" --output-dir "$PLATFORM_DIR" 2>&1; then
    echo "[mobile-bundle] $PLATFORM bundle: FAILED"
    FAILED=1
    continue
  fi

  BUNDLE="$(find "$PLATFORM_DIR" \( -name '*.hbc' -o -name '*.js' \) | head -1)"
  if [ -n "$BUNDLE" ] && [ -f "$BUNDLE" ]; then
    BUNDLE_SIZE="$(stat --printf='%s' "$BUNDLE" 2>/dev/null || stat -f '%z' "$BUNDLE" 2>/dev/null)"
    echo "[mobile-bundle] $PLATFORM bundle: OK ($(format_size "$BUNDLE_SIZE"))"
  else
    echo "[mobile-bundle] $PLATFORM bundle: OK (bundle file not found for size check)"
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "[mobile-bundle] FAILED"
  exit 1
fi

exit 0
