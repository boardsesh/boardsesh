// Keyboard clearance for the shared `Sheet` / `ModalSheet` chrome column (the
// header + body + pinned footer wrapper), and for `ClimbFilterSheet`'s column.
//
// This replaced a `KeyboardAvoidingView behavior="padding"`. RN 0.86's KAV works
// out the overlap as `frame.y + frame.height - keyboard.screenY`, where `frame`
// is its own `onLayout` frame: relative to its PARENT, which inside the native
// `@expo/ui` sheet is the sheet's content view, not the window. That
// under-counted the overlap by the sheet's distance from the top of the screen.
// On the log-ascent sheet at its keyboard detent it left the Attempt / Save bar
// half under the keyboard.
//
// `measureInWindow` is sheet-local too: Fabric stops at RNHostView's layout
// root. On iOS SwiftUI shrinks that host to the keyboard top (simulator-verified
// for #5964). Measure an absolute-fill sibling's height, then pad the column's
// overflow past that host. Both measurements share the same coordinate space;
// no screen offset or SwiftUI probe is needed. Android keeps its IME formula.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  LayoutAnimation,
  Platform,
  useWindowDimensions,
  type KeyboardEvent,
  type KeyboardMetrics,
  type LayoutChangeEvent,
  type ViewInstance,
} from 'react-native';
import { useWindowBottomInset } from '../hooks/use-window-bottom-inset';

export type SheetKeyboardInset = {
  /** Bottom padding to keep the column inside its host. On iPad this also
   * clears the floating form's smaller bounds while the keyboard is down. */
  keyboardOverlap: number;
  /** The bottom safe-area inset the footer (or a footerless body) still owes.
   * The window inset at rest; 0 while the keyboard covers the sheet's bottom,
   * because it already covers the home indicator / navigation bar. Replaced,
   * never added, so the footer rests `spacing[3]` above the keyboard. */
  bottomInset: number;
};

/** The keyboard's end frame, from a keyboard event or `Keyboard.metrics()`. */
export type SheetKeyboardFrame = { screenY: number; height: number; width: number };

type SheetKeyboardGeometry = {
  platform: typeof Platform.OS;
  isPad?: boolean;
  /** `null` while the keyboard is down. */
  keyboard: SheetKeyboardFrame | null;
  windowInsetBottom: number;
  windowWidth: number;
  windowHeight: number;
  /** Both measurements are relative to the native sheet's layout root. */
  columnBottomInHost: number | null;
  hostHeight: number | null;
};

/**
 * Pure maths behind `useSheetKeyboardInset`.
 *
 * - iOS: SwiftUI's proposed host height ends at the keyboard top. Pad only
 *   the column's overflow past it, including the column's local y offset.
 *   A lifted iPad sheet whose column fits needs no padding. Undocked / split
 *   iPad keyboards (narrower than the window) are ignored. On iPad, clear
 *   overflow at rest too: fraction detents use the floating form's bounds.
 * - Android: RN reports the IME inset minus the system bars, and the
 *   edge-to-edge sheet draws over the navigation bar, so the overlap is the
 *   keyboard plus the window inset (emulator-verified on EndSessionSheet).
 * - Web: the Expo-web shim's Gorhom sheet does its own keyboard handling, and
 *   RN Web never fires keyboard events, so nothing is added.
 */
export function sheetKeyboardInset({
  platform,
  isPad = false,
  keyboard,
  windowInsetBottom,
  windowWidth,
  columnBottomInHost,
  hostHeight,
}: SheetKeyboardGeometry): SheetKeyboardInset {
  const hostOverflow =
    platform === 'ios' &&
    columnBottomInHost != null &&
    hostHeight != null &&
    Number.isFinite(columnBottomInHost) &&
    Number.isFinite(hostHeight) &&
    hostHeight > 0
      ? Math.max(0, Math.round(columnBottomInHost - hostHeight))
      : 0;
  // iPad fraction detents use the floating form's maximum, while the fixed
  // column estimate uses the window. Keep its footer reachable at rest too.
  const resting = { keyboardOverlap: isPad ? hostOverflow : 0, bottomInset: windowInsetBottom };
  if (!keyboard || keyboard.height <= 0) return resting;
  if (platform === 'android') {
    return { keyboardOverlap: keyboard.height + windowInsetBottom, bottomInset: 0 };
  }
  if (platform !== 'ios') return resting;
  // Undocked / split / floating: narrower than the window. 1pt of slack for
  // rounding between the two reports.
  if (keyboard.width + 1 < windowWidth) return resting;
  return hostOverflow > 0 ? { keyboardOverlap: hostOverflow, bottomInset: 0 } : resting;
}

/** What a keyboard event says: whether the keyboard is on screen, and the
 * frame to pad by. `frame` is `null` while it is down, and also while it is up
 * but its frame does not say where it is. */
type KeyboardReading = { shown: boolean; frame: SheetKeyboardFrame | null };

const KEYBOARD_DOWN: KeyboardReading = { shown: false, frame: null };

function readKeyboard(end: KeyboardMetrics | undefined, windowHeight: number): KeyboardReading {
  if (!end || end.height <= 0) return KEYBOARD_DOWN;
  if (Platform.OS === 'ios') {
    // iOS reports a hide as a frame moved below the window.
    if (end.screenY >= windowHeight) return KEYBOARD_DOWN;
    // With Settings › Accessibility › Motion › Prefer Cross-Fade Transitions on,
    // iOS reports `screenY` 0, which would read as a keyboard covering the
    // whole window and pad the column by its full height. RN's
    // KeyboardAvoidingView pads nothing for this frame
    // (`KeyboardAvoidingView.js`, `_relativeKeyboardHeight`); do the same. A
    // docked keyboard never starts at the top of the window, so no real frame
    // is lost. The keyboard IS up, though: it still counts as a show, so the
    // sheets rise to their keyboard detent.
    if (end.screenY <= 0) return { shown: true, frame: null };
  }
  return { shown: true, frame: { screenY: end.screenY, height: end.height, width: end.width } };
}

