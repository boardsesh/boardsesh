#!/usr/bin/env bash
set -euo pipefail

# Read-only dependency-health check for packages/mobile.
#
# Runs Expo's `install --check`, which compares each native dependency against
# the SDK-56 canonical pins in expo/bundledNativeModules.json and reports drift.
# This is the cheap Linux-runnable guard against the caret-drift class of bug
# that crashed the 2.0.0 launch: a `^` range silently resolving to a version the
# installed Expo SDK was never tested against.
#
# Deliberate deviations from the SDK pins live in `expo.install.exclude` in
# packages/mobile/package.json (e.g. async-storage held ahead for the new
# architecture, Sentry kept on v6 until the RN 0.86 migration). `--check`
# honours that list, so this task only fails on UNINTENTIONAL drift.
#
# READ-ONLY by contract: `--check` reports and exits non-zero, it never mutates
# package.json or bun.lock. NEVER add `--fix` here — that would rewrite manifests
# and move the lockfile. We invoke the workspace-local `expo` CLI wrapper (no
# bunx, which would touch bun.lock) from inside packages/mobile so the SDK pins
# and dependency map resolve from the right place.
#
# expo-doctor is intentionally NOT run here: it ships as a separate package that
# is not installed in this repo, so invoking it would require a network fetch
# (and bunx). Scope is `install --check` only.
#
# Usage: vp run check:mobile-deps

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$SCRIPT_DIR/../packages/mobile"

if [ ! -d "$MOBILE_DIR" ]; then
  echo "[mobile-deps] FAILED: packages/mobile/ not found at $MOBILE_DIR"
  exit 1
fi

EXPO_BIN="$MOBILE_DIR/node_modules/.bin/expo"
if [ ! -x "$EXPO_BIN" ]; then
  echo "[mobile-deps] FAILED: expo CLI not found at $EXPO_BIN — run 'bun install'"
  exit 1
fi

cd "$MOBILE_DIR"

echo "[mobile-deps] Checking native dependency pins against the Expo SDK..."

if ! "$EXPO_BIN" install --check; then
  echo "[mobile-deps] FAILED — dependencies drift from the Expo SDK pins."
  echo "[mobile-deps] Pin each flagged package to a tested version, or, if the"
  echo "[mobile-deps] deviation is intentional, add it to expo.install.exclude"
  echo "[mobile-deps] in packages/mobile/package.json. Do NOT run with --fix."
  exit 1
fi

echo "[mobile-deps] OK — native dependencies match the Expo SDK pins (or are explicitly excluded)."
exit 0
