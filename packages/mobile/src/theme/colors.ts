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
 * Backdrop painted behind every MoonBoard render (LayeredClimbImage), keyed by
 * {@link MoonboardBackdropPreset} and light/dark mode (issue #3885, and the
 * older #1449). MoonBoard board art (moonboard-bg.webp + the holdset webps)
 * is a near-fully-transparent schematic — grid labels and hold icons only, no
 * filled wall behind them — so without an explicit backdrop it shows
 * whatever's behind the image stack. In the play view that's the modal's
 * themed system background (app/play.tsx), which turns near-black in dark
 * mode and swallows the pale/neutral-toned holds.
 *
 * Depicting a compatible physical product's paint colour is fine (the same
 * basis as the board-art assets we already ship); no Moon branding/logo is
 * used here.
 *
 * Base value (the `gold`/`classic` presets' light hex, and `classic`'s dark
 * hex): RAL 1023 "Traffic Yellow" (#FAD201), the RAL code Moon Climbing lists
 * for MoonBoard panels. Cross-checked against
 * packages/moonboard-ocr/src/__tests__/fixtures/moonboard-grid-reference.jpg
 * (Moon's own board-art reference graphic, in-repo) — sampling its plain
 * background pixels averages ~#EEDF50, the same "golden yellow" family (hue
 * ~54° vs RAL 1023's ~50°) but lighter/less saturated, consistent with
 * print/JPEG reproduction rather than raw paint.
 *
 * Hold-state contrast (WCAG relative-luminance ratio, MOONBOARD_HOLD_STATES
 * displayColor in moonboard-config.ts) is not fixable by backdrop tuning for
 * every ring simultaneously: green and yellow are adjacent, similarly-bright
 * hues, so the start ring (#44FF44) stays under ~1.35:1 contrast for ANY
 * backdrop light/saturated enough to still read as "yellow" — reaching even
 * 3:1 needs a backdrop luminance dark enough to look olive/khaki, which
 * defeats the point of a yellow wall. This is true across every preset below
 * (see the contrast table in PR #3899's description); the real fix for the
 * green ring is a fixed dark outline on hold markers (a renderer-level
 * change, packages/board-renderer/core/src/renderer.rs) — out of scope here,
 * tracked as a follow-up (issue #3913) rather than solved by backdrop colour
 * alone.
 *
 * Light vs. dark ARE deliberately different per preset (unlike the old
 * single-value constant this replaced) — a comfort problem, not a taste one.
 * `#FAD201` is a max-chroma field at ~103× the luminance of the dark-mode
 * chrome (`#141218`) once it fills most of a dark screen: a disability-glare
 * source for a dark-adapted eye. Light mode is glare-immune (bright
 * surround), so it keeps the literal RAL value with the best ring headroom;
 * dark mode's `gold` default (`#C0932E`) roughly halves that glare (103×→50×)
 * and, as a second comfort lever, warms the hue off yellow's 555 nm luminance
 * peak (91°→83°) so it reads as a warm painted wall rather than an electric
 * glow — while still roughly doubling the two holds the backdrop exists to
 * reveal (white plastic 1.20:1→2.30:1, the start ring 1.09:1→2.10:1).
 * Precedent for a light/dark split: `playDrawerMaterialTint` above.
 *
 * The dark values below are hand-tuned per preset, not derived from the light
 * value via `blendOpaque` — a pure blend toward the dark chrome can't warm
 * the hue off the 555 nm peak (it stays at RAL's 91°), and that hue shift is
 * a real, independently-useful comfort lever alongside luminance. Two
 * hand-specified hexes per preset (rather than one derived from the other)
 * is an accepted drift risk in exchange for that extra control.
 */
export type MoonboardBackdropPreset = 'classic' | 'gold' | 'dim' | 'neutral';

/**
 * Per-preset {light, dark} hex pairs. `neutral` is a genuine mid-grey FIELD —
 * never "no backdrop" — because falling back to the theme surface reintroduces
 * the exact #3885/#1449 pale-hold-swallow bug for the user who needs zero
 * chroma (CVD, migraine/light sensitivity) AND visible holds. `#524E47` keeps
 * white plastic at 6.74:1 and the start ring at 6.16:1 (both pass WCAG AA)
 * while removing the yellow-green colour confound entirely.
 */
export const MOONBOARD_BACKDROP_PRESETS: Record<MoonboardBackdropPreset, { light: string; dark: string }> = {
  gold: { light: '#FAD201', dark: '#C0932E' },
  classic: { light: '#FAD201', dark: '#FAD201' },
  dim: { light: '#E3B23C', dark: '#9E7F30' },
  neutral: { light: '#E7E2D8', dark: '#524E47' },
};

/** Resolves a MoonBoard backdrop preset + color scheme to its hex value. */
export function resolveMoonboardBackdrop(preset: MoonboardBackdropPreset, colorScheme: 'light' | 'dark'): string {
  return MOONBOARD_BACKDROP_PRESETS[preset][colorScheme];
}

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
