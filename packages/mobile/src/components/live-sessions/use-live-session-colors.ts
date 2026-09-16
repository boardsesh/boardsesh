import { useMemo } from 'react';
import type { ColorValue } from 'react-native';
import { readableDarkText, readableTextColor } from '@boardsesh/board-constants/readable-text-color';
import { useTheme } from '../../providers/theme-provider';
import { androidFallbackColors, withAlpha } from '../../theme/colors';
import { selectByVariant } from '../../theme/variants';

export type LiveSessionColors = {
  /** Card plate: the grouped surface on Liquid Glass, M3 surface-container-low on Material. */
  surface: ColorValue;
  border: ColorValue;
  label: ColorValue;
  /**
   * Board, gym and elapsed text. iOS's `secondaryLabel` is 3.30:1 on a light
   * grouped card, under AA for 13pt text, so light mode uses the opaque
   * Velvet Send secondary (6.44:1) instead.
   */
  meta: ColorValue;
  live: string;
  /** Ink on the filled Live pill: #16111F on dark amber (11.09:1), white on light (5.02:1). */
  liveInk: string;
  primary: string;
  primaryFill: string;
  onPrimary: string;
  /** Tinted action capsule (Join / Open / Find climbers). */
  tintFill: string;
  tintBorder: string;
};

export function useLiveSessionColors(): LiveSessionColors {
  const { systemColors, brandColors, colorScheme, variant, m3, m3SurfaceContainers } = useTheme();
  return useMemo(() => {
    const liveInk =
      readableTextColor(brandColors.live) === readableDarkText ? brandColors.onAccent : brandColors.onPrimary;
    return {
      surface: selectByVariant<ColorValue>(variant, {
        liquidGlass: systemColors.secondaryBackground,
        material: m3SurfaceContainers.low,
      }),
      border: selectByVariant<ColorValue>(variant, {
        liquidGlass: systemColors.separator,
        material: m3.outlineVariant,
      }),
      label: systemColors.label,
      meta: colorScheme === 'light' ? androidFallbackColors.light.secondaryLabel : systemColors.secondaryLabel,
      live: brandColors.live,
      liveInk,
      primary: brandColors.primary,
      primaryFill: brandColors.primaryFill,
      onPrimary: brandColors.onPrimary,
      tintFill: withAlpha(brandColors.primary, colorScheme === 'dark' ? 0.18 : 0.12),
      tintBorder: withAlpha(brandColors.primary, 0.34),
    };
  }, [systemColors, brandColors, colorScheme, variant, m3, m3SurfaceContainers]);
}
