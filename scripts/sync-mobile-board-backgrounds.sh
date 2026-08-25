#!/usr/bin/env bash
set -euo pipefail

# Kept as a compatibility entry point for contributors' existing workflows.
# Board art is no longer emitted as a Metro require graph. The shared static
# asset generator writes the metadata catalog consumed by both the native
# wrapper config plugin and Expo web.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
vp run generate:static-assets
