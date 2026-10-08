// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
const focus = vi.hoisted(() => ({ active: false }));
vi.mock('expo-router', () => ({ useIsFocused: () => focus.active }));
import { useHasBeenFocused } from '../use-has-been-focused';
describe('useHasBeenFocused', () => {
  beforeEach(() => {
    focus.active = false;
  });
  it('defers work until first focus and preserves it after blur', () => {
    const { result, rerender } = renderHook(() => useHasBeenFocused());
    expect(result.current).toBe(false);
    rerender();
    expect(result.current).toBe(false);
    focus.active = true;
    rerender();
    expect(result.current).toBe(true);
    focus.active = false;
    rerender();
    expect(result.current).toBe(true);
  });
  it('enables the initial focused tab on its first render', () => {
    focus.active = true;
    const { result } = renderHook(() => useHasBeenFocused());
    expect(result.current).toBe(true);
  });
});
