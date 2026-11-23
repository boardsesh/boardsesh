import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';
import { materialOutline } from '@boardsesh/velvet-tokens';
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
  // field outline), so it takes the brand foreground tint — `#9784FF` in dark
  // (5.60:1 on the `#1E1E1E` surface), not the fill-only `#7855FF`. A
  // light `primary` then needs dark ink on top: `#2E0077`, the dark end of the
  // brand's light heat ramp, same hue (5.11:1 on `#9784FF`). Light is unchanged:
  // there `primary` and `primaryFill` are both `#5B22F2` under white. Filled brand
  // buttons don't use this role; they paint `primaryFill` with white (`brandAccentColor`).
  const onPrimary = isDark ? '#2E0077' : brand.onPrimary;

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
      // The mint spark is the M3 tertiary role — fill-only, so it carries dark text
      // in BOTH schemes (white is 3.32:1 on the light mint). Pin to the spark's own
      // ink (`onAccent`, the same in both schemes: 5.58:1 light, 11.72:1 dark)
      // rather than the per-scheme `onSurface`, which would be near-white in dark
      // and illegible on the spark.
      tertiary: brand.accent,
      onTertiary: brand.onAccent,
      // The spark's own tonal container: M3's tone-90 / tone-30 containers and their
      // tone-10 / tone-90 ink, on mint's hue (OKLCH ~175). Paper's default here is a
      // pink from its baseline palette. Ink contrast 13.29:1 in light, 6.81:1 in dark.
      // Not for "lit": the Climbs bar's wall pill fills with `brandColors.live`, the
      // amber, so the spark never stands in for a climb on the wall.
      tertiaryContainer: isDark ? '#005747' : '#C5EEE2',
      onTertiaryContainer: isDark ? '#C5EEE2' : '#00231C',
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
