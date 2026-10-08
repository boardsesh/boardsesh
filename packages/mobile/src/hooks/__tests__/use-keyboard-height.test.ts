// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

type KeyboardListener = (event: { endCoordinates?: { height: number }; duration?: number }) => void;
const keyboard = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  listeners: new Map<string, KeyboardListener>(),
  removed: [] as string[],
  configureNext: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return keyboard.os;
    },
  },
  LayoutAnimation: { configureNext: keyboard.configureNext },
  Keyboard: {
    addListener: (eventName: string, listener: KeyboardListener) => {
      keyboard.listeners.set(eventName, listener);
      return { remove: () => keyboard.removed.push(eventName) };
    },
  },
}));

import { useKeyboardHeight } from '../use-keyboard-height';

describe('useKeyboardHeight', () => {
  beforeEach(() => {
    keyboard.listeners.clear();
    keyboard.removed = [];
    keyboard.configureNext.mockClear();
  });

  it('follows the iOS will-events and drops to 0 on hide', () => {
    keyboard.os = 'ios';
    const { result } = renderHook(() => useKeyboardHeight());
    expect(result.current).toBe(0);
    act(() => keyboard.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: { height: 336 }, duration: 250 }));
    expect(result.current).toBe(336);
    act(() => keyboard.listeners.get('keyboardWillHide')?.({ duration: 250 }));
    expect(result.current).toBe(0);
  });

  it('rides the keyboard animation on iOS, so the padding slides instead of jumping', () => {
    keyboard.os = 'ios';
    renderHook(() => useKeyboardHeight());
    act(() => keyboard.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: { height: 336 }, duration: 250 }));
    expect(keyboard.configureNext).toHaveBeenCalledWith({ duration: 250, update: { duration: 250, type: 'keyboard' } });
  });

  it('uses the did-events on Android and removes both listeners on unmount', () => {
    keyboard.os = 'android';
    const { result, unmount } = renderHook(() => useKeyboardHeight());
    act(() => keyboard.listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 280 } }));
    expect(result.current).toBe(280);
    // Android's did-events arrive after the keyboard moved: nothing to ride.
    expect(keyboard.configureNext).not.toHaveBeenCalled();
    unmount();
    expect(keyboard.removed.sort()).toEqual(['keyboardDidHide', 'keyboardDidShow']);
  });

  it('registers nothing and reads 0 while disabled', () => {
    keyboard.os = 'ios';
    const { result } = renderHook(() => useKeyboardHeight(false));
    expect(keyboard.listeners.size).toBe(0);
    expect(result.current).toBe(0);
    expect(keyboard.configureNext).not.toHaveBeenCalled();
  });
});