/** How long a native detent change takes to settle before re-measuring. */
export const SHEET_SETTLE_MS = 300;

type SheetKeyboardInsetOptions = {
  /** Listen only while there is a column to pad AND the sheet is open: a
   * closed sheet never re-renders for the keyboard. */
  enabled: boolean;
  /** Fired when the keyboard comes up while enabled (not when it was already
   * up as the sheet opened). The sheets raise themselves to their keyboard
   * detent here. */
  onKeyboardShow?: () => void;
};

/**
 * Live keyboard clearance for a sheet's chrome column. Put `columnRef` and
 * `onColumnLayout` on the column and `onHostLayout` on an absolute-fill sibling.
 * Their measurements share the sheet's coordinates, including on iPad.
 *
 * On iOS the will-events ride the keyboard's own animation (as RN's
 * KeyboardAvoidingView does), so the footer slides with the keyboard instead of
 * jumping. Android's did-events arrive after the keyboard has moved.
 */
export function useSheetKeyboardInset({ enabled, onKeyboardShow }: SheetKeyboardInsetOptions) {
  const windowInsetBottom = useWindowBottomInset();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [keyboard, setKeyboard] = useState<SheetKeyboardFrame | null>(null);
  const [columnBottomInHost, setColumnBottomInHost] = useState<number | null>(null);
  const [hostHeight, setHostHeight] = useState<number | null>(null);
  const columnRef = useRef<ViewInstance>(null);
  const windowHeightRef = useRef(windowHeight);
  windowHeightRef.current = windowHeight;
  const onKeyboardShowRef = useRef(onKeyboardShow);
  onKeyboardShowRef.current = onKeyboardShow;

  // iOS only: Android keeps its formula, which needs no position.
  const measureColumn = useCallback(() => {
    if (Platform.OS !== 'ios') return;
    columnRef.current?.measureInWindow((_x, y, _width, height) => {
      if (Number.isFinite(y) && height > 0) setColumnBottomInHost(y + height);
    });
  }, []);

  const onHostLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    if (Number.isFinite(height) && height > 0) setHostHeight(height);
  }, []);

  // A detent change (the keyboard raise included) animates the sheet AFTER the
  // keyboard's did-event, and nothing lays the column out again once that move
  // ends, so take one more measurement once it has settled.
  const keyboardUpRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureAfterDetentChange = useCallback(() => {
    if (!keyboardUpRef.current) return;
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      measureColumn();
    }, SHEET_SETTLE_MS);
  }, [measureColumn]);
  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!enabled) {
      keyboardUpRef.current = false;
      setKeyboard(null);
      return undefined;
    }
    // Opened with the keyboard already up: start from where it is.
    const opening = Keyboard.isVisible()
      ? readKeyboard(Keyboard.metrics() ?? undefined, windowHeightRef.current)
      : KEYBOARD_DOWN;
    // "Up" is tracked apart from the frame: a frame that cannot be padded by
    // (cross-fade's `screenY` 0) is still a keyboard on screen.
    let shown = opening.shown;
    keyboardUpRef.current = shown;
    setKeyboard(opening.frame);
    measureColumn();

    const apply = (event: KeyboardEvent | undefined, hidden: boolean, animate: boolean) => {
      const next = hidden ? KEYBOARD_DOWN : readKeyboard(event?.endCoordinates, windowHeightRef.current);
      if (animate && Platform.OS === 'ios' && event) {
        // RCTLayoutAnimation's minimum accepted duration is 10ms.
        const duration = Math.max(event.duration ?? 0, 10);
        LayoutAnimation.configureNext({ duration, update: { duration, type: 'keyboard' } });
      }
      setKeyboard(next.frame);
      measureColumn();
      if (next.shown && !shown) onKeyboardShowRef.current?.();
      shown = next.shown;
      keyboardUpRef.current = next.shown;
    };

    const isPad = Platform.OS === 'ios' && Platform.isPad;
    const subscriptions = isPad
      ? [
          // iPad: did-events only. At the will-event UIKit has not yet lifted a
          // centred sheet, so the full keyboard height would animate in and
          // then snap back to 0 at the did-event. The did-event also reports a
          // hide (the frame below the window).
          Keyboard.addListener('keyboardDidChangeFrame', (event) => apply(event, false, false)),
        ]
      : Platform.OS === 'ios'
        ? [
            // iPhone: will-events animate with the keyboard; the did-event
            // re-measures once the keyboard has landed.
            Keyboard.addListener('keyboardWillChangeFrame', (event) => apply(event, false, true)),
            Keyboard.addListener('keyboardWillHide', (event) => apply(event, true, true)),
            Keyboard.addListener('keyboardDidChangeFrame', (event) => apply(event, false, false)),
          ]
        : [
            Keyboard.addListener('keyboardDidShow', (event) => apply(event, false, false)),
            Keyboard.addListener('keyboardDidHide', (event) => apply(event, true, false)),
          ];
    return () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }, [enabled, measureColumn]);

  const inset = sheetKeyboardInset({
    platform: Platform.OS,
    isPad: Platform.OS === 'ios' && Platform.isPad,
    keyboard: enabled ? keyboard : null,
    windowInsetBottom,
    windowWidth,
    windowHeight,
    columnBottomInHost: enabled ? columnBottomInHost : null,
    hostHeight: enabled ? hostHeight : null,
  });
  return { ...inset, columnRef, onColumnLayout: measureColumn, onHostLayout, measureAfterDetentChange };
}
