// Pure, node-testable press logic shared by both platform Button files. Keeping
// the guard + haptic here means the iOS and Android components can't drift on
// "what happens on tap", and it can be unit-tested without mounting a native
// @expo/ui tree. Mirrors SwitchRow.logic.ts.

import type { ViewStyle } from 'react-native';
import { hapticLight } from '../lib/haptics';

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
