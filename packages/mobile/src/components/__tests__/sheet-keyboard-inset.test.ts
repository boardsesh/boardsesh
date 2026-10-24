// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { LayoutChangeEvent } from 'react-native';

type KeyboardEnd = { height: number; screenY: number; width: number };
type KeyboardListener = (event: { endCoordinates?: KeyboardEnd; duration?: number }) => void;
const native = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  isPad: false,
  listeners: new Map<string, KeyboardListener>(),
  visible: false,
  metrics: undefined as KeyboardEnd | undefined,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.os;
    },
    get isPad() {
      return native.isPad;
    },
  },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  Keyboard: {
    addListener: (eventName: string, listener: KeyboardListener) => {
      native.listeners.set(eventName, listener);
      return { remove: () => native.listeners.delete(eventName) };
    },
    isVisible: () => native.visible,
    metrics: () => native.metrics,
  },
  LayoutAnimation: { configureNext: () => {} },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

import { SHEET_SETTLE_MS, sheetKeyboardInset, useSheetKeyboardInset } from '../sheet-keyboard-inset';

// An iPhone-sized window: 390 x 844, 34pt home indicator, 336pt keyboard.
const WINDOW = { windowWidth: 390, windowHeight: 844, windowInsetBottom: 34 };
const DOCKED = { height: 336, screenY: 844 - 336, width: 390 };

function hostLayout(height: number): LayoutChangeEvent {
  return { nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } } as LayoutChangeEvent;
}

function measureColumn(current: ReturnType<typeof useSheetKeyboardInset>, columnBottom = 660, hostHeight = 324) {
  const measureInWindow = vi.fn((callback: (x: number, y: number, width: number, height: number) => void) =>
    callback(0, 16, 390, columnBottom - 16),
  );
  Object.assign(current.columnRef, { current: { measureInWindow } });
  act(() => {
    current.onHostLayout(hostLayout(hostHeight));
    current.onColumnLayout();
  });
  return measureInWindow;
}

