// @vitest-environment jsdom
//
// QA saw a fresh session read "0m" for about two minutes while a friend's card
// ticked on. The old clock floored "now" to the wall-clock minute and woke only
// on wall-clock boundaries, so a session started at hh:mm:05 lagged by up to
// 1m55s. These pin the per-session boundary instead.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { elapsedParts } from '../live-session-model';
import { nextElapsedChangeDelay, startedAtKeyFor, useElapsedClock } from '../use-elapsed-clock';

const T0 = Date.UTC(2026, 8, 16, 10, 1, 5); // 10:01:05

describe('nextElapsedChangeDelay', () => {
  it("wakes at the soonest session's next minute boundary, not the wall-clock minute", () => {
    // 10:01:50 with one session from 10:01:05: its first minute lands at 10:02:05.
    expect(nextElapsedChangeDelay(T0 + 45_000, [T0])).toBe(15_000);
    // Two sessions: the one whose boundary comes first wins.
    expect(nextElapsedChangeDelay(T0 + 45_000, [T0, T0 - 40_000])).toBe(15_000);
    expect(nextElapsedChangeDelay(T0 + 45_000, [T0, T0 + 30_000])).toBe(15_000);
  });

  it('waits a full minute on an exact boundary and with no sessions', () => {
    expect(nextElapsedChangeDelay(T0 + 60_000, [T0])).toBe(60_000);
    expect(nextElapsedChangeDelay(T0, [])).toBe(60_000);
  });

  it('never sleeps past a minute, even for a start stamped ahead of this clock', () => {
    expect(nextElapsedChangeDelay(T0, [T0 + 10_000])).toBe(60_000);
  });
});

describe('useElapsedClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 45_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves a fresh session off "Just started" the moment its first minute is up', () => {
    const key = startedAtKeyFor([{ startedAtMs: T0 }]);
    const { result } = renderHook(() => useElapsedClock(true, key));
    expect(elapsedParts(T0, result.current)).toEqual({ hours: 0, minutes: 0 });

    act(() => {
      vi.advanceTimersByTime(15_100);
    });
    expect(elapsedParts(T0, result.current)).toEqual({ hours: 0, minutes: 1 });

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(elapsedParts(T0, result.current)).toEqual({ hours: 0, minutes: 2 });
  });

  it('re-reads now when a new session joins the rail, instead of reusing an old tick', () => {
    const { result, rerender } = renderHook(({ key }) => useElapsedClock(true, key), {
      initialProps: { key: startedAtKeyFor([{ startedAtMs: T0 - 600_000 }]) },
    });
    vi.setSystemTime(T0 + 50_000);
    rerender({ key: startedAtKeyFor([{ startedAtMs: T0 - 600_000 }, { startedAtMs: T0 }]) });
    expect(result.current).toBe(T0 + 50_000);
  });

  it('does not tick while inactive', () => {
    const { result } = renderHook(() => useElapsedClock(false, startedAtKeyFor([{ startedAtMs: T0 }])));
    const initial = result.current;
    act(() => {
      vi.advanceTimersByTime(180_000);
    });
    expect(result.current).toBe(initial);
  });
});
