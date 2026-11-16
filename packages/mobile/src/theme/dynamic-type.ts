// No runtime import from react-native: pure layout modules (charts, the live
// rail) use this too, and their tests load without a react-native mock. Callers
// pass `Platform.OS` in.
import type { TextProps } from 'react-native';
import type { TextVariant } from './typography';

/** The Dynamic Type text styles React Native's iOS `Text` can scale by. */
export type DynamicTypeRamp = NonNullable<TextProps['dynamicTypeRamp']>;

/**
 * The Dynamic Type ramp each text style scales on (iOS only), passed to every
 * `Text` as `dynamicTypeRamp`. Each style takes the UIKit text style of the same
 * name.
 *
 * Without a ramp, React Native scales every `Text` by one multiplier per content
 * size category: `RCTAccessibilityManager`'s table, which is also what
 * `useWindowDimensions().fontScale` reports on iOS. That table equals the body
 * curve up to xxxLarge and runs ahead of it at the accessibility sizes (AX3:
 * 2.643, where body is 40 / 17 = 2.353). With a ramp each style follows its own
 * UIKit curve instead. Against that table:
 *
 * - titles grow much less above Large (a large title is 0.87× at xxxLarge and
 *   0.58× at AX3);
 * - body, headline and label are the same up to xxxLarge and 8–13% smaller at
 *   AX1–AX5 (AX3: 0.89×);
 * - footnote and the captions grow up to 14% more at xLarge–xxxLarge and stay
 *   within a few percent at the accessibility sizes.
 *
 * `label` (every top-bar and header button) takes `body`: it is body-sized
 * (17/22, the size of a UIKit bar item), it is regular weight like body, and it
 * sits beside body-sized text in the bar, so the two should grow together.
 * `headline` is the other 17pt style, but it is the semibold row title.
 *
 * Any JS layout that multiplies a text height by `fontScale` must use
 * `textFontScale` instead, or it drifts from the text it measures.
 */
export const dynamicTypeRamps = {
  largeTitle: 'largeTitle',
  title1: 'title1',
  title2: 'title2',
  title3: 'title3',
  headline: 'headline',
  body: 'body',
  callout: 'callout',
  subheadline: 'subheadline',
  footnote: 'footnote',
  caption1: 'caption1',
  caption2: 'caption2',
  label: 'body',
} as const satisfies Record<TextVariant, DynamicTypeRamp>;

/**
 * React Native's own multiplier per content size category, xSmall → AX5
 * (`RCTAccessibilityManager.mm`, `multipliers`). On iOS `fontScale` is always one
 * of these, so it names the category.
 */
const REACT_NATIVE_FONT_SCALES = [0.823, 0.882, 0.941, 1, 1.118, 1.235, 1.353, 1.786, 2.143, 2.643, 3.143, 3.571];

/** Index of Large, the default category, in the tables here. */
const DEFAULT_CATEGORY = 3;

/**
 * Each ramp's point size per content size category, xSmall → AX5, from the HIG
 * Typography "iOS, iPadOS Dynamic Type sizes" tables. A ramped `Text` scales by
 * `UIFontMetrics.scaledValue(forValue: base) / base`, which is these sizes over
 * the Large one. SwiftUI's own text (native buttons) uses the same table.
 */
export const DYNAMIC_TYPE_POINT_SIZES = {
  largeTitle: [31, 32, 33, 34, 36, 38, 40, 44, 48, 52, 56, 60],
  title1: [25, 26, 27, 28, 30, 32, 34, 38, 43, 48, 53, 58],
  title2: [19, 20, 21, 22, 24, 26, 28, 34, 39, 44, 50, 56],
  title3: [17, 18, 19, 20, 22, 24, 26, 31, 37, 43, 49, 55],
  headline: [14, 15, 16, 17, 19, 21, 23, 28, 33, 40, 47, 53],
  body: [14, 15, 16, 17, 19, 21, 23, 28, 33, 40, 47, 53],
  callout: [13, 14, 15, 16, 18, 20, 22, 26, 32, 38, 44, 51],
  subheadline: [12, 13, 14, 15, 17, 19, 21, 25, 30, 36, 42, 49],
  footnote: [12, 12, 12, 13, 15, 17, 19, 23, 27, 33, 38, 44],
  caption1: [11, 11, 11, 12, 14, 16, 18, 22, 26, 32, 37, 43],
  caption2: [11, 11, 11, 11, 13, 15, 17, 20, 24, 29, 34, 40],
} as const satisfies Record<DynamicTypeRamp, readonly number[]>;

/**
 * The multiplier a ramped iOS `Text` applies, from the `fontScale` React Native
 * reports. Exact at each category's own `fontScale`; between two (only reachable
 * through a custom multiplier table or a test) it interpolates, and past either
 * end it scales on proportionally.
 */
export function rampFontScale(ramp: DynamicTypeRamp, fontScale: number): number {
  const sizes = DYNAMIC_TYPE_POINT_SIZES[ramp];
  const base = sizes[DEFAULT_CATEGORY];
  const last = REACT_NATIVE_FONT_SCALES.length - 1;
  if (fontScale <= REACT_NATIVE_FONT_SCALES[0]) {
    return (sizes[0] / base) * (fontScale / REACT_NATIVE_FONT_SCALES[0]);
  }
  for (let index = 0; index < last; index++) {
    const lower = REACT_NATIVE_FONT_SCALES[index];
    const upper = REACT_NATIVE_FONT_SCALES[index + 1];
    if (fontScale <= upper) {
      const progress = (fontScale - lower) / (upper - lower);
      return (sizes[index] + progress * (sizes[index + 1] - sizes[index])) / base;
    }
  }
  return (sizes[last] / base) * (fontScale / REACT_NATIVE_FONT_SCALES[last]);
}

/**
 * How much a `Text` of this variant grows at the given `fontScale`, for layout
 * that has to match it (a reserved line, a row height estimate, an icon beside
 * the text). On iOS that is the variant's ramp; elsewhere `Text` has no ramp and
 * grows by `fontScale` itself. Apply a `maxFontSizeMultiplier` cap after this,
 * as React Native does.
 *
 * The ramp follows the `Text`'s `variant`, not its final font size: a body
 * `Text` restyled to 34pt still scales on the body curve, so ask for `'body'`.
 * Pass `Platform.OS` as `platform`.
 *
 * The rule for layout: anything that sizes itself around non-body text, or
 * around body text above xxxLarge, reads this instead of `fontScale`. A cap of
 * 1.5 does not make `fontScale` safe: it never engages below AX1, and
 * footnote and the captions grow up to 14% past `fontScale` at xLarge–xxxLarge.
 */
export function textFontScale(variant: TextVariant, fontScale: number, platform: string): number {
  return platform === 'ios' ? rampFontScale(dynamicTypeRamps[variant], fontScale) : fontScale;
}
