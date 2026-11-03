// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Android's "Time to take action" stretches a screen-reader timeout, never
// shortens it; iOS has no such setting and is never asked.

const native = vi.hoisted(() => ({
  os: 'android',
  getRecommendedTimeoutMillis: vi.fn<(originalTimeout: number) => Promise<number>>(),
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
  AccessibilityInfo: { getRecommendedTimeoutMillis: native.getRecommendedTimeoutMillis },
}));

import { useRecommendedTimeout } from '../use-recommended-timeout';

beforeEach(() => {
  native.os = 'android';
  native.getRecommendedTimeoutMillis.mockReset();
});

describe('useRecommendedTimeout', () => {
  it('returns the longer Android setting once Android answers', async () => {
    native.getRecommendedTimeoutMillis.mockResolvedValue(120000);
    const hook = renderHook(() => useRecommendedTimeout(80000, true));
    expect(hook.result.current).toBe(80000);
    await act(async () => {});
    expect(hook.result.current).toBe(120000);
    expect(native.getRecommendedTimeoutMillis).toHaveBeenCalledWith(80000);
  });

  it('never goes below the base, whatever Android answers', async () => {
    native.getRecommendedTimeoutMillis.mockResolvedValue(30000);
    const hook = renderHook(() => useRecommendedTimeout(80000, true));
    await act(async () => {});
    expect(hook.result.current).toBe(80000);
  });

  it('keeps the base when the query fails', async () => {
    native.getRecommendedTimeoutMillis.mockRejectedValue(new Error('no accessibility manager'));
    const hook = renderHook(() => useRecommendedTimeout(80000, true));
    await act(async () => {});
    expect(hook.result.current).toBe(80000);
  });

  it('does not ask while disabled, and returns the base', async () => {
    native.getRecommendedTimeoutMillis.mockResolvedValue(120000);
    const hook = renderHook(() => useRecommendedTimeout(80000, false));
    await act(async () => {});
    expect(hook.result.current).toBe(80000);
    expect(native.getRecommendedTimeoutMillis).not.toHaveBeenCalled();
  });

  it('does not ask on iOS, which has no such setting', async () => {
    native.os = 'ios';
    const hook = renderHook(() => useRecommendedTimeout(80000, true));
    await act(async () => {});
    expect(hook.result.current).toBe(80000);
    expect(native.getRecommendedTimeoutMillis).not.toHaveBeenCalled();
  });

  it('drops an answer given for a different base', async () => {
    native.getRecommendedTimeoutMillis.mockResolvedValue(120000);
    const hook = renderHook(({ baseMs }) => useRecommendedTimeout(baseMs, true), { initialProps: { baseMs: 80000 } });
    await act(async () => {});
    native.getRecommendedTimeoutMillis.mockReturnValue(new Promise(() => {}));
    // The 120 s answered for 80 s says nothing about 100 s until Android answers.
    hook.rerender({ baseMs: 100000 });
    expect(hook.result.current).toBe(100000);
  });
});