describe('sheetKeyboardInset', () => {
  it('owes only the window inset while the keyboard is down, on every platform', () => {
    for (const platform of ['ios', 'android', 'web'] as const) {
      expect(
        sheetKeyboardInset({ platform, keyboard: null, columnBottomInHost: 660, hostHeight: 660, ...WINDOW }),
      ).toEqual({ keyboardOverlap: 0, bottomInset: 34 });
    }
  });

  it('fits a fractional iPad column inside its shorter floating host before the keyboard opens', () => {
    // iOS 26.5: a 50% JS column uses the 1376pt window, but UIKit's floating
    // form is shorter. Its local column bottom 656 exceeds its 325pt host.
    expect(
      sheetKeyboardInset({
        platform: 'ios',
        isPad: true,
        keyboard: null,
        columnBottomInHost: 656,
        hostHeight: 325,
        windowWidth: 1024,
        windowHeight: 1376,
        windowInsetBottom: 20,
      }),
    ).toEqual({ keyboardOverlap: 331, bottomInset: 20 });
  });

  it('preserves the iPad host overflow and safe inset with a floating keyboard', () => {
    expect(
      sheetKeyboardInset({
        platform: 'ios',
        isPad: true,
        keyboard: { height: 300, screenY: 700, width: 320 },
        columnBottomInHost: 656,
        hostHeight: 325,
        windowWidth: 1024,
        windowHeight: 1376,
        windowInsetBottom: 20,
      }),
    ).toEqual({ keyboardOverlap: 331, bottomInset: 20 });
  });

  it('does not pad an iPhone at rest when its host measurements show overflow', () => {
    expect(
      sheetKeyboardInset({ platform: 'ios', keyboard: null, columnBottomInHost: 656, hostHeight: 325, ...WINDOW }),
    ).toEqual({ keyboardOverlap: 0, bottomInset: 34 });
  });

  it('pads by the column overflow beyond the host that shrank to the keyboard', () => {
    expect(
      sheetKeyboardInset({ platform: 'ios', keyboard: DOCKED, columnBottomInHost: 660, hostHeight: 324, ...WINDOW }),
    ).toEqual({ keyboardOverlap: 336, bottomInset: 0 });
  });

  it('includes the sheet-local column y instead of mixing it with the keyboard screen y (#5964)', () => {
    // iPhone 13 mini, iOS 26.5: column y 16 + height 644, host height 418.
    // Comparing its local bottom to keyboard screenY 468 incorrectly gives 192.
    expect(
      sheetKeyboardInset({
        platform: 'ios',
        keyboard: { height: 344, screenY: 468, width: 375 },
        columnBottomInHost: 16 + 644,
        hostHeight: 418,
        windowWidth: 375,
        windowHeight: 812,
        windowInsetBottom: 34,
      }),
    ).toEqual({ keyboardOverlap: 242, bottomInset: 0 });
  });

  it('pads only as far as the column extends past the host', () => {
    expect(
      sheetKeyboardInset({ platform: 'ios', keyboard: DOCKED, columnBottomInHost: 646, hostHeight: 324, ...WINDOW }),
    ).toEqual({ keyboardOverlap: 322, bottomInset: 0 });
  });

  it('waits for valid measurements instead of guessing a window-space overlap', () => {
    for (const geometry of [
      { columnBottomInHost: null, hostHeight: 324 },
      { columnBottomInHost: 660, hostHeight: null },
      { columnBottomInHost: Number.NaN, hostHeight: 324 },
      { columnBottomInHost: 660, hostHeight: 0 },
      { columnBottomInHost: 660, hostHeight: Number.NaN },
    ]) {
      expect(sheetKeyboardInset({ platform: 'ios', keyboard: DOCKED, ...geometry, ...WINDOW })).toEqual({
        keyboardOverlap: 0,
        bottomInset: 34,
      });
    }
  });

  it('adds nothing for a lifted iPad sheet whose column fits inside its host', () => {
    const ipad = { windowWidth: 1024, windowHeight: 1366, windowInsetBottom: 20 };
    const keyboard = { height: 398, screenY: 968, width: 1024 };
    expect(
      sheetKeyboardInset({ platform: 'ios', isPad: true, keyboard, columnBottomInHost: 600, hostHeight: 620, ...ipad }),
    ).toEqual({ keyboardOverlap: 0, bottomInset: 20 });
  });

  it('ignores an undocked or split iPad keyboard, which floats narrower than the window', () => {
    const ipad = { windowWidth: 1024, windowHeight: 1366, windowInsetBottom: 20 };
    const floating = { height: 300, screenY: 700, width: 320 };
    expect(
      sheetKeyboardInset({
        platform: 'ios',
        isPad: true,
        keyboard: floating,
        columnBottomInHost: 600,
        hostHeight: 620,
        ...ipad,
      }),
    ).toEqual({ keyboardOverlap: 0, bottomInset: 20 });
  });

  it('pads by keyboard + inset on Android, whose IME height leaves out the nav bar', () => {
    const keyboard = { height: 280, screenY: 564, width: 390 };
    expect(
      sheetKeyboardInset({
        platform: 'android',
        keyboard,
        columnBottomInHost: null,
        hostHeight: null,
        ...WINDOW,
        windowInsetBottom: 48,
      }),
    ).toEqual({ keyboardOverlap: 328, bottomInset: 0 });
  });

  it('leaves web to the Gorhom shim, which handles the keyboard itself', () => {
    expect(
      sheetKeyboardInset({ platform: 'web', keyboard: DOCKED, columnBottomInHost: 660, hostHeight: 324, ...WINDOW }),
    ).toEqual({ keyboardOverlap: 0, bottomInset: 34 });
  });
});

