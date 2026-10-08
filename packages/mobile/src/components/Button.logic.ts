// Pure, node-testable press logic shared by both platform Button files. Keeping
// the guard + haptic here means the iOS and Android components can't drift on
// "what happens on tap", and it can be unit-tested without mounting a native
// @expo/ui tree. Mirrors SwitchRow.logic.ts.

import type { TextProps as ComposeTextProps } from '@expo/ui/jetpack-compose';
import type { ViewStyle } from 'react-native';
import { hapticLight } from '../lib/haptics';
import type { ButtonVariant } from './Button.types';

/**
 * How far any Button label may grow with the OS text size when the caller sets
 * no cap: 1.5x, the same ceiling every `Text` has (`maxFontSizeMultiplier={1.5}`
 * in Text.tsx). On iOS that resolves to the `xxxLarge` Dynamic Type size (body
 * 23pt, 1.35x), so a button label never outgrows the copy around it. A caller's
 * own cap (the tick bar's 1.3) still wins.
 */
export const DEFAULT_BUTTON_MAX_FONT_SCALE = 1.5;

/** The cap a Button applies: the caller's, else {@link DEFAULT_BUTTON_MAX_FONT_SCALE}. */
export function resolveButtonMaxFontScale(maxFontSizeMultiplier: number | undefined): number {
  return maxFontSizeMultiplier ?? DEFAULT_BUTTON_MAX_FONT_SCALE;
}

/**
 * The SwiftUI label weight per emphasis tier. Only the filled (prominent) tier is
 * semibold, like a system `.borderedProminent` call to action; outlined, tonal
 * and text buttons are regular weight, as system bordered and borderless buttons
 * are (HIG Buttons). Semibold on every tier made a row of secondary actions read
 * as louder than the one primary.
 */
export function buttonLabelWeight(variant: ButtonVariant): 'semibold' | 'regular' {
  return variant === 'filled' ? 'semibold' : 'regular';
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
  if (maxScale == null || fontScale <= maxScale) return undefined;
  return (defaultSize * maxScale) / fontScale;
}

/**
 * The Compose Button label's style: M3 labelLarge (14/20, weight 500) on every
 * tier, with the font size held at the cap when the OS scale passes it.
 */
export function buttonLabelStyle(cappedSize: number | undefined): NonNullable<ComposeTextProps['style']> {
  return cappedSize != null ? { typography: 'labelLarge', fontSize: cappedSize } : { typography: 'labelLarge' };
}
