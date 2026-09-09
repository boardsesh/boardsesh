// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import type { View } from 'react-native';

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
    const bodyRef: RefObject<View | null> = { current: {} as View };
    renderHook(() => useAnnounceBodyFocus(bodyRef, true));

    expect(findNodeHandle).toHaveBeenCalledWith(bodyRef.current);
    expect(setAccessibilityFocus).toHaveBeenCalledWith(7);
  });

  it('does nothing when the ref has not mounted', () => {
    findNodeHandle.mockReturnValue(null);
    const bodyRef: RefObject<View | null> = { current: null };
    renderHook(() => useAnnounceBodyFocus(bodyRef, true));

    expect(setAccessibilityFocus).not.toHaveBeenCalled();
  });
});
