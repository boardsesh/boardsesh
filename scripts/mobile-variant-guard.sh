#!/usr/bin/env bash
#
# Guards against raw UI-variant magic-string compares in mobile render bodies —
# components (`packages/mobile/src/components`) and screens (`packages/mobile/app`).
# The aesthetic variant (Material 3 vs Liquid Glass) must be routed through
# `selectByVariant` / `createVariantComponent` / a provider-resolved `theme.*` token
# — never an inline `variant === 'material'` / `=== 'liquidGlass'` comparison that
# can silently regrow. `src/providers` and `src/hooks` are NOT scanned: they
# legitimately resolve (theme-provider, resolveSystemColors, useEffectiveSurfaceMode)
# or compose (use-bottom-accessory: `variant === 'liquidGlass' && glassCapable`) the
# variant — that's the abstraction's plumbing, not a render-body branch.
# See packages/mobile/src/theme/variants/README.md.
#
# Deliberately scoped to the theme variant: the `[vV]ariant` token matches a
# `variant`, `uiVariant`, or `theme.variant` identifier (grep substring-matches, so
# the `.` in `theme.variant` is fine) compared to a UiVariant literal. It does NOT
# flag the orthogonal surface-capability axis (`mode === 'material'`,
# `surfaceMode === 'material'`) or unrelated props (`variant === 'filled'`,
# `=== 'scroll'`).
#
# Two escape hatches for genuine exceptions:
#   1. A trailing `// variant-ok` comment on the offending line (per-line opt-out).
#   2. The ALLOWLIST below (whole-file opt-out, for files whose `variant` is not the
#      theme variant or is an irreducible dual-axis check).
#
# Exit 1 (CI failure) on any unexpected match; 0 when clean.

set -euo pipefail
cd "$(dirname "$0")/.."

# Files whose flagged `variant === '…'` is NOT a routable theme-variant swap:
#  - AccessoryBarSurface: `mode === 'material' || variant === 'material'` is a genuine
#    dual-axis check (surface capability OR aesthetic) — see the four-axis model.
#  - UserAvatarToolbarAction: `variant` is the component's OWN `'glass' | 'material'`
#    prop, not `theme.variant`.
ALLOWLIST='queue-control/AccessoryBarSurface\.tsx|user-drawer/UserAvatarToolbarAction\.tsx'

matches=$(
  grep -rnE "[vV]ariant[[:space:]]*[!=]==[[:space:]]*'(material|liquidGlass)'" \
    packages/mobile/src/components packages/mobile/app \
    --include='*.tsx' --include='*.ts' \
    | grep -v '__tests__' \
    | grep -v 'variant-ok' \
    | grep -vE "$ALLOWLIST" \
    || true
)

if [ -n "$matches" ]; then
  echo "✖ Raw theme-variant compares found in mobile components/screens:"
  echo "$matches"
  echo
  echo "  Route the aesthetic variant through selectByVariant / createVariantComponent"
  echo "  / a theme.* token (see packages/mobile/src/theme/variants/README.md)."
  echo "  For a genuine exception, add a trailing  // variant-ok  comment, or extend"
  echo "  the ALLOWLIST in scripts/mobile-variant-guard.sh with a documented reason."
  exit 1
fi

echo "✓ No raw theme-variant compares in mobile components/screens."
