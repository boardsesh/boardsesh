// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import type { ViewInstance } from 'react-native';

const findNodeHandle = vi.fn((_component: unknown): number | null => 7);
const setAccessibilityFocus = vi.fn();

vi.mock('react-native', () => ({
  AccessibilityInfo: { setAccessibilityFocus: (...args: unknown[]) => setAccessibilityFocus(...args) },
  findNodeHandle: (component: unknown) => findNodeHandle(component),
}));

import { useAnnounceBodyFocus } from '../use-announce-body-focus';

describe('useAnnounceBodyFocus (native)', () => {
  beforeEach(() => {
    findNodeHandle.mockClear();
    findNodeHandle.mockReturnValue(7);
    setAccessibilityFocus.mockClear();
  });

  it('lands accessibility focus on the resolved node handle', () => {
    const bodyRef: RefObject<ViewInstance | null> = { current: {} as ViewInstance };
    renderHook(() => useAnnounceBodyFocus(bodyRef, true));

    expect(findNodeHandle).toHaveBeenCalledWith(bodyRef.current);
    expect(setAccessibilityFocus).toHaveBeenCalledWith(7);
  });

  it('lands focus again when the refocus key changes, and not on a plain re-render', () => {
    const bodyRef: RefObject<ViewInstance | null> = { current: {} as ViewInstance };
    const hook = renderHook(({ refocusKey }) => useAnnounceBodyFocus(bodyRef, true, refocusKey), {
      initialProps: { refocusKey: 1 },
    });
    hook.rerender({ refocusKey: 1 });
    expect(setAccessibilityFocus).toHaveBeenCalledTimes(1);
    hook.rerender({ refocusKey: 2 });
    expect(setAccessibilityFocus).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the ref has not mounted', () => {
    findNodeHandle.mockReturnValue(null);
    const bodyRef: RefObject<ViewInstance | null> = { current: null };
    renderHook(() => useAnnounceBodyFocus(bodyRef, true));

    expect(setAccessibilityFocus).not.toHaveBeenCalled();
  });
});
