// Pure, node-testable press logic shared by both platform Button files. Keeping
// the guard + haptic here means the iOS and Android components can't drift on
// "what happens on tap", and it can be unit-tested without mounting a native
// @expo/ui tree. Mirrors SwitchRow.logic.ts.

import type { ViewStyle } from 'react-native';
import { hapticLight } from '../lib/haptics';
import type { ButtonVariant } from './Button.types';

/** Zero means full system text scaling. Fixed chrome opts into an explicit cap. */
export const DEFAULT_BUTTON_MAX_FONT_SCALE = 0;

export function resolveButtonMaxFontScale(maxFontSizeMultiplier: number | undefined): number {
  return maxFontSizeMultiplier ?? DEFAULT_BUTTON_MAX_FONT_SCALE;
}

/** The SwiftUI button style the iOS Button actually draws. */
export type IosButtonStyle = 'borderedProminent' | 'glassProminent' | 'glass' | 'bordered' | 'borderless';

/**
 * Which native style a tier draws. Filled is always `borderedProminent`; text is
 * `borderless`. The outlined/tonal middle tier depends on the surface: over
 * board art (`over="content"`) it becomes a solid scrim `borderedProminent`,
 * otherwise Liquid Glass on iOS 26 and `bordered` before it.
 */
export function resolveIosButtonStyle({
  variant,
  overContent,
  supportsGlass,
}: {
  variant: ButtonVariant;
  overContent: boolean;
  supportsGlass: boolean;
}): IosButtonStyle {
  if (variant === 'filled') return 'borderedProminent';
  if (variant === 'text') return 'borderless';
  if (overContent) return 'borderedProminent';
  return supportsGlass ? 'glass' : 'bordered';
}

/**
 * The SwiftUI label weight for the style actually drawn. Prominent styles are
 * semibold, like a system `.borderedProminent` call to action; bordered, glass
 * and borderless buttons are regular weight, as the system draws them (HIG
 * Buttons). Keyed on the drawn style, not the tier, so an outlined button that
 * turns into a solid scrim pill over board art gets the prominent weight.
 */
export function buttonLabelWeight(style: IosButtonStyle): 'semibold' | 'regular' {
  return style === 'borderedProminent' || style === 'glassProminent' ? 'semibold' : 'regular';
}

/**
 * Whether a Button's `style` asks it to fill its row's width. Only a POSITIVE
 * numeric `flex` grows — `flex: 0` means "don't grow", so it must not count
 * (`style.flex != null` would wrongly catch 0 and stretch the button). Shared by
 * both platform files so the iOS `frame({ maxWidth: Infinity })` and the Android
 * `fillMaxWidth()` stay in lockstep, and node-testable without a native tree.
 */
export function isFullWidthStyle(style: ViewStyle | undefined): boolean {
  return (
    style?.width === '100%' || (typeof style?.flex === 'number' && style.flex > 0) || style?.alignSelf === 'stretch'
  );
}

/**
 * Build the press handler used by both platform Button implementations: fires a
 * light haptic (unless `haptic` is false) then `onPress` — unless `disabled` or
 * `loading`, in which case it's a no-op (no haptic, no callback).
 *
 * `fireHaptic` is injectable so the unit test can assert it fires without a native
 * haptics module; production call sites use the default `hapticLight`.
 */
export function makeButtonPressHandler(
  {
    onPress,
    disabled = false,
    loading = false,
    haptic = true,
  }: { onPress: () => void; disabled?: boolean; loading?: boolean; haptic?: boolean },
  fireHaptic: () => void = hapticLight,
): () => void {
  return () => {
    if (disabled || loading) return;
    if (haptic) fireHaptic();
    onPress();
  };
}

/**
 * The height a caller has pinned on a Button, if any. A row that pairs two
 * buttons of DIFFERENT native styles (the tick bar's tonal Attempt beside the
 * filled Send) can't get them to one height any other way: each style derives
 * its own padding, so the two pills measure differently from the same label.
 *
 * Only a number counts. A percentage or `auto` can't be handed to a native
 * fixed-height modifier, and `undefined` is the normal "size yourself" case.
 */
export function pinnedButtonHeight(style: ViewStyle | undefined): number | undefined {
  return typeof style?.height === 'number' ? style.height : undefined;
}

