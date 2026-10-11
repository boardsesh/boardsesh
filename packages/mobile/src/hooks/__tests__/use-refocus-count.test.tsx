// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// The effect the hook registered, so a test can fire a focus event by hand.
const navigation = vi.hoisted(() => ({ focusEffect: undefined as (() => void) | undefined }));
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void) => {
    navigation.focusEffect = effect;
  },
}));

import { useRefocusCount } from '../use-refocus-count';

const focusScreen = () => act(() => navigation.focusEffect?.());

describe('useRefocusCount', () => {
  beforeEach(() => {
    navigation.focusEffect = undefined;
  });

  it('starts at 0 and does not count the first focus', () => {
    const { result } = renderHook(() => useRefocusCount());
    expect(result.current).toBe(0);

    focusScreen();
    expect(result.current).toBe(0);
  });

  it('counts every return after that', () => {
    const { result } = renderHook(() => useRefocusCount());
    focusScreen();

    focusScreen();
    expect(result.current).toBe(1);
    focusScreen();
    expect(result.current).toBe(2);
  });

  it('keeps one effect across renders, so a re-render is not a new focus', () => {
    const { result, rerender } = renderHook(() => useRefocusCount());
    const firstEffect = navigation.focusEffect;
    focusScreen();

    rerender();
    expect(navigation.focusEffect).toBe(firstEffect);
    expect(result.current).toBe(0);
  });
});
