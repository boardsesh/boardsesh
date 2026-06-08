import { Platform, PlatformColor, type OpaqueColorValue } from 'react-native';
import type { Material3Scheme } from '@pchmn/expo-material3-theme';

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
      }
    : null;

/**
 * Brand colors — "Velvet Send" system, anchored on the logo's V11–V16 purples.
 *
 * `brandColors` holds the LIGHT-scheme values (and the scheme-agnostic anchors);
 * `brandColorsDark` overrides the few roles that need a different value in dark
 * mode so they stay legible. The ThemeProvider resolves the right set per scheme
 * and exposes it as `useTheme().brandColors` — components should read brand
 * colours from the theme (not these constants) wherever the colour scheme matters.
 *
 * Role split:
 * - `primary`/`tint`: brand colour for FOREGROUND use (text, icons, links, borders).
 * - `primaryFill`: brand colour for a FILLED surface/button background.
 * - `onPrimary`: text/icon colour sitting on `primaryFill`.
 * - `accent`: warm amber spark for highlights — FILL-ONLY, always pair with dark text.
 *
 * Contrast (WCAG, light): white-on-primary #6D28D9 = 7.10:1; black-on-accent = 8.95:1.
 */
export const brandColors = {
  tint: '#6D28D9',
  primary: '#6D28D9',
  primaryFill: '#6D28D9',
  onPrimary: '#FFFFFF',
  accent: '#FF8A3D',
  success: '#047857',
  warning: '#B45309',
  error: '#C81E1E',
} as const;

/**
 * Dark-scheme brand overrides. The dark violet primary is too low-contrast as a
 * foreground on near-black, so the tint lifts to #A78BFA; filled buttons use a
 * brighter #7C3AED so white text still clears AA (5.70:1). Semantic tones brighten
 * for legibility on dark surfaces. Same keys as `brandColors`.
 *
 * Contrast (WCAG, dark): #A78BFA tint ≥6.12:1 across the dark surface ladder;
 * white-on-#7C3AED = 5.70:1.
 */
export const brandColorsDark = {
  tint: '#A78BFA',
  primary: '#A78BFA',
  primaryFill: '#7C3AED',
  onPrimary: '#FFFFFF',
  accent: '#FF8A3D',
  success: '#34D399',
  warning: '#FBBF24',
  error: '#F87171',
} as const;

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
  },
} as const;

/**
 * Material 3 tonal surfaces for the Material UI variant, keyed by color scheme.
 * Same shape as `androidFallbackColors` so the ThemeProvider can return them
 * directly as the resolved system colors on ANY platform when the user is on the
 * Material variant (including iOS 26 hardware where they chose Material).
 *
 * Neutrals are tinted toward the violet brand (#6D28D9) so Material reads as the
 * same product as Liquid Glass rather than a generic M3 theme. The Material feel
 * comes from elevation shadows, ripple, the nav active-indicator pill, and bounded
 * radii — not from a different palette. Labels use opaque values so text contrast
 * clears WCAG AA and matches the glass variant.
 */
export const materialSurfaces = {
  light: {
    // M3 base surface — violet-tinted so cards/elevation read against it.
    background: '#F3EFFA',
    // Cards and sheets sit a step up from the base (surface container low).
    secondaryBackground: '#FFFFFF',
    tertiaryBackground: '#FFFFFF',
    groupedBackground: '#F3EFFA',
    // Raised tile (selected segmented pill, elevated bar) — surface + elevation.
    elevatedSurface: '#FFFFFF',
    label: '#16111F',
    secondaryLabel: '#5B5563',
    tertiaryLabel: '#8E8898',
    // M3 outline-variant.
    separator: 'rgba(60, 55, 75, 0.18)',
    // Faint violet track for segmented controls / fills (bumped to 0.14 so selected
    // pills read on white).
    fill: 'rgba(109, 40, 217, 0.14)',
  },
  dark: {
    background: '#15101E',
    secondaryBackground: '#221A33',
    tertiaryBackground: '#2A2142',
    groupedBackground: '#15101E',
    elevatedSurface: '#2A2142',
    label: '#F5F2FB',
    secondaryLabel: '#A9A2B6',
    tertiaryLabel: '#6E687C',
    separator: 'rgba(180, 168, 205, 0.18)',
    fill: 'rgba(199, 184, 232, 0.14)',
  },
} as const;

