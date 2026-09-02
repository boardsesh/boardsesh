#!/usr/bin/env bash
#
# Guards the three import boundaries that keep Android text readable in dark mode.
# Each one silently renders BLACK text when bypassed, so the failure mode is a
# shipped-and-unreadable screen rather than a crash:
#
#   1. `Host` from '@expo/ui' -> src/components/ThemedHost
#      A bare Host themes its native subtree from the DEVICE scheme. On Android the
#      JS palette (react-native useColorScheme) and the Compose theme
#      (isSystemInDarkTheme) both ignore the in-app Light/Dark override, so a dark
#      app on a light phone drew near-black Compose text on the dark surface.
#
#   2. `Text` from 'react-native' -> src/components/Text
#      RN's own Text defaults to a non-adaptive BLACK and breaks in dark mode. The
#      primitive defaults to theme.systemColors.label. See docs/ai-design-guidelines.md.
#
#   3. `useColorScheme` from 'react-native' -> useAppColorScheme (theme-provider)
#      RN's hook follows the OS trait collection and on Android does NOT track
#      Appearance.setColorScheme, so it reads 'light' for a user running the app's
#      own Dark theme on a light-mode phone (issue #3885).
#
# Why a bash guard and not just lint: `.oxlintrc.json` carries the equivalent
# `no-restricted-imports` rules (so editors / raw oxlint flag them), but `vp check`
# runs a reduced oxlint ruleset that silently drops `no-restricted-imports` — so it
# is NOT enforced by `vp check` or the pre-commit hook. This CI guard is the real
# backstop.
#
# Mirrors scripts/mobile-offline-sync-imports-check.sh. Exit 1 (CI failure) on any
# violation; 0 when clean.

set -euo pipefail
cd "$(dirname "$0")/.."

scan_dirs=(packages/mobile/src packages/mobile/app)
status=0

# Null-data mode treats each file as one record so multi-line import statements
# match; the specifier list is bounded by `[^;]*` so only a single statement is
# spanned. Each check excludes the wrapper that legitimately owns the import.
find_violations() {
  local pattern="$1"
  shift
  local allowed
  allowed=$(printf '%s\n' "$@")
  grep -rlzE "$pattern" "${scan_dirs[@]}" --include='*.ts' --include='*.tsx' \
    | tr '\0' '\n' \
    | grep -vxF "$allowed" \
    || true
}

# Files that predate the Text primitive and were audited when this guard landed:
# every `<Text>` in them already carries an explicit colour (a brand red for the
# auth error lines, theme.systemColors.* elsewhere), or they are the browser-only
# / dev-only surfaces. They stay on RN's Text so this guard can block NEW
# violations without a risky type-scale migration. Do not extend this list —
# migrate to the primitive instead.
text_primitive_legacy=(
  packages/mobile/app/auth/forgot-password.tsx
  packages/mobile/app/auth/login.tsx
  packages/mobile/app/auth/reset-password.tsx
  packages/mobile/src/components/AppMenu.web.tsx
  packages/mobile/src/components/BottomChromeDebugOverlay.tsx
  packages/mobile/src/components/ClimbAttributeIcons.tsx
  packages/mobile/src/components/SwitcherForm.web.tsx
  packages/mobile/src/components/auth/OAuthProviderButtons.web.tsx
  packages/mobile/src/components/play-drawer/AngleSlider.web.tsx
)

report() {
  local found="$1" title="$2" guidance="$3"
  if [ -n "$found" ]; then
    echo "✖ ${title}"
    echo "$found"
    echo
    echo "$guidance"
    echo
    status=1
  fi
}

report \
  "$(find_violations \
    "import[^;]*[{,[:space:]]Host[,[:space:]}][^;]*from[[:space:]]*['\"]@expo/ui['\"]" \
    "packages/mobile/src/components/ThemedHost.tsx")" \
  "\`Host\` imported from '@expo/ui' outside ThemedHost:" \
  "  Use ThemedHost (src/components/ThemedHost) instead — it passes the app-resolved
  colour scheme, so the Compose/SwiftUI subtree follows the in-app Light/Dark
  toggle rather than the device scheme."

report \
  "$(find_violations \
    "import[^;]*[{,[:space:]]Text[,[:space:]}][^;]*from[[:space:]]*['\"]react-native['\"]" \
    packages/mobile/src/components/Text.tsx "${text_primitive_legacy[@]}")" \
  "\`Text\` imported from 'react-native' outside the Text primitive:" \
  "  Use the Text primitive (src/components/Text) instead — it resolves the
  per-variant type scale and defaults the colour to theme.systemColors.label.
  RN's own Text defaults to a non-adaptive black."

report \
  "$(find_violations \
    "import[^;]*[{,[:space:]]useColorScheme[,[:space:]}][^;]*from[[:space:]]*['\"]react-native['\"]" \
    "packages/mobile/src/providers/theme-provider.tsx")" \
  "\`useColorScheme\` imported from 'react-native' outside the theme provider:" \
  "  Use useAppColorScheme() from src/providers/theme-provider — it honours the
  in-app appearance override, which RN's hook does not track on Android."

if [ "$status" -ne 0 ]; then
  exit 1
fi

echo "✓ Host, Text and useColorScheme are only imported through their theme-aware wrappers."
