// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

type KeyboardListener = (event: { endCoordinates?: { height: number } }) => void;
const keyboard = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  listeners: new Map<string, KeyboardListener>(),
  removed: [] as string[],
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return keyboard.os;
    },
  },
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
  });

  it('follows the iOS will-events and drops to 0 on hide', () => {
    keyboard.os = 'ios';
    const { result } = renderHook(() => useKeyboardHeight());
    expect(result.current).toBe(0);
    act(() => keyboard.listeners.get('keyboardWillChangeFrame')?.({ endCoordinates: { height: 336 } }));
    expect(result.current).toBe(336);
    act(() => keyboard.listeners.get('keyboardWillHide')?.({}));
    expect(result.current).toBe(0);
  });

  it('uses the did-events on Android and removes both listeners on unmount', () => {
    keyboard.os = 'android';
    const { result, unmount } = renderHook(() => useKeyboardHeight());
    act(() => keyboard.listeners.get('keyboardDidShow')?.({ endCoordinates: { height: 280 } }));
    expect(result.current).toBe(280);
    unmount();
    expect(keyboard.removed.sort()).toEqual(['keyboardDidHide', 'keyboardDidShow']);
  });
});
