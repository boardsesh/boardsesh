import { Platform, PlatformColor, type OpaqueColorValue } from 'react-native';
import {
  blendOpaque,
  brandColors,
  brandColorsDark,
  materialSurfaces,
  withAlpha,
  type BrandColors,
  type MaterialSurfaces,
} from '@boardsesh/velvet-tokens';

/**
 * iOS semantic system colors via PlatformColor.
 * These automatically adapt to light/dark mode and accessibility settings.
 *
 * This map is only populated on iOS. On Android, the ThemeProvider resolves
 * colors from `androidFallbackColors` instead. All color access should go
 * through `useTheme().systemColors` — never consume this directly.
 */
export const iosSystemColors: Record<string, OpaqueColorValue> | null =
  Platform.OS === 'ios'
    ? {
        background: PlatformColor('systemBackground'),
        secondaryBackground: PlatformColor('secondarySystemBackground'),
        tertiaryBackground: PlatformColor('tertiarySystemBackground'),
        groupedBackground: PlatformColor('systemGroupedBackground'),
        // Raised tile on top of a secondary/fill surface (e.g. the selected
        // segmented-control pill). tertiarySystemBackground sits a clear step
        // above secondary in both light and dark.
        elevatedSurface: PlatformColor('tertiarySystemBackground'),
        label: PlatformColor('label'),
        secondaryLabel: PlatformColor('secondaryLabel'),
        tertiaryLabel: PlatformColor('tertiaryLabel'),
        separator: PlatformColor('separator'),
        fill: PlatformColor('systemFill'),
        // Interactive-accent (links, active tab, edit·copy·open affordances).
        // PlatformColor('link') is Apple's link blue and adapts to dark natively.
        accent: PlatformColor('link'),
      }
    : null;

/**
 * The canonical Velvet Send brand palette, surface anchors, and colour helpers now
 * live in `@boardsesh/velvet-tokens` (shared with the web app). Re-exported here so
 * every existing `@/theme/colors` import path keeps working. Platform-specific
 * resolution (Android fallbacks, M3 tonal containers, the Play-Drawer tint) stays
 * below and computes on top of these anchors.
 */
export { blendOpaque, brandColors, brandColorsDark, materialSurfaces, withAlpha };
export type { BrandColors, MaterialSurfaces };

/**
 * Android-only fallback hex values for system colors, keyed by color scheme.
 * Used by the ThemeProvider to resolve the { light, dark } pairs on Android.
 */
export const androidFallbackColors = {
  light: {
    background: '#F4F1FB',
    secondaryBackground: '#FFFFFF',
    tertiaryBackground: '#FFFFFF',
    groupedBackground: '#F4F1FB',
    elevatedSurface: '#FFFFFF',
    label: '#16111F',
    // Opaque (not 0.6-alpha) so secondary text clears WCAG AA: #5B5563 = 6.44:1 on bg.
    secondaryLabel: '#5B5563',
    tertiaryLabel: '#8E8898',
    separator: 'rgba(60, 55, 75, 0.18)',
    fill: 'rgba(109, 40, 217, 0.1)',
    // Interactive-accent foreground (links, active tab, edit·copy·open). The
    // brand violet, lifted to #A78BFA in dark so it clears AA on near-black.
    accent: '#6D28D9',
  },
  dark: {
    background: '#0F0B16',
    secondaryBackground: '#181225',
    tertiaryBackground: '#221A32',
    groupedBackground: '#0F0B16',
    elevatedSurface: '#221A32',
    label: '#F5F2FB',
    secondaryLabel: '#A9A2B6',
    tertiaryLabel: '#6E687C',
    separator: 'rgba(180, 168, 205, 0.2)',
    fill: 'rgba(199, 184, 232, 0.12)',
    accent: '#A78BFA',
  },
} as const;

export type SystemColorKey = keyof typeof androidFallbackColors.light;
export type AndroidFallbackColors = typeof androidFallbackColors;

/**
 * Translucent tint composited over the Play Drawer's frosted material so its
 * full-screen "now playing" takeover reads as a denser, more opaque surface than
 * the lighter glass the other sheets use — board art behind it is muted, not
 * crisp. Kept translucent so the material still reads as frosted glass, just
 * heavier. Scheme-keyed so the drawer stays light in light mode and dark in dark
 * mode; only the opacity of the material changes.
 */
export const playDrawerMaterialTint = {
  light: 'rgba(255, 255, 255, 0.6)',
  dark: 'rgba(15, 11, 22, 0.55)',
} as const;

