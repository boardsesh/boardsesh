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
// So the overlap is measured in window coordinates instead. Neither native sheet
// window resizes for the keyboard (the Android Compose dialog window included,
// emulator-verified), so the column pads itself by it.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  LayoutAnimation,
  Platform,
  useWindowDimensions,
  type KeyboardEvent,
  type KeyboardMetrics,
  type View,
} from 'react-native';
import { useWindowBottomInset } from '../hooks/use-window-bottom-inset';

export type SheetKeyboardInset = {
  /** Bottom padding for the chrome column: how far the keyboard reaches into
   * the column. 0 while the keyboard is down or misses the sheet. */
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
  /** `null` while the keyboard is down. */
  keyboard: SheetKeyboardFrame | null;
  windowInsetBottom: number;
  windowWidth: number;
  windowHeight: number;
  /** The column's bottom edge in window coordinates; `null` before the first
   * measurement, when it is taken to be the window's bottom edge. iOS only. */
  columnBottomInWindow: number | null;
};

/**
 * Pure maths behind `useSheetKeyboardInset`.
 *
 * - iOS: the overlap is measured, `columnBottom − keyboardTop`, both in window
 *   coordinates. On iPhone the sheet's bottom is the window's, so this is the
 *   keyboard height. On iPad, where UIKit can lift the sheet clear of the
 *   keyboard, it is what is actually left (often 0). An undocked or split iPad
 *   keyboard (narrower than the window) floats over content and is ignored.
 * - Android: RN reports the IME inset minus the system bars, and the
 *   edge-to-edge sheet draws over the navigation bar, so the overlap is the
 *   keyboard plus the window inset (emulator-verified on EndSessionSheet).
 * - Web: the Expo-web shim's Gorhom sheet does its own keyboard handling, and
 *   RN Web never fires keyboard events, so nothing is added.
 */
export function sheetKeyboardInset({
  platform,
  keyboard,
  windowInsetBottom,
  windowWidth,
  windowHeight,
  columnBottomInWindow,
}: SheetKeyboardGeometry): SheetKeyboardInset {
  const resting = { keyboardOverlap: 0, bottomInset: windowInsetBottom };
  if (!keyboard || keyboard.height <= 0) return resting;
  if (platform === 'android') {
    return { keyboardOverlap: keyboard.height + windowInsetBottom, bottomInset: 0 };
  }
  if (platform !== 'ios') return resting;
  // Undocked / split / floating: narrower than the window. 1pt of slack for
  // rounding between the two reports.
  if (keyboard.width + 1 < windowWidth) return resting;
  // Before the first measurement, or mid-presentation with the column still
  // below the screen, the window's bottom edge is the bound.
  const columnBottom = Math.min(columnBottomInWindow ?? windowHeight, windowHeight);
  const overlap = Math.max(0, Math.round(columnBottom - keyboard.screenY));
  return overlap > 0 ? { keyboardOverlap: overlap, bottomInset: 0 } : resting;
}

/** The on-screen keyboard frame an event reports, or `null` once it is down. */
function shownFrame(end: KeyboardMetrics | undefined, windowHeight: number): SheetKeyboardFrame | null {
  if (!end || end.height <= 0) return null;
  // iOS reports a hide as a frame moved below the window.
  if (Platform.OS === 'ios' && end.screenY >= windowHeight) return null;
  return { screenY: end.screenY, height: end.height, width: end.width };
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
 * `onColumnLayout` on the column so it can be measured in window coordinates;
 * it is re-measured on every keyboard event too, since a sheet UIKit lifts on
 * iPad moves without a layout change.
 *
 * On iOS the will-events ride the keyboard's own animation (as RN's
 * KeyboardAvoidingView does), so the footer slides with the keyboard instead of
 * jumping. Android's did-events arrive after the keyboard has moved.
 */
export function useSheetKeyboardInset({ enabled, onKeyboardShow }: SheetKeyboardInsetOptions) {
  const windowInsetBottom = useWindowBottomInset();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [keyboard, setKeyboard] = useState<SheetKeyboardFrame | null>(null);
  const [columnBottomInWindow, setColumnBottomInWindow] = useState<number | null>(null);
  const columnRef = useRef<View>(null);
  const windowHeightRef = useRef(windowHeight);
  windowHeightRef.current = windowHeight;
  const onKeyboardShowRef = useRef(onKeyboardShow);
  onKeyboardShowRef.current = onKeyboardShow;

  // iOS only: Android keeps its formula, which needs no position.
  const measureColumn = useCallback(() => {
    if (Platform.OS !== 'ios') return;
    columnRef.current?.measureInWindow((_x, y, _width, height) => {
      if (Number.isFinite(y) && height > 0) setColumnBottomInWindow(y + height);
    });
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
    let current = Keyboard.isVisible() ? shownFrame(Keyboard.metrics(), windowHeightRef.current) : null;
    keyboardUpRef.current = current != null;
    setKeyboard(current);
    measureColumn();

    const apply = (event: KeyboardEvent | undefined, hidden: boolean, animate: boolean) => {
      const next = hidden ? null : shownFrame(event?.endCoordinates, windowHeightRef.current);
      if (animate && Platform.OS === 'ios' && event) {
        // RCTLayoutAnimation's minimum accepted duration is 10ms.
        const duration = Math.max(event.duration ?? 0, 10);
        LayoutAnimation.configureNext({ duration, update: { duration, type: 'keyboard' } });
      }
      setKeyboard(next);
      measureColumn();
      if (next && !current) onKeyboardShowRef.current?.();
      current = next;
      keyboardUpRef.current = next != null;
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
    keyboard: enabled ? keyboard : null,
    windowInsetBottom,
    windowWidth,
    windowHeight,
    columnBottomInWindow,
  });
  return { ...inset, columnRef, onColumnLayout: measureColumn, measureAfterDetentChange };
}
