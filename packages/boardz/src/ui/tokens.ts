/** Spacing steps, in points (`designsystem/tokens/spacing.css`). */
export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

/** Side padding on phone. */
export const GUTTER = 20;

/** Corner radii: 3 mono tags, 5 badges, 8 grade tags and chips, 10 controls, 14 cards, 20 sheets. */
export const radius = {
  xs: 3,
  sm: 5,
  tag: 8,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

/** Apple's minimum comfortable tap target, and the filter strip height. */
export const MIN_TAP_SIZE = 44;

/** Problem rows. */
export const ROW_HEIGHT = 62;
