// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  tasks: [] as { run: () => void; cancel: ReturnType<typeof vi.fn> }[],
  prewarm: vi.fn(),
  backgrounds: vi.fn(),
}));
vi.mock('../../../lib/schedule-idle-task', () => ({
  scheduleIdleTask: (run: () => void) => {
    const task = { run, cancel: vi.fn() };
    mocks.tasks.push(task);
    return task;
  },
}));
vi.mock('../../../lib/create-board-holds', () => ({
  parseSetIdsParam: (setIds: string) => setIds.split(',').map(Number),
  prewarmCreateBoardHolds: mocks.prewarm,
}));
vi.mock('../../../lib/background-image-cache', () => ({ ensureBackgroundsCached: mocks.backgrounds }));
import { useClimbBoardPrewarming } from '../use-climb-board-prewarming';

const boardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: '3,4', angle: 40 };
const activeBoard = { boardType: 'kilter', layoutId: 1, sizeId: 2, setIds: '3,4' } as UserBoard;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.tasks.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('useClimbBoardPrewarming', () => {
  it('waits for restored search before scheduling holds, but warms backgrounds immediately', () => {
    const { rerender, unmount } = renderHook(
      ({ searchReady }) => useClimbBoardPrewarming({ boardConfig, activeBoard, searchReady, colorScheme: 'dark' }),
      { initialProps: { searchReady: false } },
    );
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(mocks.tasks).toHaveLength(1);
    mocks.tasks[0].run();
    expect(mocks.backgrounds).toHaveBeenCalledWith({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 2,
      setIds: [3, 4],
      colorScheme: 'dark',
    });
    rerender({ searchReady: true });
    act(() => {
      vi.advanceTimersByTime(1199);
    });
    expect(mocks.tasks).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.tasks).toHaveLength(2);
    mocks.tasks[1].run();
    expect(mocks.prewarm).toHaveBeenCalledWith({ boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: [3, 4] });
    unmount();
    expect(mocks.tasks[0].cancel).toHaveBeenCalledOnce();
    expect(mocks.tasks[1].cancel).toHaveBeenCalledOnce();
  });

  it('cancels the pending holds timer when the board changes', () => {
    const { rerender, unmount } = renderHook(
      ({ board }) =>
        useClimbBoardPrewarming({ boardConfig: board, activeBoard: null, searchReady: true, colorScheme: 'dark' }),
      { initialProps: { board: boardConfig } },
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    rerender({ board: { ...boardConfig, layoutId: 9 } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(mocks.tasks).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    mocks.tasks[0].run();
    expect(mocks.prewarm).toHaveBeenCalledWith(expect.objectContaining({ layoutId: 9 }));
    unmount();
  });
});
