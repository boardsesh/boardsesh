import { brandColors } from './colors';

/**
 * The interactive-accent tint: the brand violet on every platform, the same
 * colour the @expo/ui controls tint with (HIG Color: one accent colour across
 * the app's interactive elements; Apple's link blue was a second tint).
 *
 * For FOREGROUND use prefer the scheme-aware `useTheme().systemColors.accent`
 * (lifts to #A78BFA in dark so it clears AA on near-black). This static value
 * stays as the FILL fallback for the few StyleSheet backgrounds that carry white
 * text (e.g. the logbook angle chip): white on #6D28D9 is 7.10:1.
 */
const ACCENT_TINT = brandColors.tint;

/**
 * iOS system color constants for use in contexts where PlatformColor
 * is unavailable (animated styles, default props, StyleSheet.create).
 *
 * These are the standard light-mode hex values from Apple's Human
 * Interface Guidelines. For dark-mode adaptivity, use PlatformColor
 * via the theme provider; these constants are for static / non-adaptive
 * usage only.
 */
export const iosSystemColors = {
  /** iOS systemRed — destructive actions, badges */
  systemRed: '#FF3B30',
  /** iOS systemGreen — success, positive indicators */
  systemGreen: '#34C759',
  /** iOS systemYellow — caution, moderate indicators */
  systemYellow: '#FFCC00',
  /** Interactive accent fill — the brand violet (static light value; see ACCENT_TINT). */
  systemBlue: ACCENT_TINT,
  /** iOS systemOrange — moderate warnings, attempted indicators */
  systemOrange: '#FF9500',
  /** iOS systemGray — secondary text, inactive tint */
  systemGray: '#8E8E93',
  /** iOS systemGray4 — chevrons, light chrome */
  systemGray4: '#C7C7CC',
  /** iOS separator color (light mode) */
  separator: 'rgba(60, 60, 67, 0.29)',
  /** Star/rating gold */
  starGold: '#FFB800',
  /** Pure white — text on colored backgrounds */
  white: '#FFFFFF',
  /** Pure black — text on light/yellow backgrounds where white wouldn't pass contrast (e.g. flash badge on systemYellow) */
  black: '#000000',
} as const;

/**
 * Dark-mode specific iOS system colors for contexts that need
 * manual dark/light switching.
 */
export const iosDarkColors = {
  /** iOS systemBackground (dark) — base screen background */
  background: '#000000',
  /** iOS secondarySystemBackground (dark) */
  secondaryBackground: '#1C1C1E',
  /** iOS systemGroupedBackground (dark) */
  groupedBackground: '#000000',
  /** iOS systemGray (dark) — inactive tint */
  systemGray: '#8E8E93',
  /** iOS separator (dark) */
  separator: '#38383A',
} as const;

/**
 * Light-mode specific iOS system colors for contexts that need
 * manual dark/light switching.
 */
export const iosLightColors = {
  /** iOS secondarySystemBackground (light) */
  secondaryBackground: '#F2F2F7',
  /** iOS systemGray2 — inactive tint (light) */
  inactiveGray: '#999999',
  /** iOS separator (light) */
  separator: '#C6C6C8',
} as const;

/** Neutral gray for image placeholder backgrounds */
export const neutralGray = '#E5E7EB';
