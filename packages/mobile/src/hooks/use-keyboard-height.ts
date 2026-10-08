import { useEffect, useState } from 'react';
import { Keyboard, LayoutAnimation, Platform, type KeyboardEvent } from 'react-native';

/**
 * The on-screen keyboard's height in points, 0 while it is down.
 *
 * For a content-sized bottom sheet: its bottom edge is pinned to the window's
 * bottom, so the keyboard height IS the overlap, and padding the content by it
 * lifts the field clear. A `KeyboardAvoidingView` can't be used there: RN 0.86
 * computes the overlap from its `onLayout` frame, which is relative to its
 * parent inside the sheet, not to the window, so it measures no overlap at all.
 *
 * On iOS the change rides the keyboard's own animation (duration and the
 * 'keyboard' easing, as RN's KeyboardAvoidingView does), so the padding slides
 * with the keyboard instead of jumping. Android gets no animation: its `did*`
 * events arrive after the keyboard has already moved.
 *
 * Android reports the IME inset minus the system bars, so a caller drawn
 * edge-to-edge over the navigation bar adds the window inset itself.
 *
 * iOS `will*` events fire before the animation (and don't exist on Android);
 * Android only fires the `did*` pair. The height is read straight off the event,
 * so the listeners never re-register mid-event (same pattern as
 * ClimbReactionMenu).
 *
 * `enabled: false` registers no listeners and reads 0, for a caller that only
 * needs the height on one platform (it also skips the iOS LayoutAnimation).
 */
export function useKeyboardHeight(enabled = true): number {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const animate = (event: KeyboardEvent | undefined) => {
      if (Platform.OS !== 'ios' || !event) return;
      // RCTLayoutAnimation's minimum accepted duration is 10ms.
      const duration = Math.max(event.duration ?? 0, 10);
      LayoutAnimation.configureNext({ duration, update: { duration, type: 'keyboard' } });
    };
    const onShow = Keyboard.addListener(showEvent, (event) => {
      animate(event);
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    });
    const onHide = Keyboard.addListener(hideEvent, (event) => {
      animate(event);
      setKeyboardHeight(0);
    });
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, [enabled]);
  return enabled ? keyboardHeight : 0;
}