/**
 * Which axes the native control must fill to match the RN box it was given.
 *
 * The iOS half of this is the load-bearing part: `.buttonStyle()` paints its
 * background around the button's LABEL, and every modifier applied to the
 * `Button` itself lands outside that paint. So a `frame(maxWidth: .infinity)`
 * on the button widens only the tap area and leaves a pill hugging its text,
 * centred in the leftover space — growing the LABEL is what grows the pill.
 * Returned as one record so both platform files ask the same question.
 */
export function buttonFillAxes(style: ViewStyle | undefined): { width: boolean; height: boolean } {
  return { width: isFullWidthStyle(style), height: pinnedButtonHeight(style) != null };
}

/**
 * `Host`'s `matchContents` for a Button: which axes the SwiftUI/Compose content
 * measures for itself, overwriting the RN style with `setStyleSize`.
 *
 * An axis the caller has sized — a positive `flex` across, a pinned `height`
 * down — must NOT be measured, or the native size is written back over the one
 * Yoga was told to use. That is why a `height` on a Button's style used to do
 * nothing at all.
 */
export function buttonMatchContents(style: ViewStyle | undefined): { horizontal: boolean; vertical: boolean } {
  const fills = buttonFillAxes(style);
  return { horizontal: !fills.width, vertical: !fills.height };
}

/**
 * The point size of SwiftUI's `body` text at each Dynamic Type size (Apple's
 * published table). `large` is the default.
 */
const BODY_POINT_SIZE_BY_DYNAMIC_TYPE = [
  ['xSmall', 14],
  ['small', 15],
  ['medium', 16],
  ['large', 17],
  ['xLarge', 19],
  ['xxLarge', 21],
  ['xxxLarge', 23],
  ['accessibility1', 28],
  ['accessibility2', 33],
  ['accessibility3', 40],
  ['accessibility4', 47],
  ['accessibility5', 53],
] as const;

export type ButtonDynamicTypeSize = (typeof BODY_POINT_SIZE_BY_DYNAMIC_TYPE)[number][0];

/**
 * The largest Dynamic Type size whose body text stays within `maxScale` of the
 * default, for SwiftUI's `dynamicTypeSize({ max })`. 1.3 gives `xxLarge` (21pt,
 * 1.24x): the next step, `xxxLarge`, is 23pt, 1.35x. Never below `large`, the
 * default, so a cap can only stop growth, never shrink a label.
 */
export function dynamicTypeSizeCap(maxScale: number): ButtonDynamicTypeSize {
  if (maxScale <= 0) return 'accessibility5';
  const defaultSize = 17;
  let cap: ButtonDynamicTypeSize = 'large';
  for (const [size, points] of BODY_POINT_SIZE_BY_DYNAMIC_TYPE) {
    if (points >= defaultSize && points / defaultSize <= maxScale) cap = size;
  }
  return cap;
}

/**
 * The Compose label's font size, in sp, that holds it at `maxScale` once Android
 * multiplies sp by the OS font scale. Undefined when the OS scale is within the
 * cap, so the label keeps the button's own type.
 */
export function cappedComposeLabelSize(
  defaultSize: number,
  fontScale: number,
  maxScale: number | undefined,
): number | undefined {
  if (maxScale == null || maxScale <= 0 || fontScale <= maxScale) return undefined;
  return (defaultSize * maxScale) / fontScale;
}

/** M3 labelLarge: 14sp text on a 20sp line. */
const LABEL_LARGE_SIZE = 14;
const LABEL_LARGE_LINE_HEIGHT = 20;

/**
 * The Compose Button label's style: M3 labelLarge (14/20, weight 500) on every
 * tier. When the OS scale passes the cap, the font size is held at the cap and
 * the line height scales with it, keeping labelLarge's 20/14 ratio; a capped
 * size on labelLarge's fixed 20sp line would leave the label mis-spaced.
 */
export function buttonLabelStyle(cappedSize: number | undefined): {
  typography: 'labelLarge';
  fontSize?: number;
  lineHeight?: number;
} {
  if (cappedSize == null) return { typography: 'labelLarge' };
  return {
    typography: 'labelLarge',
    fontSize: cappedSize,
    lineHeight: (cappedSize * LABEL_LARGE_LINE_HEIGHT) / LABEL_LARGE_SIZE,
  };
}
