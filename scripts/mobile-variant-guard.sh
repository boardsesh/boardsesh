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

# ── Floating glass chrome must carry a Material branch ──────────────────────────
# The second leak class (fixed in the Home/Discover M3 chrome PR): a screen or top
# chrome that MOUNTS the floating iOS-island primitives — GlassActionToolbar or
# CollapsingLargeTitleHeader — with no Material counterpart. GlassSurface only swaps
# the island FILL by variant (frosted vs opaque), never the LAYOUT, so an unbranched
# mount renders floating glass FABs/islands on Android (Material) where an M3 top app
# bar belongs. Flag any file that uses those primitives in JSX but contains no
# selectByVariant / createVariantComponent branch.
#
# Heuristic, not a proof: this is file-level (mounts a primitive AND mentions a
# branch helper somewhere) — a file that branches on an unrelated value could
# false-pass. That's acceptable for a backstop; the real guarantee is the per-screen
# Material Appbar branch + the screenshot diff.
#
# GLASS_CHROME_ALLOWLIST — glass-only sub-components whose CALLER owns the branch:
#  - PlaylistOwnerToolbar: the playlist-detail `renderActions(collapsed)` only mounts
#    it on the expanded-hero (collapsed=false) path; PlaylistDetailView asks for the
#    collapsed form on Material, which returns a variant-branched GlassIconButton
#    overflow instead. So it never renders on Android Material.
GLASS_CHROME_ALLOWLIST='playlist/PlaylistOwnerToolbar\.tsx'

glass_chrome_unbranched=''
while IFS= read -r file; do
  [ -z "$file" ] && continue
  if ! grep -qE 'selectByVariant|createVariantComponent' "$file"; then
    glass_chrome_unbranched="${glass_chrome_unbranched}${file}"$'\n'
  fi
done < <(
  grep -rlE "<(GlassActionToolbar|CollapsingLargeTitleHeader)\b" \
    packages/mobile/src/components packages/mobile/app \
    --include='*.tsx' \
    | grep -v '__tests__' \
    | grep -vE "$GLASS_CHROME_ALLOWLIST" \
    || true
)

if [ -n "$glass_chrome_unbranched" ]; then
  echo "✖ Floating glass chrome mounted without a Material branch:"
  echo "$glass_chrome_unbranched"
  echo "  These primitives render the iOS floating-island LAYOUT on every variant"
  echo "  (GlassSurface swaps only the fill). On Android (Material) that reads as glass"
  echo "  FABs/islands instead of an M3 top app bar. Route the chrome through"
  echo "  selectByVariant / createVariantComponent with a Material Appbar branch (see"
  echo "  CollapsingTopChrome / HomeTopChrome / ProfileTopChrome), or — for a glass-only"
  echo "  sub-component whose caller owns the branch — add it to GLASS_CHROME_ALLOWLIST"
  echo "  with a documented reason."
  exit 1
fi

echo "✓ No raw theme-variant compares, and no unbranched floating glass chrome, in mobile components/screens."
