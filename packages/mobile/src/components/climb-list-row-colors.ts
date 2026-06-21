import { withAlpha } from '../theme/colors';

/**
 * Highlight colours for the active (selected) climb row, derived from the
 * scheme-aware brand primary. Pass `useTheme().brandColors.primary` so the wash
 * + accent track the colour scheme: in dark the resolved primary is the lifted
 * `#A78BFA` tint, not the dark `#6D28D9` fill (which is near-invisible on a
 * near-black row). Kept as a pure function so the per-scheme behaviour is unit
 * testable without rendering the (reanimated + swipeable) row.
 */
export function selectedRowColors(brandPrimary: string): { fill: string; accent: string } {
  return {
    // Subtle wash behind the row content.
    fill: withAlpha(brandPrimary, 0.18),
    // Solid left accent bar.
    accent: brandPrimary,
  };
}
