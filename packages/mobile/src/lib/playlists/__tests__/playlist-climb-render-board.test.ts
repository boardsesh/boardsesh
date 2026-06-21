import { describe, expect, it } from 'vitest';
import type { BoardName } from '@boardsesh/shared-schema';
import type { Climb } from '@boardsesh/queue';
import { getProductSize, getSizesForLayoutId } from '@boardsesh/board-constants/product-sizes';
import { getBoardConfigForPlaylist } from '../board-details-for-playlist';
import type { PlaylistRenderBoard } from '../use-playlist-render-board';
import { getPlaylistRenderBoardTarget, resolvePlaylistClimbRenderBoard } from '../playlist-climb-render-board';

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    layoutId: 1,
    boardType: 'kilter',
    setter_username: 'setter',
    name: 'Test Climb',
    frames: '',
    angle: 40,
    ascensionist_count: 0,
    difficulty: 'V5',
    quality_average: '0',
    stars: 0,
    difficulty_error: '0',
    benchmark_difficulty: null,
    ...overrides,
  };
}

function getKnownBoard(boardType: string, layoutId: number, angle = 40): PlaylistRenderBoard {
  const config = getBoardConfigForPlaylist(boardType, layoutId);
  if (!config) throw new Error(`Missing board config for ${boardType}:${layoutId}`);
  return {
    boardName: config.boardName,
    layoutId: config.layoutId,
    sizeId: config.sizeId,
    setIds: config.setIds.join(','),
    angle,
  };
}

describe('resolvePlaylistClimbRenderBoard', () => {
  it('uses the active board when the climb is compatible with it', () => {
    const activeBoard = getKnownBoard('kilter', 1, 45);
    const result = resolvePlaylistClimbRenderBoard(makeClimb({ angle: 40 }), activeBoard);

    expect(result).toEqual({
      renderBoard: activeBoard,
      fit: 'exact',
      incompatible: false,
    });
  });

  it('honors a precomputed active-board compatibility target', () => {
    const activeBoard = getKnownBoard('kilter', 1, 45);
    const actualTarget = getPlaylistRenderBoardTarget(activeBoard);
    const firstHoldId = actualTarget.holdsData?.[0]?.id;
    if (firstHoldId == null) {
      throw new Error('Expected kilter layout 1 to expose renderable holds');
    }

    const activeSize = getProductSize(activeBoard.boardName as BoardName, activeBoard.sizeId);
    if (!activeSize) {
      throw new Error('Expected kilter layout 1 active size to resolve');
    }
    const activeArea = (activeSize.edgeRight - activeSize.edgeLeft) * (activeSize.edgeTop - activeSize.edgeBottom);
    const largerSizes = getSizesForLayoutId(activeBoard.boardName as BoardName, activeBoard.layoutId).filter((size) => {
      const sizeArea = (size.edgeRight - size.edgeLeft) * (size.edgeTop - size.edgeBottom);
      return sizeArea > activeArea;
    });
    expect(largerSizes).toHaveLength(0);

    const climb = makeClimb({ frames: `p${firstHoldId}r42` });
    const resultWithActualTarget = resolvePlaylistClimbRenderBoard(climb, activeBoard, actualTarget);
    expect(resultWithActualTarget).toEqual({
      renderBoard: activeBoard,
      fit: 'exact',
      incompatible: false,
    });

    const resultWithPrecomputedTarget = resolvePlaylistClimbRenderBoard(climb, activeBoard, {
      board_name: activeBoard.boardName as BoardName,
      layout_id: activeBoard.layoutId,
      holdsData: [{ id: -1 }],
    });

    expect(resultWithPrecomputedTarget?.fit).toBe('incompatible');
    expect(resultWithPrecomputedTarget?.incompatible).toBe(true);
  });

  it('uses the smallest larger size when the climb needs more board than the active size', () => {
    const activeBoard: PlaylistRenderBoard = {
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 14,
      setIds: '1,20',
      angle: 40,
    };
    const result = resolvePlaylistClimbRenderBoard(makeClimb({ frames: 'p1073r42' }), activeBoard);

    expect(result?.renderBoard.boardName).toBe('kilter');
    expect(result?.renderBoard.layoutId).toBe(1);
    expect(result?.renderBoard.sizeId).toBe(10);
    expect(result?.renderBoard.setIds).toBe('1,20');
    expect(result?.fit).toBe('upsized');
    expect(result?.incompatible).toBe(true);
  });

  it('renders a different-board climb on its own board and marks it incompatible', () => {
    const activeBoard = getKnownBoard('kilter', 1);
    const result = resolvePlaylistClimbRenderBoard(
      makeClimb({ boardType: 'tension', layoutId: 9, angle: 35 }),
      activeBoard,
    );

    expect(result?.renderBoard.boardName).toBe('tension');
    expect(result?.renderBoard.layoutId).toBe(9);
    expect(result?.renderBoard.angle).toBe(35);
    expect(result?.fit).toBe('incompatible');
    expect(result?.incompatible).toBe(true);
  });

  it('does not mark a climb incompatible solely because there is no active board', () => {
    const result = resolvePlaylistClimbRenderBoard(makeClimb({ boardType: 'tension', layoutId: 9, angle: 30 }), null);

    expect(result?.renderBoard.boardName).toBe('tension');
    expect(result?.renderBoard.layoutId).toBe(9);
    expect(result?.renderBoard.angle).toBe(30);
    expect(result?.fit).toBe('exact');
    expect(result?.incompatible).toBe(false);
  });

  it('returns null when the climb board cannot be resolved', () => {
    const result = resolvePlaylistClimbRenderBoard(makeClimb({ boardType: 'unknown-board', layoutId: 999 }), null);

    expect(result).toBeNull();
  });
});