export type SystemColorKey = keyof typeof androidFallbackColors.light;
export type MaterialColorScheme = keyof typeof materialSurfaces;
export type BrandColorKey = keyof typeof brandColors;
export type BrandColors = Record<BrandColorKey, string>;
export type AndroidFallbackColors = typeof androidFallbackColors;
export type MaterialSurfaces = typeof materialSurfaces;
export type MaterialSurfaceTokens = Record<SystemColorKey, string>;

/**
 * Normalise a `#RGB`/`#RRGGBB` hex string to a 6-digit hex (no `#`), or return
 * `null` for any other format (already-`rgba()`, named colour, PlatformColor).
 * Shared by `withAlpha` and `parseHex` so the expansion/validation rule can't
 * drift between them.
 */
function expandHex(color: string): string | null {
  const hex = color.replace('#', '');
  const full = hex.length === 3 ? hex.replace(/(.)/g, '$1$1') : hex;
  return full.length === 6 && !/[^0-9a-fA-F]/.test(full) ? full : null;
}

/**
 * Apply an alpha (0–1) to a colour. Handles `#RGB` and `#RRGGBB` hex by
 * emitting an `rgba()` string; any other format (already-`rgba()`, named
 * colour, PlatformColor) is returned unchanged so this never produces an
 * invalid colour value. Safer than concatenating a hex alpha suffix, which
 * only works for 6-digit hex.
 */
export function withAlpha(color: string, alpha: number): string {
  const full = expandHex(color);
  if (!full) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(`[withAlpha] expected a hex colour, got "${color}" — returning it unchanged (alpha not applied)`);
    }
    return color;
  }
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseHex(color: string): [number, number, number] | null {
  const full = expandHex(color);
  if (!full) return null;
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function toHexByte(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0');
}

/**
 * Alpha-composite `foreground` over `background` at `alpha` (0–1) and return an
 * opaque `#RRGGBB`. Unlike `withAlpha` (which yields a translucent `rgba()`),
 * this is for surfaces that float over arbitrary content and must stay opaque —
 * e.g. a variant-tinted toast pill that washes its brand hue over a neutral
 * surface yet can't let the content behind bleed through. Both inputs must be
 * `#RGB`/`#RRGGBB` hex; any other format returns `background` unchanged so this
 * never emits an invalid colour.
 */
export function blendOpaque(foreground: string, background: string, alpha: number): string {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(
        `[blendOpaque] expected hex colours, got foreground "${foreground}" / background "${background}" — returning background unchanged`,
      );
    }
    return background;
  }
  const mix = (channel: 0 | 1 | 2) => fg[channel] * alpha + bg[channel] * (1 - alpha);
  return `#${toHexByte(mix(0))}${toHexByte(mix(1))}${toHexByte(mix(2))}`;
}

/**
 * Convert a Material You / MD3 palette into the same semantic surface ladder
 * the token-skinned mobile components already consume through
 * `useTheme().systemColors`.
 */
export function materialSurfacesFromDynamicPalette(
  colorScheme: MaterialColorScheme,
  dynamicPalette: Material3Scheme,
): MaterialSurfaceTokens {
  const isDark = colorScheme === 'dark';

  return {
    background: dynamicPalette.background,
    secondaryBackground: dynamicPalette.surfaceContainerLow,
    tertiaryBackground: dynamicPalette.surfaceContainer,
    groupedBackground: dynamicPalette.background,
    elevatedSurface: dynamicPalette.elevation.level2,
    label: dynamicPalette.onSurface,
    secondaryLabel: dynamicPalette.onSurfaceVariant,
    tertiaryLabel: withAlpha(dynamicPalette.onSurface, 0.38),
    separator: dynamicPalette.outlineVariant,
    fill: withAlpha(dynamicPalette.primary, isDark ? 0.18 : 0.12),
  };
}

/**
 * Keep semantic status colours stable, but let Material-only accent chrome
 * follow the device's dynamic primary colour.
 */
export function brandColorsFromDynamicPalette(
  colorScheme: MaterialColorScheme,
  dynamicPalette?: Material3Scheme,
): BrandColors {
  const fallbackBrandColors = colorScheme === 'dark' ? brandColorsDark : brandColors;

  if (!dynamicPalette) {
    return fallbackBrandColors;
  }

  return {
    ...fallbackBrandColors,
    tint: dynamicPalette.primary,
    primary: dynamicPalette.primary,
    primaryFill: dynamicPalette.primary,
    onPrimary: dynamicPalette.onPrimary,
  };
}
