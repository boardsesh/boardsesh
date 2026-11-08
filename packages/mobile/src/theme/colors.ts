import { DynamicColorIOS, Platform, PlatformColor, type OpaqueColorValue } from 'react-native';
import { BOKEH_DARK_SURFACE, BOKEH_LIGHT_SURFACE } from '@boardsesh/frosted-bokeh';
import {
  blendOpaque,
  brandColors,
  brandColorsDark,
  materialSurfaces,
  withAlpha,
  type BrandColors,
  type MaterialSurfaces,
} from '@boardsesh/velvet-tokens';
import type { UiVariant } from './resolve-ui-variant';

/**
 * iOS semantic system colors via PlatformColor.
 * These automatically adapt to light/dark mode and accessibility settings.
 *
 * This map is only populated on iOS. On Android, the ThemeProvider resolves
 * colors from `androidFallbackColors` instead. All color access should go
 * through `useTheme().systemColors` — never consume this directly.
 */
/**
 * The iOS accent's four appearances. Light/dark are the brand `tint` per scheme;
 * the Increase Contrast pair steps one notch further along the brand violet ramp
 * (the same #4C1D95 / #C4B5FD ends the heat ramp uses).
 */
export const brandAccentDynamic = {
  light: brandColors.tint,
  dark: brandColorsDark.tint,
  highContrastLight: '#4C1D95',
  highContrastDark: '#C4B5FD',
} as const;

