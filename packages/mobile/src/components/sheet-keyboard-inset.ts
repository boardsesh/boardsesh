// Keyboard clearance for the shared `Sheet` / `ModalSheet` chrome column (the
// header + body + pinned footer wrapper).
//
// This replaced a `KeyboardAvoidingView behavior="padding"`. RN 0.86's KAV works
// out the overlap as `frame.y + frame.height - keyboard.screenY`, where `frame`
// is its own `onLayout` frame: relative to its PARENT, which inside the native
// `@expo/ui` sheet is the sheet's content view, not the window. So the KAV saw
// the column's bottom at roughly (column height + 16), and the keyboard top in
// window coordinates; the difference under-counted the overlap by the sheet's
// distance from the top of the screen. On the log-ascent sheet at its keyboard
// detent that left the Attempt / Save bar half under the keyboard.
//
// The native sheet window does not resize for the keyboard on either platform
// (the Android Compose dialog window included, emulator-verified), and its
// bottom edge is the window's bottom edge, so the keyboard's height IS the
// overlap. Same rule as `EndSessionSheet`.
import { Platform } from 'react-native';
import { useKeyboardHeight } from '../hooks/use-keyboard-height';
import { useWindowBottomInset } from '../hooks/use-window-bottom-inset';

export type SheetKeyboardInset = {
  /** Bottom padding for the chrome column: how far the keyboard reaches into
   * the sheet. 0 while the keyboard is down. */
  keyboardOverlap: number;
  /** The bottom safe-area inset the footer (or a footerless body) still owes.
   * The window inset while the keyboard is down; 0 while it is up, because the
   * keyboard already covers the home indicator / navigation bar. Replaced, never
   * added, so the footer rests `spacing[3]` above the keyboard. */
  bottomInset: number;
};

/**
 * Pure maths behind `useSheetKeyboardInset`.
 *
 * - iOS: the keyboard height includes the home-indicator strip, so the overlap
 *   is the keyboard height.
 * - Android: RN reports the IME inset minus the system bars, and the
 *   edge-to-edge sheet draws over the navigation bar, so the overlap is the
 *   keyboard plus the window inset.
 * - Web: the Expo-web shim's Gorhom sheet does its own keyboard handling, and RN
 *   Web never fires keyboard events, so nothing is added.
 */
export function sheetKeyboardInset(
  platform: typeof Platform.OS,
  keyboardHeight: number,
  windowInsetBottom: number,
): SheetKeyboardInset {
  const keyboardUp = keyboardHeight > 0 && (platform === 'ios' || platform === 'android');
  if (!keyboardUp) return { keyboardOverlap: 0, bottomInset: windowInsetBottom };
  return {
    keyboardOverlap: platform === 'android' ? keyboardHeight + windowInsetBottom : keyboardHeight,
    bottomInset: 0,
  };
}

/**
 * Live keyboard clearance for a sheet's chrome column. On iOS the change rides
 * the keyboard's own animation (`useKeyboardHeight` queues a LayoutAnimation),
 * so the footer slides with the keyboard instead of jumping.
 *
 * `hasChrome` false (no header or footer, so no column to pad) skips the
 * keyboard listeners, so a chrome-less sheet never re-renders for the keyboard
 * and keeps its resting window inset.
 */
export function useSheetKeyboardInset(hasChrome: boolean): SheetKeyboardInset {
  const keyboardHeight = useKeyboardHeight(hasChrome);
  const windowInsetBottom = useWindowBottomInset();
  return sheetKeyboardInset(Platform.OS, keyboardHeight, windowInsetBottom);
}
