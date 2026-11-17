import { selectionWash } from '../theme/variants/variant-tokens';

/**
 * Highlight colours for the active (selected) climb row, derived from the
 * scheme-aware brand. Pass `useTheme().brandColors` and `useTheme().colorScheme`.
 * The wash is the brand FILL at the scheme's selection alpha, exactly the
 * `theme.selection.fill` role; the left accent bar is the tint (`primary`), the
 * lifted #9784FF in dark rather than the #7855FF fill. Kept as a pure function so
 * the per-scheme behaviour is unit testable without rendering the (reanimated +
 * swipeable) row.
 */
export function selectedRowColors(
  brand: { primary: string; primaryFill: string },
  colorScheme: 'light' | 'dark',
): { fill: string; accent: string } {
  return {
    // Subtle wash behind the row content.
    fill: selectionWash(brand.primaryFill, colorScheme),
    // Solid left accent bar.
    accent: brand.primary,
  };
}
