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

  it('delivers a suppressed message at the trailing edge of the window', () => {
    const { result } = renderHook(() => useRateLimitedAnnouncer());
    act(() => result.current('first'));
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS - 1);
    });
    act(() => result.current('second'));
    expect(announceSpy).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(announceSpy).toHaveBeenCalledTimes(2);
    expect(announceSpy).toHaveBeenLastCalledWith('second');
  });

  it('keeps only the latest distinct message during the window', () => {
    const { result } = renderHook(() => useRateLimitedAnnouncer());
    act(() => result.current('first'));
    act(() => result.current('superseded'));
    act(() => result.current('latest'));

    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS);
    });

    expect(announceSpy).toHaveBeenCalledTimes(2);
    expect(announceSpy).toHaveBeenLastCalledWith('latest');
  });

  it('speaks again once the window has passed', () => {
    const { result } = renderHook(() => useRateLimitedAnnouncer());
    act(() => result.current('first'));
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS);
    });
    act(() => result.current('second'));
    expect(announceSpy).toHaveBeenCalledTimes(2);
    expect(announceSpy).toHaveBeenLastCalledWith('second');
  });

  it('never repeats the sentence it last spoke, however long you wait', () => {
    // A status line can return to a state it already announced; hearing the same
    // words again carries no new information.
    const { result } = renderHook(() => useRateLimitedAnnouncer());
    act(() => result.current('same words'));
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS * 5);
    });
    act(() => result.current('same words'));
    expect(announceSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued status when the latest status matches the last announcement', () => {
    const { result } = renderHook(() => useRateLimitedAnnouncer());
    act(() => result.current('saved'));
    act(() => result.current('saving'));
    act(() => result.current('saved'));

    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS);
    });

    expect(announceSpy).toHaveBeenCalledExactlyOnceWith('saved');
  });

  it('cancels its trailing announcement on unmount', () => {
    const { result, unmount } = renderHook(() => useRateLimitedAnnouncer());
    act(() => result.current('first'));
    act(() => result.current('queued'));

    unmount();
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS);
    });

    expect(announceSpy).toHaveBeenCalledExactlyOnceWith('first');
  });

  it('uses an empty message to cancel a queued stale status', () => {
    const { result } = renderHook(() => useRateLimitedAnnouncer());
    act(() => result.current('first'));
    act(() => result.current('queued warning'));
    act(() => result.current(''));
    act(() => {
      vi.advanceTimersByTime(ANNOUNCE_MIN_INTERVAL_MS);
    });
    expect(announceSpy).toHaveBeenCalledExactlyOnceWith('first');
  });

  it('hands back a stable callback so a memoized consumer does not re-render', () => {
    const { result, rerender } = renderHook(() => useRateLimitedAnnouncer());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
