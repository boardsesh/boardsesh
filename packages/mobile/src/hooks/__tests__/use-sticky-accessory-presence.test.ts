// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const cfg = vi.hoisted(() => ({ hasClimb: false }));

vi.mock('../use-has-accessory-climb', () => ({
  useHasAccessoryClimb: () => cfg.hasClimb,
}));

import { useStickyAccessoryPresence } from '../use-sticky-accessory-presence';

const GRACE_MS = 500;

describe('useStickyAccessoryPresence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cfg.hasClimb = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports true immediately when a climb is present', () => {
    cfg.hasClimb = true;
    const { result } = renderHook(() => useStickyAccessoryPresence(GRACE_MS));
    expect(result.current).toBe(true);
  });

  it('holds true across a brief presence dip shorter than the grace window', () => {
    cfg.hasClimb = true;
    const { result, rerender } = renderHook(() => useStickyAccessoryPresence(GRACE_MS));
    expect(result.current).toBe(true);

    // Presence blips off (e.g. board reconnect / queue rehydrate)...
    cfg.hasClimb = false;
    rerender();
    act(() => {
      vi.advanceTimersByTime(GRACE_MS - 100);
    });
    expect(result.current).toBe(true);

    // ...and comes back before the grace window elapses.
    cfg.hasClimb = true;
    rerender();
    act(() => {
      vi.advanceTimersByTime(GRACE_MS);
    });
    expect(result.current).toBe(true);
  });

  it('drops to false after presence stays gone past the grace window', () => {
    cfg.hasClimb = true;
    const { result, rerender } = renderHook(() => useStickyAccessoryPresence(GRACE_MS));

    cfg.hasClimb = false;
    rerender();
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(GRACE_MS);
    });
    expect(result.current).toBe(false);
  });

  it('cancels the pending drop when presence returns before the window', () => {
    cfg.hasClimb = true;
    const { result, rerender } = renderHook(() => useStickyAccessoryPresence(GRACE_MS));

    cfg.hasClimb = false;
    rerender();
    act(() => {
      vi.advanceTimersByTime(GRACE_MS - 1);
    });
    cfg.hasClimb = true;
    rerender();

    // The earlier drop timer must not fire after presence is back.
    act(() => {
      vi.advanceTimersByTime(GRACE_MS * 2);
    });
    expect(result.current).toBe(true);
  });

  it('does not fire the drop timer after unmount', () => {
    cfg.hasClimb = true;
    const { rerender, unmount } = renderHook(() => useStickyAccessoryPresence(GRACE_MS));

    cfg.hasClimb = false;
    rerender();
    unmount();

    // No state update should be scheduled on the unmounted hook.
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(GRACE_MS * 2);
      });
    }).not.toThrow();
  });
});
