import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BoardName } from '@/app/lib/types';
import {
  useEffectiveClimbStats,
  bumpAscentDelta,
  setLiveClimbStats,
  clearClimbStatsLive,
  climbStatsLiveKey,
} from '../use-climb-stats-live';

const BOARD: BoardName = 'kilter';
const UUID = 'climb-1';
const ANGLE = 40;

let queryClient: QueryClient;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe('useEffectiveClimbStats', () => {
  it('returns base values when no provider context is available', () => {
    // No wrapper — exercises the test-safe path that gracefully reads from
    // a missing QueryClientContext rather than throwing.
    const { result } = renderHook(() =>
      useEffectiveClimbStats(BOARD, UUID, ANGLE, {
        ascensionist_count: 5,
        quality_average: '3.5',
        difficulty: '6A',
      }),
    );
    expect(result.current.ascensionistCount).toBe(5);
    expect(result.current.qualityAverage).toBe('3.5');
    expect(result.current.difficulty).toBe('6A');
  });

  it('returns base when boardName / uuid / angle are missing', () => {
    const { result } = renderHook(
      () => useEffectiveClimbStats(undefined, undefined, undefined, { ascensionist_count: 7 }),
      { wrapper },
    );
    expect(result.current.ascensionistCount).toBe(7);
    expect(result.current.qualityAverage).toBeNull();
    expect(result.current.difficulty).toBeNull();
  });

  it('adds optimistic delta to ascensionist_count when no live event has arrived', () => {
    const { result, rerender } = renderHook(
      () =>
        useEffectiveClimbStats(BOARD, UUID, ANGLE, {
          ascensionist_count: 3,
          quality_average: '4.0',
          difficulty: 'V5',
        }),
      { wrapper },
    );
    expect(result.current.ascensionistCount).toBe(3);

    act(() => {
      bumpAscentDelta(queryClient, BOARD, UUID, ANGLE, 1);
    });
    rerender();
    expect(result.current.ascensionistCount).toBe(4);
    // quality + difficulty pass through when only the ascent delta moves
    expect(result.current.qualityAverage).toBe('4.0');
    expect(result.current.difficulty).toBe('V5');
  });

  it('prefers live values over the optimistic delta and the base props', () => {
    const { result, rerender } = renderHook(
      () =>
        useEffectiveClimbStats(BOARD, UUID, ANGLE, {
          ascensionist_count: 3,
          quality_average: '2.0',
          difficulty: 'V4',
        }),
      { wrapper },
    );

    act(() => {
      bumpAscentDelta(queryClient, BOARD, UUID, ANGLE, 1);
      setLiveClimbStats(queryClient, BOARD, UUID, ANGLE, {
        ascensionistCount: 17,
        qualityAverage: 3.7,
        difficultyAverage: 5.5,
        displayDifficulty: 5.5,
      });
    });
    rerender();

    expect(result.current.ascensionistCount).toBe(17);
    expect(result.current.qualityAverage).toBe('3.7');
    expect(result.current.difficulty).toBe('5.5');
  });

  it('clearClimbStatsLive resets back to base', () => {
    const { result, rerender } = renderHook(
      () => useEffectiveClimbStats(BOARD, UUID, ANGLE, { ascensionist_count: 2, quality_average: '1.0' }),
      { wrapper },
    );

    act(() => {
      bumpAscentDelta(queryClient, BOARD, UUID, ANGLE, 1);
      setLiveClimbStats(queryClient, BOARD, UUID, ANGLE, {
        ascensionistCount: 10,
        qualityAverage: null,
        difficultyAverage: null,
        displayDifficulty: null,
      });
    });
    rerender();
    expect(result.current.ascensionistCount).toBe(10);

    act(() => {
      clearClimbStatsLive(queryClient, BOARD, UUID, ANGLE);
    });
    rerender();
    expect(result.current.ascensionistCount).toBe(2);
    expect(result.current.qualityAverage).toBe('1.0');
  });

  it('keys deltas per (boardName, climbUuid, angle) — sibling climbs are unaffected', () => {
    const { result: a } = renderHook(
      () => useEffectiveClimbStats(BOARD, 'climb-A', 40, { ascensionist_count: 1 }),
      { wrapper },
    );
    const { result: b } = renderHook(
      () => useEffectiveClimbStats(BOARD, 'climb-B', 40, { ascensionist_count: 1 }),
      { wrapper },
    );

    act(() => {
      bumpAscentDelta(queryClient, BOARD, 'climb-A', 40, 1);
    });
    expect(a.current.ascensionistCount).toBe(2);
    expect(b.current.ascensionistCount).toBe(1);
  });
});

describe('climbStatsLiveKey', () => {
  it('builds a stable, namespaced query key', () => {
    expect(climbStatsLiveKey(BOARD, UUID, ANGLE)).toEqual(['climbStatsLive', BOARD, UUID, ANGLE]);
  });
});
