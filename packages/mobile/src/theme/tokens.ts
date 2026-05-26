/**
 * Cross-platform design tokens.
 *
 * Color tokens have moved to ./colors.ts
 * Typography tokens have moved to ./typography.ts
 * Animation tokens have moved to ./animations.ts
 */

import { iosSystemColors } from './ios-colors';

export const spacing = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export const borderRadius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

export const shadowColor = '#000' as const;

export const shadows = {
  xs: {
    shadowColor,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 1,
    elevation: 1,
  },
  sm: {
    shadowColor,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  md: {
    shadowColor,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  lg: {
    shadowColor,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 8,
  },
  xl: {
    shadowColor,
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 12,
  },
} as const;

export const opacity = {
  subtle: 0.7,
  disabled: 0.5,
} as const;

/** Shared bottom-sheet handle and background styles used by QueueSheet, AngleSelectorSheet, and PlayDrawer. */
export const sheetStyles = {
  indicator: {
    backgroundColor: `${iosSystemColors.systemGray}4D`,
    width: 36,
    height: 5,
    borderRadius: 3,
  },
  background: {
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
  },
} as const;

export type Spacing = typeof spacing;
export type BorderRadius = typeof borderRadius;
export type Shadows = typeof shadows;
export type Opacity = typeof opacity;
