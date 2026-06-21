import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';
import {
  brandColors,
  brandColorsDark,
  materialSurfaces,
  materialSurfaceContainers,
  materialElevationLevels,
  withAlpha,
  blendOpaque,
} from './colors';

type ColorScheme = 'light' | 'dark';

/**
 * Build a react-native-paper Material 3 theme from our existing design tokens, so
 * the Material UI variant renders authentic MD3 components tinted to the
 * Boardsesh brand (violet #6D28D9) and consistent with our `materialSurfaces`
 * ladder. Our theme stays the source of truth — this is the downstream Paper
 * consumer; the Liquid Glass variant never touches it.
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
  const surface = surfaces.secondaryBackground as string;
  // Explicit container ink — a near-black/near-white VIOLET that clears contrast
  // on the translucent-violet `primaryContainer`. Aliasing `onSurface` made it
  // near-white in dark, illegible on the dark-scheme container.
  const onPrimaryContainer = isDark ? '#EADDFF' : '#21005D';

  return {
    ...base,
    colors: {
      ...base.colors,
      primary: brand.primaryFill,
      onPrimary: brand.onPrimary,
      primaryContainer: withAlpha(brand.primaryFill, isDark ? 0.32 : 0.14),
      onPrimaryContainer,
      secondary: brand.primaryFill,
      onSecondary: brand.onPrimary,
      secondaryContainer: withAlpha(brand.primaryFill, isDark ? 0.28 : 0.16),
      onSecondaryContainer: onPrimaryContainer,
      // Amber accent is the M3 tertiary role — fill-only, so it carries dark text
      // in BOTH schemes (white fails on amber). Pin to the light-scheme label
      // token (the dark ink) rather than the per-scheme `onSurface`, which would
      // be near-white in dark and illegible on the accent.
      tertiary: brand.accent,
      onTertiary: materialSurfaces.light.label as string,
      background: surfaces.background as string,
      onBackground: onSurface,
      surface: surfaces.secondaryBackground as string,
      onSurface,
      // Neutral-variant surface for filled text fields / tonal fills — a real
      // toned container, not `tertiaryBackground` (`#FFFFFF` in light, which made
      // filled fields invisible).
      surfaceVariant: containers.base,
      onSurfaceVariant,
      // `outline` is the stronger form/component border (M3 ~ neutral-variant
      // mid-tone); `outlineVariant` is the faint divider. They were both aliased
      // to `separator` (0.18α), so borders and dividers were indistinguishable.
      outline: blendOpaque(onSurface, surface, 0.45),
      outlineVariant: surfaces.separator as string,
      error: brand.error,
      onError: '#FFFFFF',
      // Surface-tint ladder: the five elevation levels are now DISTINCT, monotonic
      // tonal steps (computed brand-over-surface), so Paper's elevated components
      // (Surface/Menu/FAB/Card/Dialog/Appbar) tier instead of collapsing to one
      // `elevatedSurface` colour — and "+1 level on press/focus" shows real depth.
      elevation: {
        level0: 'transparent',
        ...materialElevationLevels(colorScheme),
      },
    },
  };
}
