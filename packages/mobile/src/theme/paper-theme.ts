import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';
import {
  brandColors,
  brandColorsDark,
  materialSurfaces,
  materialSurfaceContainers,
  materialElevationLevels,
  materialTonalContainers,
} from './colors';

type ColorScheme = 'light' | 'dark';

/**
 * M3 `outline`: the component border (text fields, outlined buttons). A fixed mid
 * grey that clears 3:1 on every Graphite container step (dark #8A8A8A 3.93:1 on the
 * highest; light #7A7A7A 3.04:1 on the highest).
 */
const materialOutline = { light: '#7A7A7A', dark: '#8A8A8A' } as const;

/**
 * Ink on the M3 `error` fill. White on the dark-scheme #F87171 is 2.77:1, so dark
 * takes a near-black ink (6.23:1); light keeps white on #C81E1E (5.74:1).
 */
const materialOnError = { light: '#FFFFFF', dark: '#1B1B1B' } as const;

/**
 * Build a react-native-paper Material 3 theme from our existing design tokens, so
 * the Material UI variant renders authentic MD3 components on our neutral
 * "Graphite" `materialSurfaces` ladder, with the Boardsesh violet kept for action
 * and state (primary, secondary, the tonal containers). Our theme stays the source
 * of truth — this is the downstream Paper consumer; the Liquid Glass variant never
 * touches it.
 *
 * Type scale + component shapes are left as Paper's MD3 defaults (system font:
 * Roboto on Android, San Francisco on iOS) — that IS the native Material look.
 * Only the colour roles are mapped from our tokens.
 *
 * The optional `dynamic` palette is the hook for the Material You fast-follow
 * (@pchmn/expo-material3-theme); unused today, callers pass `undefined`.
 */
export function buildPaperTheme(colorScheme: ColorScheme, dynamic?: MD3Theme['colors']): MD3Theme {
  const base = colorScheme === 'dark' ? MD3DarkTheme : MD3LightTheme;
  if (dynamic) {
    return { ...base, colors: { ...base.colors, ...dynamic } };
  }

  const surfaces = materialSurfaces[colorScheme];
  const containers = materialSurfaceContainers[colorScheme];
  const isDark = colorScheme === 'dark';
  const brand = isDark ? brandColorsDark : brandColors;
  const onSurface = surfaces.label as string;
  const onSurfaceVariant = surfaces.secondaryLabel as string;
  const tonal = materialTonalContainers[colorScheme];
  // M3 `primary` is a FOREGROUND role (selected tab label, text buttons, focused
  // field outline), so it takes the brand foreground tint — `#A78BFA` in dark
  // (6.13:1 on the `#1E1E1E` surface), not the fill-only `#7C3AED`. A
  // light `primary` then needs dark ink on top: `#2E1065`, the end of the brand
  // violet ramp (5.60:1 on `#A78BFA`). Light is unchanged: there `primary` and
  // `primaryFill` are both `#6D28D9` under white. Filled brand buttons don't use
  // this role; they paint `primaryFill` with white (`brandAccentColor`).
  const onPrimary = isDark ? '#2E1065' : brand.onPrimary;

  return {
    ...base,
    colors: {
      ...base.colors,
      primary: brand.primary,
      onPrimary,
      primaryContainer: tonal.primaryContainer,
      onPrimaryContainer: tonal.ink,
      // `secondary` stays the brand foreground: it is the active nav label.
      secondary: brand.primary,
      onSecondary: onPrimary,
      secondaryContainer: tonal.secondaryContainer,
      onSecondaryContainer: tonal.ink,
      // Amber accent is the M3 tertiary role — fill-only, so it carries dark text
      // in BOTH schemes (white fails on amber). Pin to the accent's own ink
      // (`onAccent`, the same in both schemes) rather than the per-scheme
      // `onSurface`, which would be near-white in dark and illegible on the accent.
      tertiary: brand.accent,
      onTertiary: brand.onAccent,
      // The amber accent's own tonal container (M3 tones 90 / 30 of #FF8A3D's hue,
      // with tones 10 / 90 as ink). Paper's default here is a pink from its
      // baseline palette, which says nothing about "lit". The Climbs bar's wall
      // pill fills with it: ink contrast 13.2:1 in light, 7.2:1 in dark.
      tertiaryContainer: isDark ? '#773300' : '#FFDBCA',
      onTertiaryContainer: isDark ? '#FFDBCA' : '#341100',
      background: surfaces.background as string,
      onBackground: onSurface,
      surface: surfaces.secondaryBackground as string,
      onSurface,
      // Neutral-variant surface for filled text fields / tonal fills — a real
      // toned container, not `tertiaryBackground` (`#FFFFFF` in light, which made
      // filled fields invisible).
      surfaceVariant: containers.base,
      onSurfaceVariant,
      // `outline` is the stronger form/component border; `outlineVariant` is the
      // faint divider, the same hairline as `separator`.
      outline: materialOutline[colorScheme],
      outlineVariant: surfaces.separator as string,
      error: brand.error,
      onError: materialOnError[colorScheme],
      // Elevation levels 1–5 are the Graphite container steps (low, base, high,
      // level4, highest), so Paper's elevated components (Surface/Menu/FAB/Card/
      // Dialog/Appbar) tier with our app surfaces and "+1 level on press/focus"
      // shows real depth, with no violet cast.
      elevation: {
        level0: 'transparent',
        ...materialElevationLevels(colorScheme),
      },
    },
  };
}
