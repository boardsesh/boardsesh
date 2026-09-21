// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDimensionRepin } from '../dimension-lock-store';

describe('useDimensionRepin', () => {
  it('pins once when the chip is visible, locked, and the filter is inactive', () => {
    const pin = vi.fn();
    renderHook(() => useDimensionRepin(true, true, false, pin));
    expect(pin).toHaveBeenCalledTimes(1);
  });

  it('does not pin when unlocked, chip-hidden, or already active', () => {
    const pinUnlocked = vi.fn();
    renderHook(() => useDimensionRepin(true, false, false, pinUnlocked));
    expect(pinUnlocked).not.toHaveBeenCalled();

    const pinHidden = vi.fn();
    renderHook(() => useDimensionRepin(false, true, false, pinHidden));
    expect(pinHidden).not.toHaveBeenCalled();

    const pinActive = vi.fn();
    renderHook(() => useDimensionRepin(true, true, true, pinActive));
    expect(pinActive).not.toHaveBeenCalled();
  });

  it('re-pins after a clear (locked, filter goes active → inactive)', () => {
    const pin = vi.fn();
    const { rerender } = renderHook(({ active }: { active: boolean }) => useDimensionRepin(true, true, active, pin), {
      initialProps: { active: true }, // already active → no pin yet
    });
    expect(pin).not.toHaveBeenCalled();
    rerender({ active: false }); // a clear cleared the filter → re-pin
    expect(pin).toHaveBeenCalledTimes(1);
  });
});
