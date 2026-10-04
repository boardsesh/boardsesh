// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const interactions = vi.hoisted(() => ({
  settled: true,
  calls: [] as Array<{ active: boolean; resetKey: string | number | undefined }>,
}));
vi.mock('../use-deferred-after-interactions', () => ({
  useDeferredAfterInteractions: (active: boolean, resetKey?: string | number) => {
    interactions.calls.push({ active, resetKey });
    return interactions.settled;
  },
}));

// The dwell half is the real hook; its module also holds the query, whose
// client and viewer-id imports this test has no use for.
vi.mock('../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../use-current-user-id', () => ({ useStoredUserId: () => ({ userId: undefined, isLoading: false }) }));

import { useClimbSettled } from '../use-climb-settled';

describe('useClimbSettled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    interactions.settled = true;
    interactions.calls = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('needs both the settled open animation and the dwell', () => {
    interactions.settled = false;
    const { result, rerender } = renderHook(() => useClimbSettled(true, 'c1'));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // Dwelled, but the drawer is still animating open.
    expect(result.current).toBe(false);

    interactions.settled = true;
    rerender();
    expect(result.current).toBe(true);
  });

  it('is false straight after the animation settles, until the dwell passes', () => {
    const { result } = renderHook(() => useClimbSettled(true, 'c1'));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current).toBe(true);
  });

  it('re-defers per climb, on the drawer being open', () => {
    renderHook(() => useClimbSettled(true, 'c1'));
    expect(interactions.calls.at(-1)).toEqual({ active: true, resetKey: 'c1' });
  });
});
