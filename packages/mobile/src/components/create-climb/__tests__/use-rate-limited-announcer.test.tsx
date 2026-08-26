// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The rate limit is load-bearing, not a nicety. The state behind the draft status
// line flips on a 500ms autosave debounce, so an unthrottled voice would talk over
// every keystroke and every hold tap — which is why the line's live region is
// explicitly `none` and this is the only thing allowed to speak.

const announceSpy = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: announceSpy },
}));

import { useRateLimitedAnnouncer, ANNOUNCE_MIN_INTERVAL_MS } from '../use-rate-limited-announcer';

beforeEach(() => {
  announceSpy.mockClear();
  vi.useFakeTimers();
  // Start well past the epoch so the first call isn't accidentally inside the window.
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useRateLimitedAnnouncer', () => {
  it('speaks the first transition immediately', () => {
    const { result } = renderHook(() => useRateLimitedAnnouncer());
    act(() => result.current('Draft saved to your account'));
    expect(announceSpy).toHaveBeenCalledExactlyOnceWith('Draft saved to your account');
  });

  it('swallows a different message inside the window', () => {
    const { result } = renderHook(() => useRateLimitedAnnouncer());
    act(() => result.current('first'));
    act(() => vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS - 1));
    act(() => result.current('second'));
    expect(announceSpy).toHaveBeenCalledTimes(1);
  });

  it('speaks again once the window has passed', () => {
    const { result } = renderHook(() => useRateLimitedAnnouncer());
    act(() => result.current('first'));
    act(() => vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS));
    act(() => result.current('second'));
    expect(announceSpy).toHaveBeenCalledTimes(2);
    expect(announceSpy).toHaveBeenLastCalledWith('second');
  });

  it('never repeats the sentence it last spoke, however long you wait', () => {
    // A status line can return to a state it already announced; hearing the same
    // words again carries no new information.
    const { result } = renderHook(() => useRateLimitedAnnouncer());
    act(() => result.current('same words'));
    act(() => vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS * 5));
    act(() => result.current('same words'));
    expect(announceSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores an empty message', () => {
    const { result } = renderHook(() => useRateLimitedAnnouncer());
    act(() => result.current(''));
    expect(announceSpy).not.toHaveBeenCalled();
  });

  it('hands back a stable callback so a memoized consumer does not re-render', () => {
    const { result, rerender } = renderHook(() => useRateLimitedAnnouncer());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
