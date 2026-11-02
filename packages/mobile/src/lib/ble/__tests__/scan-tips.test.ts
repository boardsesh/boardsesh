// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { orderScanTips, SCAN_TIPS_DELAY_MS, useScanTipsDue } from '../scan-tips';

describe('orderScanTips', () => {
  it.each(['kilter', 'tension', undefined])('puts power, distance, Bluetooth, then another phone for %s', (board) => {
    expect(orderScanTips(board)).toEqual(['power', 'closer', 'bluetooth', 'other_phone']);
  });

  it('moves another phone to second on a MoonBoard, in its MoonBoard wording', () => {
    expect(orderScanTips('moonboard')).toEqual(['power', 'moonboard_other_phone', 'closer', 'bluetooth']);
  });
});

describe('useScanTipsDue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits 5 s into a scan', () => {
    expect(SCAN_TIPS_DELAY_MS).toBe(5_000);
    const { result } = renderHook(() => useScanTipsDue(true));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it('is never due with no scan running', () => {
    const { result } = renderHook(() => useScanTipsDue(false));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(false);
  });

  it('starts the wait over for the next scan', () => {
    const { result, rerender } = renderHook(({ scanning }) => useScanTipsDue(scanning), {
      initialProps: { scanning: true },
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(true);

    rerender({ scanning: false });
    expect(result.current).toBe(false);

    rerender({ scanning: true });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it('drops a wait the scan did not finish', () => {
    const { result, rerender } = renderHook(({ scanning }) => useScanTipsDue(scanning), {
      initialProps: { scanning: true },
    });
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    rerender({ scanning: false });
    rerender({ scanning: true });
    // 3 s of the first scan don't count towards the second.
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBe(true);
  });
});
