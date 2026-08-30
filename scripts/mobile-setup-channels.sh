#!/usr/bin/env bash
set -euo pipefail

# Creates the 4 preview channels on EAS. Run once after `eas init`.
# Each channel can independently point to a different EAS Update branch,
# allowing multiple worktrees to deliver updates to different test devices.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$SCRIPT_DIR/../packages/mobile"

cd "$MOBILE_DIR"

echo "[mobile:setup-channels] Creating preview channels..."

for i in 1 2 3 4; do
  echo "[mobile:setup-channels] Creating preview-$i..."
  vp dlx eas-cli@16 channel:create "preview-$i" --non-interactive 2>/dev/null || \
    echo "[mobile:setup-channels] preview-$i already exists"
done

echo ""
echo "[mobile:setup-channels] Done. Available channels:"
echo "  preview-1, preview-2, preview-3, preview-4"
echo ""
echo "[mobile:setup-channels] Point a channel at a branch:"
echo "  vp dlx eas-cli@16 channel:edit preview-1 --branch my-feature"