export const iosSystemColors: Record<string, OpaqueColorValue> | null =
  Platform.OS === 'ios'
    ? {
        background: PlatformColor('systemBackground'),
        secondaryBackground: PlatformColor('secondarySystemBackground'),
        tertiaryBackground: PlatformColor('tertiarySystemBackground'),
        groupedBackground: PlatformColor('systemGroupedBackground'),
        // The card that sits on `groupedBackground` (white in light, #1C1C1E in
        // dark): what a SwiftUI Form draws its rows on. `secondaryBackground` is
        // the opposite pairing (grey on white) and reads inverted on a settings page.
        secondaryGroupedBackground: PlatformColor('secondarySystemGroupedBackground'),
        // A block inside that card (a warning, a summary): #F2F2F7 in light,
        // #2C2C2E in dark. `tertiaryBackground` is white in light, the same as
        // the card, so a block drawn in it vanishes.
        tertiaryGroupedBackground: PlatformColor('tertiarySystemGroupedBackground'),
        // Raised tile on top of a secondary/fill surface (e.g. the selected
        // segmented-control pill). tertiarySystemBackground sits a clear step
        // above secondary in both light and dark.
        elevatedSurface: PlatformColor('tertiarySystemBackground'),
        label: PlatformColor('label'),
        secondaryLabel: PlatformColor('secondaryLabel'),
        tertiaryLabel: PlatformColor('tertiaryLabel'),
        separator: PlatformColor('separator'),
        fill: PlatformColor('systemFill'),
        // Error / destructive foreground. systemRed adapts to dark mode AND to
        // Increase Contrast, which a static hex cannot (HIG Color: "use system
        // colors… they automatically adapt to accessibility settings").
        error: PlatformColor('systemRed'),
        // Large-shape fill (cards, section grounds); `fill` is for small controls.
        tertiaryFill: PlatformColor('tertiarySystemFill'),
        // Interactive accent: the brand violet, the same tint the @expo/ui
        // controls use (HIG Color: one tint for every interactive element).
        // DynamicColorIOS so it still follows dark mode AND Increase Contrast,
        // as Apple's link colour did.
        accent: DynamicColorIOS(brandAccentDynamic) as OpaqueColorValue,
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

/**
 * `tertiaryFill` off iOS: the `fill` at roughly half its strength, so a large card
 * ground reads quieter than a small control's fill (the same step iOS takes from
 * systemFill to tertiarySystemFill). Keyed by variant because the two grounds
 * differ: Material's Graphite ladder is pure grey, so its fill is neutral white or
 * black; Liquid Glass off iOS still sits on the violet `androidFallbackColors`
 * ladder, so it keeps the violet wash.
 */
export const tertiaryFillFallback = {
  material: {
    light: 'rgba(0, 0, 0, 0.04)',
    dark: 'rgba(255, 255, 255, 0.05)',
  },
  liquidGlass: {
    light: 'rgba(109, 40, 217, 0.06)',
    dark: 'rgba(199, 184, 232, 0.07)',
  },
} as const satisfies Record<UiVariant, Record<'light' | 'dark', string>>;

/**
 * Android / Material `tertiaryGroupedBackground`: a block inside a grouped card.
 *
 * Their card is `secondaryBackground`, which is white in light, the same as
 * their `tertiaryBackground`, so the block takes the grouped page tone there
 * (as iOS does: #F2F2F7 on a white card). In dark the card is already a step up
 * from the page, so the block goes a step further up, to `tertiaryBackground`.
 */
export function tertiaryGroupedBackgroundFallback(
  surfaces: { groupedBackground: string; tertiaryBackground: string },
  colorScheme: 'light' | 'dark',
): string {
  return colorScheme === 'dark' ? surfaces.tertiaryBackground : surfaces.groupedBackground;
}

export type SystemColorKey = keyof typeof androidFallbackColors.light;
export type AndroidFallbackColors = typeof androidFallbackColors;

/**
 * Translucent tint composited over the Play Drawer's frosted material so its
 * full-screen "now playing" takeover reads as a denser, more opaque surface than
 * the lighter glass the other sheets use — board art behind it is muted, not
 * crisp. Kept translucent so the material still reads as frosted glass, just
 * heavier. Scheme-keyed so the drawer stays light in light mode and dark in dark
 * mode; only the opacity of the material changes.
 *
 * Keyed by variant first: Material's dark tint is the Graphite page (#0E0E0E), so
 * the drawer ground stays neutral; Liquid Glass keeps its violet near-black.
 */
export const playDrawerMaterialTint = {
  material: {
    light: 'rgba(255, 255, 255, 0.6)',
    dark: 'rgba(14, 14, 14, 0.55)',
  },
  liquidGlass: {
    light: 'rgba(255, 255, 255, 0.6)',
    dark: 'rgba(15, 11, 22, 0.55)',
  },
} as const satisfies Record<UiVariant, Record<'light' | 'dark', string>>;

/**
 * M3 surface-container tones for the Material variant, hand-set per scheme.
 *
 * "Graphite": pure greys (R = G = B), so depth reads by tone with no violet cast.
 * Dark rises from the #0E0E0E page in steps of about 1.5 to 4 L*; the #1E1E1E card
 * (`secondaryBackground`) sits between `base` and `high`. Light falls from the
 * #F2F2F2 page, below the white card. Each step is one Paper elevation level:
 * `low`↔level1, `base`↔level2, `high`↔level3, `level4`↔level4, `highest`↔level5.
 *
 * `base` is the MiniPlayer ground. It stays at #1A1A1A in dark so the filled
 * #7C3AED play button keeps a 3:1 edge on it; a lighter base drops under 3:1.
 * `material-theme-contrast.test.ts` pins every label, outline and accent pairing.
 */
export const materialSurfaceContainers = {
  light: {
    lowest: '#EEEEEE',
    low: '#EAEAEA',
    base: '#E4E4E4',
    high: '#DFDFDF',
    level4: '#DCDCDC',
    highest: '#D9D9D9',
  },
  dark: {
    lowest: '#121212',
    low: '#161616',
    base: '#1A1A1A',
    high: '#262626',
    level4: '#2A2A2A',
    highest: '#2E2E2E',
  },
} as const;

/**
 * The Material floating accessory bar (MiniPlayer card, climb capsule, rest
 * timer). It floats over cards, so in dark it takes the top container step:
 * the `base` step (#1A1A1A) sat darker than the #1E1E1E feed cards beneath it
 * (1.04:1) and read as a hole in the card (QA verdict 166). #2E2E2E is 1.23:1
 * on a card and 1.42:1 on the page, and `AccessoryBarSurface` adds a hairline
 * edge. Light keeps `base`, which already sits darker than the white cards.
 */
export const materialFloatingBarSurface = {
  light: materialSurfaceContainers.light.base,
  dark: materialSurfaceContainers.dark.highest,
} as const;

/**
 * Opaque M3 tonal containers, the one place Material keeps a violet surface: the
 * selected or current state (nav pill, selected chip, Stepper, tonal button,
 * connected MiniPlayer). Opaque so they read the same over any ground; a
 * translucent wash took the colour of whatever sat under it.
 *
 * Contrast (WCAG): ink #21005D on #EADDFF 13.3:1 and on #E6DAF8 12.9:1; ink #EADDFF
 * on #4F378B 7.23:1 and on #3C2467 9.93:1.
 */
export const materialTonalContainers = {
  light: { primaryContainer: '#EADDFF', secondaryContainer: '#E6DAF8', ink: '#21005D' },
  dark: { primaryContainer: '#4F378B', secondaryContainer: '#3C2467', ink: '#EADDFF' },
} as const;

/**
 * Paper elevation-level tones (level1–5) for the MD3 theme — the SAME table as the
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
  const containers = materialSurfaceContainers[scheme];
  return {
    level1: containers.low,
    level2: containers.base,
    level3: containers.high,
    level4: containers.level4,
    level5: containers.highest,
  };
}

/** One scheme's container table, widened to plain strings so a fixture can supply its own. */
export type MaterialSurfaceContainers = Record<keyof typeof materialSurfaceContainers.light, string>;

/**
 * The lit wall button's glow surfaces (#7000, look F1b): the pill the climb's
 * hold colours glow on, the label over them, and a plain 1 pt hairline border.
 * Dark: a near-black with an 8% frost, white label, white border at 20%. Light:
 * a pale violet the blobs multiply into, dark label, black border at 12%.
 * `wall-glow.ts` keeps the label at 4.5:1 over either.
 */
export const wallGlowSurfaces = {
  dark: { ...BOKEH_DARK_SURFACE, label: '#FFFFFF', border: 'rgba(255, 255, 255, 0.2)' },
  light: { ...BOKEH_LIGHT_SURFACE, label: '#16111F', border: 'rgba(0, 0, 0, 0.12)' },
} as const;
