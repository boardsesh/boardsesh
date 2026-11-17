import { useMemo } from 'react';
import type { ColorValue } from 'react-native';
import { readableDarkText, readableTextColor } from '@boardsesh/board-constants/readable-text-color';
import { useTheme } from '../../providers/theme-provider';
import { androidFallbackColors, withAlpha } from '../../theme/colors';
import { selectByVariant } from '../../theme/variants';
import { selectionWash } from '../../theme/variants/variant-tokens';

export type LiveSessionColors = {
  /** Card plate: the grouped surface on Liquid Glass, M3 surface-container-low on Material. */
  surface: ColorValue;
  border: ColorValue;
  label: ColorValue;
  /**
   * Board, gym and elapsed text. iOS's `secondaryLabel` is 3.30:1 on a light
   * grouped card, under AA for 13pt text, so light Liquid Glass uses the opaque
   * Velvet Send secondary (6.44:1) instead. Material's own secondaryLabel is
   * already opaque grey (#5A5A5A, 5.73:1 on the low container).
   */
  meta: ColorValue;
  live: string;
  /** Muted plate behind the "Quiet" pill of a session nobody is connected to. */
  quietFill: ColorValue;
  /** Ink on the filled Live pill: #16111F on dark amber (11.09:1), white on light (5.02:1). */
  liveInk: string;
  primary: string;
  primaryFill: string;
  onPrimary: string;
  /**
   * Tinted action capsule (Join / Open / Find climbers): the brand fill at the
   * selection wash's per-scheme alpha (13% light, 20% dark), never the tint.
   */
  tintFill: string;
  /** The capsule's hairline: a line, so it stays the foreground tint. */
  tintBorder: string;
  /**
   * Label and glyph on `tintFill`: `primaryStrong`, the brand foreground made for
   * text on a violet wash. The plain dark tint is 3.88:1 on the wash over a
   * #2C2C2E card; #A294FF is 4.52:1 (5.45:1 over #1C1C1E).
   */
  tintInk: string;
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
      meta: selectByVariant<ColorValue>(variant, {
        liquidGlass: colorScheme === 'light' ? androidFallbackColors.light.secondaryLabel : systemColors.secondaryLabel,
        material: systemColors.secondaryLabel,
      }),
      live: brandColors.live,
      quietFill: systemColors.fill,
      liveInk,
      primary: brandColors.primary,
      primaryFill: brandColors.primaryFill,
      onPrimary: brandColors.onPrimary,
      tintFill: selectionWash(brandColors.primaryFill, colorScheme),
      tintBorder: withAlpha(brandColors.primary, 0.34),
      tintInk: brandColors.primaryStrong,
    };
  }, [systemColors, brandColors, colorScheme, variant, m3, m3SurfaceContainers]);
}
