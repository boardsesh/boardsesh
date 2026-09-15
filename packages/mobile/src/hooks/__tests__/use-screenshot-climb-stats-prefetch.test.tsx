// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { prefetchClimbStatsForClimbs, adapter } = vi.hoisted(() => ({
  prefetchClimbStatsForClimbs: vi.fn(),
  adapter: { isAuthenticated: true },
}));

// The coordinator's own batching is covered in @boardsesh/board-react; what
// matters here is WHETHER the whole-list prefetch is asked for, and with what.
vi.mock('@boardsesh/board-react', () => ({
  prefetchClimbStatsForClimbs,
  useBoardAdapter: () => adapter,
}));

import { useScreenshotClimbStatsPrefetch } from '../use-screenshot-climb-stats-prefetch';

const BOARD = { boardName: 'kilter', layoutId: 8, angle: 40 };

describe('useScreenshotClimbStatsPrefetch', () => {
  const originalScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE;

  beforeEach(() => {
    prefetchClimbStatsForClimbs.mockReset();
    prefetchClimbStatsForClimbs.mockResolvedValue(undefined);
    delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
  });

  afterEach(() => {
    if (originalScreenshotMode === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
    else process.env.EXPO_PUBLIC_SCREENSHOT_MODE = originalScreenshotMode;
  });

  it('asks for nothing in a normal build, so the per-row batcher stays the only reader', () => {
    renderHook(() => useScreenshotClimbStatsPrefetch({ ...BOARD, climbUuids: ['climb-a', 'climb-b'] }));
    expect(prefetchClimbStatsForClimbs).not.toHaveBeenCalled();
  });

  it('asks for the whole loaded list in screenshot mode, not the mounted rows', () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    renderHook(() => useScreenshotClimbStatsPrefetch({ ...BOARD, climbUuids: ['climb-b', 'climb-a', 'climb-c'] }));
    expect(prefetchClimbStatsForClimbs).toHaveBeenCalledTimes(1);
    expect(prefetchClimbStatsForClimbs).toHaveBeenCalledWith(adapter, { boardType: 'kilter', layoutId: 8, angle: 40 }, [
      'climb-b',
      'climb-a',
      'climb-c',
    ]);
  });

  it('does not re-ask while the loaded set is unchanged, however the caller rebuilt the array', () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    const { rerender } = renderHook(
      ({ climbUuids }: { climbUuids: string[] }) => useScreenshotClimbStatsPrefetch({ ...BOARD, climbUuids }),
      { initialProps: { climbUuids: ['climb-a', 'climb-b'] } },
    );
    // A fresh array with the same contents — what `visibleClimbs` produces on
    // every unrelated re-render of the climbs screen.
    rerender({ climbUuids: ['climb-a', 'climb-b'] });
    expect(prefetchClimbStatsForClimbs).toHaveBeenCalledTimes(1);

    rerender({ climbUuids: ['climb-a', 'climb-b', 'climb-c'] });
    expect(prefetchClimbStatsForClimbs).toHaveBeenCalledTimes(2);
    expect(prefetchClimbStatsForClimbs.mock.calls[1]?.[2]).toEqual(['climb-a', 'climb-b', 'climb-c']);
  });

  it('asks for nothing while the board or the list is still empty', () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    renderHook(() => useScreenshotClimbStatsPrefetch({ ...BOARD, climbUuids: [] }));
    renderHook(() => useScreenshotClimbStatsPrefetch({ ...BOARD, boardName: '', climbUuids: ['climb-a'] }));
    expect(prefetchClimbStatsForClimbs).not.toHaveBeenCalled();
  });
});
