import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { BOARD_HISTORY_WINDOW_MS } from '@boardsesh/board-presence';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { useRecentBoardHistory } from '../use-recent-board-history';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const entry = (seq: number, sentAt: number): BoardPresenceClimb => ({
  climbUuid: `climb-${seq}`,
  seq,
  name: `Climb ${seq}`,
  angle: 40,
  sentAt: new Date(sentAt).toISOString(),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('useRecentBoardHistory', () => {
  it('expires rows while open with one timer and preserves the inclusive cutoff', () => {
    const cutoffEntry = entry(1, NOW - BOARD_HISTORY_WINDOW_MS);
    const nextEntry = entry(2, NOW - BOARD_HISTORY_WINDOW_MS + 1000);
    const retainedEntries = [nextEntry, cutoffEntry];
    const { result, unmount } = renderHook(() => useRecentBoardHistory(retainedEntries));

    expect(result.current.history).toBe(retainedEntries);
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.history).toEqual([nextEntry]);
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.history).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(retainedEntries).toEqual([nextEntry, cutoffEntry]);
    unmount();
  });

  it('rechecks suspended timers immediately on foreground or refresh', () => {
    const retainedEntries = [entry(1, NOW)];
    const { result, rerender } = renderHook(
      ({ refreshVersion }) => useRecentBoardHistory(retainedEntries, refreshVersion),
      {
        initialProps: { refreshVersion: 0 },
      },
    );
    vi.setSystemTime(NOW + BOARD_HISTORY_WINDOW_MS + 1);
    rerender({ refreshVersion: 1 });
    expect(result.current.history).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds future-dated timers and cleans them up on unmount', () => {
    const retainedEntries = [entry(1, NOW + BOARD_HISTORY_WINDOW_MS * 10)];
    const { result, unmount } = renderHook(() => useRecentBoardHistory(retainedEntries));
    act(() => {
      vi.advanceTimersByTime(BOARD_HISTORY_WINDOW_MS);
    });
    expect(result.current.history).toBe(retainedEntries);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