describe('useSheetKeyboardInset', () => {
  beforeEach(() => {
    native.os = 'ios';
    native.isPad = false;
    native.listeners.clear();
    native.visible = false;
    native.metrics = undefined;
  });

  it('does not listen while closed, and drops a keyboard it saw once the sheet closes', () => {
    const { result, rerender } = renderHook(({ enabled }) => useSheetKeyboardInset({ enabled }), {
      initialProps: { enabled: false },
    });
    expect(native.listeners.size).toBe(0);
    rerender({ enabled: true });
    measureColumn(result.current);
    act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: DOCKED, duration: 250 }));
    expect(result.current.keyboardOverlap).toBe(336);
    rerender({ enabled: false });
    expect(native.listeners.size).toBe(0);
    expect(result.current.keyboardOverlap).toBe(0);
    expect(result.current.bottomInset).toBe(34);
  });

  it('starts from a keyboard that was already up when the sheet opened, without raising it', () => {
    native.visible = true;
    native.metrics = DOCKED;
    const onKeyboardShow = vi.fn();
    const { result, rerender } = renderHook(({ enabled }) => useSheetKeyboardInset({ enabled, onKeyboardShow }), {
      initialProps: { enabled: false },
    });
    expect(result.current.keyboardOverlap).toBe(0);
    rerender({ enabled: true });
    expect(result.current.keyboardOverlap).toBe(0);
    measureColumn(result.current);
    expect(result.current.keyboardOverlap).toBe(336);
    expect(onKeyboardShow).not.toHaveBeenCalled();
  });

  it('follows host shrinkage after the keyboard event without comparing coordinate spaces', () => {
    const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true }));
    measureColumn(result.current, 660, 664);
    act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: DOCKED, duration: 250 }));
    expect(result.current.keyboardOverlap).toBe(0);
    // Native SwiftUI geometry arrives after the keyboard event. The footer must
    // lift even when neither the column nor the keyboard frame changes again.
    act(() => result.current.onHostLayout(hostLayout(418)));
    expect(result.current.keyboardOverlap).toBe(242);
    expect(result.current.bottomInset).toBe(0);
    act(() => native.listeners.get('keyboardWillHide')?.({ endCoordinates: { ...DOCKED, screenY: 844 } }));
    expect(result.current.keyboardOverlap).toBe(0);
    expect(result.current.bottomInset).toBe(34);
  });

  it('re-measures sheet-local column geometry when the keyboard frame changes', () => {
    let columnBottom = 660;
    const measureInWindow = vi.fn((callback: (x: number, y: number, width: number, height: number) => void) =>
      callback(0, 16, 390, columnBottom - 16),
    );
    const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true }));
    Object.assign(result.current.columnRef, { current: { measureInWindow } });
    act(() => {
      result.current.onHostLayout(hostLayout(418));
      result.current.onColumnLayout();
    });
    act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: DOCKED, duration: 250 }));
    expect(result.current.keyboardOverlap).toBe(242);
    columnBottom = 640;
    act(() => native.listeners.get('keyboardDidChangeFrame')?.({ endCoordinates: DOCKED }));
    expect(result.current.keyboardOverlap).toBe(222);
    expect(measureInWindow).toHaveBeenCalledTimes(3);
  });

  describe('the zero frame iOS reports with Prefer Cross-Fade Transitions on', () => {
    // `screenY` 0 says the keyboard is up but not where it is. RN's
    // KeyboardAvoidingView pads nothing for it; read as a real frame it would
    // pad the column by the whole window (844 here). It must still count as a
    // show, or the sheets never rise to their keyboard detent.
    const crossFade = { height: 336, screenY: 0, width: 390 };

    it('counts as a keyboard show, once, but pads nothing', () => {
      const onKeyboardShow = vi.fn();
      const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true, onKeyboardShow }));
      measureColumn(result.current);
      act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: crossFade, duration: 250 }));
      act(() => native.listeners.get('keyboardDidChangeFrame')?.({ endCoordinates: crossFade }));
      expect(onKeyboardShow).toHaveBeenCalledTimes(1);
      expect(result.current.keyboardOverlap).toBe(0);
      expect(result.current.bottomInset).toBe(34);
    });

    it('lets a following real frame pad normally, without a second show', () => {
      const onKeyboardShow = vi.fn();
      const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true, onKeyboardShow }));
      measureColumn(result.current);
      act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: crossFade, duration: 250 }));
      expect(onKeyboardShow).toHaveBeenCalledTimes(1);
      act(() => native.listeners.get('keyboardDidChangeFrame')?.({ endCoordinates: DOCKED }));
      expect(result.current.keyboardOverlap).toBe(336);
      expect(result.current.bottomInset).toBe(0);
      expect(onKeyboardShow).toHaveBeenCalledTimes(1);
    });

    it('is cleared by a real hide, so the next show raises the sheet again', () => {
      const onKeyboardShow = vi.fn();
      const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true, onKeyboardShow }));
      act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: crossFade, duration: 250 }));
      expect(onKeyboardShow).toHaveBeenCalledTimes(1);
      act(() =>
        native.listeners.get('keyboardWillHide')?.({ endCoordinates: { ...crossFade, screenY: 844 }, duration: 250 }),
      );
      expect(result.current.keyboardOverlap).toBe(0);
      expect(result.current.bottomInset).toBe(34);
      act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: crossFade, duration: 250 }));
      expect(onKeyboardShow).toHaveBeenCalledTimes(2);
      // A frame moved below the window is a hide too.
      act(() => native.listeners.get('keyboardDidChangeFrame')?.({ endCoordinates: { ...crossFade, screenY: 844 } }));
      act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: crossFade, duration: 250 }));
      expect(onKeyboardShow).toHaveBeenCalledTimes(3);
    });

    it('keeps the post-detent re-measure armed while the keyboard is up', () => {
      vi.useFakeTimers();
      try {
        const measureInWindow = vi.fn((callback: (x: number, y: number, width: number, height: number) => void) =>
          callback(0, 244, 390, 600),
        );
        const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true }));
        Object.assign(result.current.columnRef, { current: { measureInWindow } });
        act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: crossFade, duration: 250 }));
        measureInWindow.mockClear();
        act(() => result.current.measureAfterDetentChange());
        act(() => {
          vi.advanceTimersByTime(SHEET_SETTLE_MS);
        });
        expect(measureInWindow).toHaveBeenCalledTimes(1);
        expect(result.current.keyboardOverlap).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('pads nothing when a sheet opens over a keyboard whose frame reads screenY 0', () => {
    native.visible = true;
    native.metrics = { height: 336, screenY: 0, width: 390 };
    const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true }));
    measureColumn(result.current);
    expect(result.current.keyboardOverlap).toBe(0);
    expect(result.current.bottomInset).toBe(34);
  });

  it('reports a show once per keyboard appearance, not per frame change', () => {
    const onKeyboardShow = vi.fn();
    renderHook(() => useSheetKeyboardInset({ enabled: true, onKeyboardShow }));
    act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: DOCKED, duration: 250 }));
    act(() => native.listeners.get('keyboardDidChangeFrame')?.({ endCoordinates: DOCKED }));
    expect(onKeyboardShow).toHaveBeenCalledTimes(1);
    act(() =>
      native.listeners.get('keyboardWillHide')?.({ endCoordinates: { ...DOCKED, screenY: 844 }, duration: 250 }),
    );
    act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: DOCKED, duration: 250 }));
    expect(onKeyboardShow).toHaveBeenCalledTimes(2);
  });

  it('follows the did-events on Android', () => {
    native.os = 'android';
    const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true }));
    act(() => native.listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 280, screenY: 564, width: 390 } }));
    expect(result.current.keyboardOverlap).toBe(280 + 34);
    act(() => native.listeners.get('keyboardDidHide')?.({}));
    expect(result.current.keyboardOverlap).toBe(0);
  });

  it('bounds the iPad column to its host before any keyboard event, then follows a resize', () => {
    native.isPad = true;
    const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true }));
    measureColumn(result.current, 656, 325);
    expect(result.current.keyboardOverlap).toBe(331);
    expect(result.current.bottomInset).toBe(34);
    act(() => result.current.onHostLayout(hostLayout(700)));
    expect(result.current.keyboardOverlap).toBe(0);
    expect(result.current.bottomInset).toBe(34);
  });

  it('retains iPad host clearance and the safe inset for a floating or unusable keyboard frame', () => {
    native.isPad = true;
    native.visible = true;
    native.metrics = { height: 336, screenY: 0, width: 390 };
    const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true }));
    measureColumn(result.current, 656, 325);
    expect(result.current.keyboardOverlap).toBe(331);
    expect(result.current.bottomInset).toBe(34);
    act(() =>
      native.listeners.get('keyboardDidChangeFrame')?.({
        endCoordinates: { height: 300, screenY: 400, width: 320 },
      }),
    );
    expect(result.current.keyboardOverlap).toBe(331);
    expect(result.current.bottomInset).toBe(34);
  });

  it('waits for the did-event on iPad and leaves a lifted sheet that fits unpadded', () => {
    native.isPad = true;
    const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true }));
    measureColumn(result.current, 600, 620);
    act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: DOCKED, duration: 250 }));
    expect(result.current.keyboardOverlap).toBe(0);
    act(() => native.listeners.get('keyboardDidChangeFrame')?.({ endCoordinates: DOCKED }));
    expect(result.current.keyboardOverlap).toBe(0);
    expect(result.current.bottomInset).toBe(34);
    // If native geometry instead leaves part of the column below the host,
    // only that overflow is padded, regardless of the sheet's screen origin.
    act(() => result.current.onHostLayout(hostLayout(500)));
    expect(result.current.keyboardOverlap).toBe(100);
    act(() => native.listeners.get('keyboardDidChangeFrame')?.({ endCoordinates: { ...DOCKED, screenY: 844 } }));
    expect(result.current.keyboardOverlap).toBe(100);
    expect(result.current.bottomInset).toBe(34);
    act(() => result.current.onHostLayout(hostLayout(620)));
    expect(result.current.keyboardOverlap).toBe(0);
  });

  it('re-measures once, 300ms after a detent change, only while the keyboard is up', () => {
    vi.useFakeTimers();
    try {
      let columnBottom = 660;
      const measureInWindow = vi.fn((callback: (x: number, y: number, width: number, height: number) => void) =>
        callback(0, 16, 390, columnBottom - 16),
      );
      const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true }));
      Object.assign(result.current.columnRef, { current: { measureInWindow } });
      act(() => result.current.onHostLayout(hostLayout(324)));
      act(() => result.current.measureAfterDetentChange());
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(measureInWindow).not.toHaveBeenCalled();

      act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: DOCKED, duration: 250 }));
      measureInWindow.mockClear();
      columnBottom = 640;
      act(() => result.current.measureAfterDetentChange());
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(measureInWindow).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(measureInWindow).toHaveBeenCalledTimes(1);
      expect(result.current.keyboardOverlap).toBe(640 - 324);
    } finally {
      vi.useRealTimers();
    }
  });
});
