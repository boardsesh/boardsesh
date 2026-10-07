import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * The on-screen keyboard's height in points, 0 while it is down.
 *
 * For a content-sized bottom sheet: its bottom edge is pinned to the window's
 * bottom, so the keyboard height IS the overlap, and padding the content by it
 * lifts the field clear. A `KeyboardAvoidingView` can't be used there: RN 0.86
 * computes the overlap from its `onLayout` frame, which is relative to its
 * parent inside the sheet, not to the window, so it measures no overlap at all.
 *
 * iOS `will*` events fire before the animation (and don't exist on Android);
 * Android only fires the `did*` pair. The height is read straight off the event,
 * so the listeners never re-register mid-event (same pattern as
 * ClimbReactionMenu).
 */
export function useKeyboardHeight(): number {
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = Keyboard.addListener(showEvent, (event) => setKeyboardHeight(event.endCoordinates?.height ?? 0));
    const onHide = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);
  return keyboardHeight;
}
