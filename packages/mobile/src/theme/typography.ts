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
  /**
   * Every top-bar and header button label: Cancel, Done, Save, Clear all. A bar
   * item on iOS is body-sized (17/22); the prominent confirm sets 600 on top.
   * See `theme/top-bar.ts` and docs/design/mobile-chrome.md, "Top-bar buttons".
   */
  label: {
    fontSize: 17,
    fontWeight: '400',
    lineHeight: 22,
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
 *   footnote → bodySmall · caption1/caption2 → labelSmall · label → labelLarge
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
  /** M3 labelLarge, the type of every button and top app bar action. */
  label: {
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 20,
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

type FontWeight = NonNullable<TextStyle['fontWeight']>;

/**
 * The emphasized weight of each style, for `<Text emphasized>`: the bold title in
 * a shelf header, the name in a row, a value that needs to stand out. Use it
 * instead of a `fontWeight` override, so emphasis is the same everywhere.
 *
 * Liquid Glass follows the HIG Typography table's "Emphasized weight" column:
 * Bold for Large Title, Title 1 and Title 2; Semibold for every other style.
 * Our display titles are already bold (a brand choice, see above), so for them
 * emphasis keeps the weight they have.
 */
export const emphasizedWeights = {
  largeTitle: '700',
  title1: '700',
  title2: '700',
  title3: '600',
  headline: '600',
  body: '600',
  callout: '600',
  subheadline: '600',
  footnote: '600',
  caption1: '600',
  caption2: '600',
  label: '600',
} as const satisfies Record<TextVariant, FontWeight>;

/**
 * Material's emphasized weights, from the M3 Expressive "emphasized" type styles
 * (Compose Material 3 `TypeScaleTokens`): Medium (500) for the display, headline,
 * title large and body roles; Bold (700) for title medium, title small and every
 * label role. Each key takes the weight of the M3 role it maps to (see
 * `materialTextStyles`); `title3` is titleLarge set in medium, so it stays 500.
 */
export const materialEmphasizedWeights = {
  largeTitle: '500',
  title1: '500',
  title2: '500',
  title3: '500',
  headline: '700',
  body: '500',
  callout: '500',
  subheadline: '500',
  footnote: '500',
  caption1: '700',
  caption2: '700',
  label: '700',
} as const satisfies Record<TextVariant, FontWeight>;

/** Emphasized weights resolved per UI variant, read by `Text`. */
export const emphasizedWeightsByVariant = {
  liquidGlass: emphasizedWeights,
  material: materialEmphasizedWeights,
} as const satisfies Record<'liquidGlass' | 'material', Record<TextVariant, FontWeight>>;

/**
 * Max Dynamic Type multiplier for labels inside fixed-height glass chrome — the
 * queue capsule and the iOS 26 bottom-accessory / now-playing-style rows, whose
 * height is pinned to the `glassSize` ladder. Uncapped `Text` would clip the
 * single-line climb name + grade against those rigid heights. Their labels
 * cap at 1.2× and use Large Content Viewer at accessibility sizes. Surfaces
 * that can grow with their content keep the uncapped default.
 */
export const CHROME_LABEL_MAX_FONT_SCALE = 1.2;

/**
 * Max Dynamic Type multiplier for the rest-timer sheet's hero clock. Higher than
 * the chrome cap (the sheet grows with its content, so the digits can afford to
 * get bigger) but stays bounded: at 34pt the widest reading the clock can
 * produce is a signed hour-long overrun, `-1:02:34`, and 1.5× puts that past the
 * width of a 375pt screen. 1.3× keeps the longest string on one line on the
 * narrowest phone we support.
 */
export const REST_CLOCK_MAX_FONT_SCALE = 1.3;