/**
 * Fixed backdrop painted behind every MoonBoard render (LayeredClimbImage),
 * regardless of light/dark mode (issue #3885, and the older #1449). MoonBoard
 * board art (moonboard-bg.webp + the holdset webps) is a near-fully-transparent
 * schematic — grid labels and hold icons only, no filled wall behind them — so
 * without an explicit backdrop it shows whatever's behind the image stack. In
 * the play view that's the modal's themed system background (app/play.tsx),
 * which turns near-black in dark mode and swallows the pale/neutral-toned
 * holds.
 *
 * Deliberately NOT keyed by colorScheme like `playDrawerMaterialTint` above:
 * MoonBoard panels are painted a real-world yellow, so a fixed tone reads as
 * the actual board in both modes rather than as a theme artifact — and it
 * keeps LayeredClimbImage (used everywhere a board renders: thumbnails,
 * discovery cards, the play view) free of a useTheme() dependency. Depicting
 * a compatible physical product's paint colour is fine (the same basis as
 * the board-art assets we already ship); no Moon branding/logo is used here.
 *
 * Value: RAL 1023 "Traffic Yellow" (#FAD201), the RAL code Moon Climbing
 * lists for MoonBoard panels. Cross-checked against
 * packages/moonboard-ocr/src/__tests__/fixtures/moonboard-grid-reference.jpg
 * (Moon's own board-art reference graphic, in-repo) — sampling its plain
 * background pixels averages ~#EEDF50, the same "golden yellow" family
 * (hue ~54° vs RAL 1023's ~50°) but lighter/less saturated, consistent with
 * print/JPEG reproduction rather than raw paint. Went with the RAL value:
 * closer to the paint spec, and its hue sits slightly further from the
 * MoonBoard start-hold green (see below), which is the pairing that matters
 * most for on-screen contrast.
 *
 * Hold-state contrast (WCAG relative-luminance ratio, MOONBOARD_HOLD_STATES
 * displayColor in moonboard-config.ts) at this value:
 *   - hand (#4444FF): 4.06:1 — passes WCAG AA for large-scale graphics (3:1).
 *   - finish (#FF3333): 2.47:1 — below 3:1, readable but not high-contrast.
 *   - start (#44FF44): 1.09:1 — effectively unreadable stroke-on-backdrop.
 * The green pairing is not fixable by tuning this hex: green and yellow are
 * adjacent, similarly-bright hues, so WCAG contrast stays under ~1.35:1 for
 * ANY backdrop light/saturated enough to still read as "yellow" — reaching
 * even 3:1 needs a backdrop luminance dark enough to look olive/khaki, which
 * defeats the fix. Verified darkening/desaturating from RAL 1023 does not
 * help here and actively worsens hand/finish contrast (a lighter backdrop
 * has MORE headroom against both blue and red), so this value is the local
 * optimum, not a compromise pending further tuning. The real fix for the
 * green pairing is a fixed dark outline on hold markers (a renderer-level
 * change, packages/board-renderer/core/src/renderer.rs) — out of scope here,
 * tracked as a follow-up rather than solved by backdrop colour alone.
 */
export const moonboardWallBackdrop = '#FAD201';

/**
 * M3 surface-tint percentages for the elevation overlay (levels 1–5). The brand
 * primary is alpha-composited over the base surface at these alphas to build the
 * tonal surface-container ramp — this IS M3's mechanism for expressing depth
 * (higher surface = more primary tint), so depth is tonal, not just a shadow.
 */
const m3SurfaceTint = { level1: 0.05, level2: 0.08, level3: 0.11, level4: 0.12, level5: 0.14 } as const;

/**
 * One container tone: the scheme's brand primary tinted over its base surface.
 * In light the ramp tones toward violet as it rises; in dark the brighter fill
 * lifts the near-black base — the canonical M3 direction in each scheme.
 */
function tintTone(scheme: 'light' | 'dark', alpha: number): string {
  const base = materialSurfaces[scheme].background;
  const primary = (scheme === 'dark' ? brandColorsDark : brandColors).primaryFill;
  return blendOpaque(primary, base, alpha);
}

/**
 * M3 surface-container tones for the Material variant, **computed** per scheme
 * (the hand-tuned `materialSurfaces` collapsed these to one or two values — light
 * `secondaryBackground`/`tertiaryBackground`/`elevatedSurface` were all `#FFFFFF`).
 * Computing from `base + primary` (not tuned hexes) keeps the five steps monotonic
 * and distinct, and lets a future Material You palette recompute them from a
 * dynamic primary without a rewrite. Named roles map onto Paper's elevation
 * levels: `low`↔level1, `base`↔level2, `high`↔level3, `highest`↔level5.
 */
export const materialSurfaceContainers = {
  light: {
    lowest: tintTone('light', 0.02),
    low: tintTone('light', m3SurfaceTint.level1),
    base: tintTone('light', m3SurfaceTint.level2),
    high: tintTone('light', m3SurfaceTint.level3),
    highest: tintTone('light', m3SurfaceTint.level5),
  },
  dark: {
    lowest: tintTone('dark', 0.02),
    low: tintTone('dark', m3SurfaceTint.level1),
    base: tintTone('dark', m3SurfaceTint.level2),
    high: tintTone('dark', m3SurfaceTint.level3),
    highest: tintTone('dark', m3SurfaceTint.level5),
  },
} as const;

/**
 * Paper elevation-level tones (level1–5) for the MD3 theme — the SAME ramp as the
 * named containers, so Paper's own elevated components (Surface/Menu/FAB/Card/
 * Dialog/Appbar) tier identically to our app surfaces instead of collapsing to
 * one `elevatedSurface` colour.
 */
export function materialElevationLevels(scheme: 'light' | 'dark'): {
  level1: string;
  level2: string;
  level3: string;
  level4: string;
  level5: string;
} {
  return {
    level1: tintTone(scheme, m3SurfaceTint.level1),
    level2: tintTone(scheme, m3SurfaceTint.level2),
    level3: tintTone(scheme, m3SurfaceTint.level3),
    level4: tintTone(scheme, m3SurfaceTint.level4),
    level5: tintTone(scheme, m3SurfaceTint.level5),
  };
}

export type MaterialSurfaceContainers = typeof materialSurfaceContainers.light;
