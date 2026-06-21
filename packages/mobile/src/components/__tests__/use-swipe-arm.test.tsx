// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useSwipeArm } from '../use-swipe-arm';

describe('useSwipeArm', () => {
  it('starts disarmed', () => {
    const { result } = renderHook(() => useSwipeArm('climb-1'));

    expect(result.current.armed).toBe(false);
    expect(result.current.armedRef.current).toBe(false);
  });

  it('arms on the first drag and keeps the ref and state in sync', () => {
    const { result } = renderHook(() => useSwipeArm('climb-1'));

    act(() => result.current.arm());

    expect(result.current.armed).toBe(true);
    expect(result.current.armedRef.current).toBe(true);
  });

  it('disarms again once a swipe settles shut', () => {
    const { result } = renderHook(() => useSwipeArm('climb-1'));

    act(() => result.current.arm());
    expect(result.current.armed).toBe(true);

    act(() => result.current.disarm());

    expect(result.current.armed).toBe(false);
    expect(result.current.armedRef.current).toBe(false);
  });

  it('resets to disarmed when the row recycles onto a new climb', () => {
    const { result, rerender } = renderHook(({ uuid }) => useSwipeArm(uuid), {
      initialProps: { uuid: 'climb-1' },
    });

    act(() => result.current.arm());
    expect(result.current.armed).toBe(true);

    // FlashList reuses the row instance for a different climb.
    rerender({ uuid: 'climb-2' });

    expect(result.current.armed).toBe(false);
    expect(result.current.armedRef.current).toBe(false);
  });

  it('keeps a stable arm/disarm identity across re-renders so render callbacks stay dep-free', () => {
    const { result, rerender } = renderHook(({ uuid }) => useSwipeArm(uuid), {
      initialProps: { uuid: 'climb-1' },
    });

    const firstArm = result.current.arm;
    const firstDisarm = result.current.disarm;
    const firstRef = result.current.armedRef;

    act(() => result.current.arm());
    rerender({ uuid: 'climb-1' });

    expect(result.current.arm).toBe(firstArm);
    expect(result.current.disarm).toBe(firstDisarm);
    expect(result.current.armedRef).toBe(firstRef);
  });
});
