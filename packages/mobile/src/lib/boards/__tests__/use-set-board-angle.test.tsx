// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const activeBoard = vi.hoisted(() => ({ current: null as UserBoard | null }));
const setActiveBoardMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const setStoredBoardAngleMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const reportErrorMock = vi.hoisted(() => vi.fn());

vi.mock('../../graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: activeBoard.current }),
  useSetActiveBoard: () => setActiveBoardMock,
}));
vi.mock('../board-angle-store', () => ({ setStoredBoardAngle: setStoredBoardAngleMock }));
vi.mock('../../error-reporting', () => ({ reportError: reportErrorMock }));

import { useSetBoardAngle } from '../use-set-board-angle';

function board(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'kilter-1',
    name: 'Kilter',
    boardType: 'kilter',
    angle: 40,
    isAngleAdjustable: true,
    ...overrides,
  } as unknown as UserBoard;
}

describe('useSetBoardAngle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActiveBoardMock.mockResolvedValue(undefined);
    setStoredBoardAngleMock.mockResolvedValue(undefined);
    activeBoard.current = board();
  });

  it('records the angle and re-binds the board when it is the active one', async () => {
    const { result } = renderHook(() => useSetBoardAngle());

    await result.current(board(), 25);

    expect(setStoredBoardAngleMock).toHaveBeenCalledWith('kilter-1', 25);
    expect(setActiveBoardMock).toHaveBeenCalledWith(expect.objectContaining({ angle: 25 }));
  });

  // A board that cannot physically move must never report a remembered angle:
  // a stale value would misreport the wall to everyone reading it.
  it('ignores a fixed-angle board entirely', async () => {
    const spray = board({ uuid: 'spray', isAngleAdjustable: false, angle: 0 });
    activeBoard.current = spray;
    const { result } = renderHook(() => useSetBoardAngle());

    await result.current(spray, 40);

    expect(setStoredBoardAngleMock).not.toHaveBeenCalled();
    expect(setActiveBoardMock).not.toHaveBeenCalled();
  });

  // The guard the review called out: a no-op on some OTHER board has nothing to
  // record and nothing to re-bind.
  it('does nothing when the angle is unchanged on a board you are not on', async () => {
    const other = board({ uuid: 'tension-1', angle: 25 });
    const { result } = renderHook(() => useSetBoardAngle());

    await result.current(other, 25);

    expect(setStoredBoardAngleMock).not.toHaveBeenCalled();
    expect(setActiveBoardMock).not.toHaveBeenCalled();
  });

  it('records the angle for another board without touching the active one', async () => {
    const other = board({ uuid: 'tension-1', angle: 40 });
    const { result } = renderHook(() => useSetBoardAngle());

    await result.current(other, 25);

    expect(setStoredBoardAngleMock).toHaveBeenCalledWith('tension-1', 25);
    expect(setActiveBoardMock).not.toHaveBeenCalled();
  });

  // The weaker half of the behaviour still has to land: if the board record
  // write fails, the climber must still get this angle back next time they
  // stand at that board.
  it('still re-binds when recording the angle fails', async () => {
    setStoredBoardAngleMock.mockRejectedValue(new Error('storage full'));
    const { result } = renderHook(() => useSetBoardAngle());

    await result.current(board(), 25);

    expect(reportErrorMock).toHaveBeenCalled();
    expect(setActiveBoardMock).toHaveBeenCalledWith(expect.objectContaining({ angle: 25 }));
  });

  it('does not re-bind the active board when only the angle it already has is set', async () => {
    const { result } = renderHook(() => useSetBoardAngle());

    await result.current(board(), 40);

    expect(setStoredBoardAngleMock).toHaveBeenCalledWith('kilter-1', 40);
    expect(setActiveBoardMock).not.toHaveBeenCalled();
  });
});
