import { type TextStyle } from 'react-native';

/**
 * Apple Human Interface Guidelines type scale.
 * Uses the system font (San Francisco on iOS, Roboto on Android).
 * No custom font families — we rely on the platform default.
 *
 * Note: largeTitle, title1, and title2 use bold (700) instead of
 * HIG's default Regular (400). This is intentional for brand identity.
 */

export type TypeStyle = Pick<TextStyle, 'fontSize' | 'fontWeight' | 'lineHeight'>;

export const textStyles = {
  largeTitle: {
    fontSize: 34,
    fontWeight: '700',
    lineHeight: 41,
  },
  title1: {
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
  },
  title2: {
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 28,
  },
  title3: {
    fontSize: 20,
    fontWeight: '600',
    lineHeight: 25,
  },
  headline: {
    fontSize: 17,
    fontWeight: '600',
    lineHeight: 22,
  },
  body: {
    fontSize: 17,
    fontWeight: '400',
    lineHeight: 22,
  },
  callout: {
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 21,
  },
  subheadline: {
    fontSize: 15,
    fontWeight: '400',
    lineHeight: 20,
  },
  footnote: {
    fontSize: 13,
    fontWeight: '400',
    lineHeight: 18,
  },
  caption1: {
    fontSize: 12,
    fontWeight: '400',
    lineHeight: 16,
  },
  caption2: {
    fontSize: 11,
    fontWeight: '400',
    lineHeight: 13,
  },
} as const satisfies Record<string, TypeStyle>;

/**
 * Material Design 3 (Roboto) type scale, used by the `material` UI variant. Same
 * keys as `textStyles` so a `Text` of a given `variant` resolves to one or the
 * other depending on `theme.variant`. The HIG scale's bold display weights drop
 * to M3's regular/medium (M3 reserves heavy weights for true display roles), and
 * sizes/line-heights track the closest MD3 role:
 *
 *   largeTitle → headlineMedium · title1 → headlineSmall · title2 → titleLarge
 *   headline → titleMedium · body/callout → bodyLarge · subheadline → bodyMedium
 *   footnote → bodySmall · caption1/caption2 → labelSmall
 */
export const materialTextStyles = {
  largeTitle: {
    fontSize: 28,
    fontWeight: '400',
    lineHeight: 36,
  },
  title1: {
    fontSize: 24,
    fontWeight: '400',
    lineHeight: 32,
  },
  title2: {
    fontSize: 22,
    fontWeight: '400',
    lineHeight: 28,
  },
  title3: {
    fontSize: 22,
    fontWeight: '500',
    lineHeight: 28,
  },
  headline: {
    fontSize: 16,
    fontWeight: '500',
    lineHeight: 24,
  },
  body: {
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 24,
  },
  callout: {
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 24,
  },
  subheadline: {
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 20,
  },
  footnote: {
    fontSize: 12,
    fontWeight: '400',
    lineHeight: 16,
  },
  caption1: {
    fontSize: 11,
    fontWeight: '500',
    lineHeight: 16,
  },
  caption2: {
    fontSize: 11,
    fontWeight: '500',
    lineHeight: 16,
  },
} as const satisfies Record<keyof typeof textStyles, TypeStyle>;

/**
 * Type scale resolved per UI variant — mirrors `radiiByVariant`/
 * `sheetChromeByVariant` in ./tokens. Liquid Glass keeps the Apple HIG scale
 * unchanged; Material swaps in the M3 (Roboto) scale. Consumed via
 * `theme.textStyles` (resolved in the provider) and read by `Text`.
 */
export const textStylesByVariant = {
  liquidGlass: textStyles,
  material: materialTextStyles,
} as const satisfies Record<'liquidGlass' | 'material', Record<keyof typeof textStyles, TypeStyle>>;

export type TextVariant = keyof typeof textStyles;

/**
 * Max Dynamic Type multiplier for labels inside fixed-height glass chrome — the
 * queue capsule and the iOS 26 bottom-accessory / now-playing-style rows, whose
 * height is pinned to the `glassSize` ladder. The global `Text` default (1.5×)
 * clips the single-line climb name + grade against those rigid heights, so cap
 * them at 1.2× — still meaningfully larger for low-vision users, but it fits the
 * platter. Surfaces that can grow with their content keep the 1.5× default.
 */
export const CHROME_LABEL_MAX_FONT_SCALE = 1.2;

// Status eyebrow above the climb name in the accessory bar — a small uppercase
// caption. Shared by the floating capsule and the iOS 26 native platter row so
// the two can't drift apart.
export const ACCESSORY_EYEBROW_TEXT_STYLE: TextStyle = {
  fontWeight: '700',
  letterSpacing: 0.4,
  textTransform: 'uppercase',
};
