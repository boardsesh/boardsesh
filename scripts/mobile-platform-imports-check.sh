#!/usr/bin/env bash
#
# Guards @expo/ui platform-specific imports to their platform file.
#
# `@expo/ui/swift-ui` resolves a native SwiftUI view at module load and crashes
# on Android ("Unable to get view config"); `@expo/ui/jetpack-compose` crashes the
# same way on iOS. So a swift-ui import may live ONLY in a `*.ios.{ts,tsx}` file,
# and a jetpack-compose import ONLY in a `*.android.{ts,tsx}` file. The universal
# `@expo/ui` root and `@expo/ui/community/*` are cross-platform and unrestricted.
#
# Why a bash guard and not just lint: `.oxlintrc.json` carries the equivalent
# `no-restricted-imports` rule (so editors / raw oxlint flag it), but `vp check`
# runs a reduced oxlint ruleset that silently drops `no-restricted-imports` — so it
# is NOT enforced by `vp check` or the pre-commit hook. This CI guard is the real
# backstop. See docs/expo-ui-components.md.
#
# Mirrors scripts/mobile-variant-guard.sh. Exit 1 (CI failure) on any misplaced
# import; 0 when clean.

set -euo pipefail
cd "$(dirname "$0")/.."

scan_dirs=(packages/mobile/src packages/mobile/app)
gorhom_scan_dirs=(packages/mobile packages/shared)

# swift-ui (and its sub-paths, e.g. /modifiers) must live only in *.ios.{ts,tsx}.
# Match a quoted module specifier so a stray mention in a comment doesn't trip it.
#
# Vitest suites under `__tests__/` are exempt: they name the specifier only to
# vi.mock() it (the call needs a literal path), they run in node, and Metro never
# reaches them from an app entry — so they cannot produce the device crash this
# guard exists to prevent. Everything Metro can reach is still scanned, and the
# exemption is narrow: `__tests__/<file>.test.ts(x)` only, so a production module
# can't dodge the guard by living in a test folder.
swiftui_bad=$(
  grep -rlE "['\"]@expo/ui/swift-ui" "${scan_dirs[@]}" \
    --include='*.ts' --include='*.tsx' \
    | grep -vE '\.ios\.(ts|tsx)$' \
    | grep -vE '/__tests__/[^/]+\.test\.(ts|tsx)$' \
    || true
)

# jetpack-compose (and sub-paths) must live only in *.android.{ts,tsx}.
compose_bad=$(
  grep -rlE "['\"]@expo/ui/jetpack-compose" "${scan_dirs[@]}" \
    --include='*.ts' --include='*.tsx' \
    | grep -vE '\.android\.(ts|tsx)$' \
    || true
)

# Gorhom was removed from native in #3167 after an Android freeze. Expo's
# Vaul-based web sheet renders, but does not implement the gesture-lock and
# keyboard contracts used by QueueSheet and LogAscentSheet and adds a scroll
# container around virtualized content. Web keeps Gorhom behind one compatibility
# shim for those flows (user-sanctioned web-only exception, 2026-07-17); no other
# app/shared module may import it. Metro's exact web redirect is the only non-shim
# source allowed to name the package.
gorhom_bad=$(
  rg -l -g '*.{ts,tsx,js,jsx,mjs,cjs}' "['\"]@gorhom/bottom-sheet" "${gorhom_scan_dirs[@]}" \
    | grep -vE '^packages/mobile/(metro\.config\.js|src/web-shims/bottom-sheet\.tsx)$' \
    || true
)

fail=0
if [ -n "$swiftui_bad" ]; then
  echo "✖ @expo/ui/swift-ui imported outside a *.ios.{ts,tsx} file:"
  echo "$swiftui_bad"
  fail=1
fi
if [ -n "$compose_bad" ]; then
  echo "✖ @expo/ui/jetpack-compose imported outside a *.android.{ts,tsx} file:"
  echo "$compose_bad"
  fail=1
fi
if [ -n "$gorhom_bad" ]; then
  echo "✖ @gorhom/bottom-sheet may only be imported by the Expo web sheet shim:"
  echo "$gorhom_bad"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "  These modules resolve a native view at module load and crash on the other"
  echo "  platform (\"Unable to get view config\"). Move the import into the matching"
  echo "  .ios.tsx / .android.tsx file, or pass plain values through a shared"
  echo "  *.logic.ts / *.types.ts helper. Import the universal Host and shared"
  echo "  components from the '@expo/ui' root instead. See docs/expo-ui-components.md."
  exit 1
fi

echo "✓ Expo UI platform imports and the web-only Gorhom boundary are valid."
