// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

type KeyboardEnd = { height: number; screenY: number; width: number };
type KeyboardListener = (event: { endCoordinates?: KeyboardEnd; duration?: number }) => void;
const native = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  listeners: new Map<string, KeyboardListener>(),
  visible: false,
  metrics: undefined as KeyboardEnd | undefined,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.os;
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

import { sheetKeyboardInset, useSheetKeyboardInset } from '../sheet-keyboard-inset';

// An iPhone-sized window: 390 x 844, 34pt home indicator, 336pt keyboard.
const WINDOW = { windowWidth: 390, windowHeight: 844, windowInsetBottom: 34 };
const DOCKED = { height: 336, screenY: 844 - 336, width: 390 };

describe('sheetKeyboardInset', () => {
  it('owes only the window inset while the keyboard is down, on every platform', () => {
    for (const platform of ['ios', 'android', 'web'] as const) {
      expect(sheetKeyboardInset({ platform, keyboard: null, columnBottomInWindow: 844, ...WINDOW })).toEqual({
        keyboardOverlap: 0,
        bottomInset: 34,
      });
    }
  });

  it('pads an iPhone sheet, whose bottom is the window bottom, by the docked keyboard', () => {
    expect(sheetKeyboardInset({ platform: 'ios', keyboard: DOCKED, columnBottomInWindow: 844, ...WINDOW })).toEqual({
      keyboardOverlap: 336,
      bottomInset: 0,
    });
  });

  it('pads by only the part of the keyboard the column reaches into', () => {
    // The iOS column errs a few points short of the sheet bottom (#3330).
    expect(sheetKeyboardInset({ platform: 'ios', keyboard: DOCKED, columnBottomInWindow: 830, ...WINDOW })).toEqual({
      keyboardOverlap: 322,
      bottomInset: 0,
    });
  });

  it('takes the window bottom before the column has been measured, and as a ceiling', () => {
    expect(sheetKeyboardInset({ platform: 'ios', keyboard: DOCKED, columnBottomInWindow: null, ...WINDOW })).toEqual({
      keyboardOverlap: 336,
      bottomInset: 0,
    });
    // Mid-presentation the column can still be below the screen.
    expect(sheetKeyboardInset({ platform: 'ios', keyboard: DOCKED, columnBottomInWindow: 1400, ...WINDOW })).toEqual({
      keyboardOverlap: 336,
      bottomInset: 0,
    });
  });

  it('adds nothing for an iPad sheet UIKit has lifted clear of the keyboard', () => {
    const ipad = { windowWidth: 1024, windowHeight: 1366, windowInsetBottom: 20 };
    const keyboard = { height: 398, screenY: 1366 - 398, width: 1024 };
    // A form sheet whose bottom sits above the keyboard's top edge.
    expect(sheetKeyboardInset({ platform: 'ios', keyboard, columnBottomInWindow: 940, ...ipad })).toEqual({
      keyboardOverlap: 0,
      bottomInset: 20,
    });
  });

  it('ignores an undocked or split iPad keyboard, which floats narrower than the window', () => {
    const ipad = { windowWidth: 1024, windowHeight: 1366, windowInsetBottom: 20 };
    const floating = { height: 300, screenY: 700, width: 320 };
    expect(sheetKeyboardInset({ platform: 'ios', keyboard: floating, columnBottomInWindow: 1366, ...ipad })).toEqual({
      keyboardOverlap: 0,
      bottomInset: 20,
    });
  });

  it('pads by keyboard + inset on Android, whose IME height leaves out the nav bar', () => {
    const keyboard = { height: 280, screenY: 564, width: 390 };
    expect(
      sheetKeyboardInset({
        platform: 'android',
        keyboard,
        columnBottomInWindow: null,
        ...WINDOW,
        windowInsetBottom: 48,
      }),
    ).toEqual({ keyboardOverlap: 328, bottomInset: 0 });
  });

  it('leaves web to the Gorhom shim, which handles the keyboard itself', () => {
    expect(sheetKeyboardInset({ platform: 'web', keyboard: DOCKED, columnBottomInWindow: 844, ...WINDOW })).toEqual({
      keyboardOverlap: 0,
      bottomInset: 34,
    });
  });
});

describe('useSheetKeyboardInset', () => {
  beforeEach(() => {
    native.os = 'ios';
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
    expect(result.current.keyboardOverlap).toBe(336);
    expect(onKeyboardShow).not.toHaveBeenCalled();
  });

  it('measures the column in window coordinates and re-measures on keyboard events (lifted iPad sheet)', () => {
    let columnBottom = 844;
    const measureInWindow = vi.fn((callback: (x: number, y: number, width: number, height: number) => void) =>
      callback(0, columnBottom - 600, 390, 600),
    );
    const { result } = renderHook(() => useSheetKeyboardInset({ enabled: true }));
    Object.assign(result.current.columnRef, { current: { measureInWindow } });
    act(() => result.current.onColumnLayout());
    const keyboard = { height: 300, screenY: 844 - 300, width: 390 };
    act(() => native.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: keyboard, duration: 250 }));
    expect(result.current.keyboardOverlap).toBe(300);
    // UIKit has lifted the sheet clear by the time the did-event re-measures.
    columnBottom = 520;
    act(() => native.listeners.get('keyboardDidChangeFrame')?.({ endCoordinates: keyboard }));
    expect(measureInWindow).toHaveBeenCalledTimes(3);
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
});
