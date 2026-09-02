import { describe, expect, it } from 'vitest';
import type { BoardName } from '@boardsesh/shared-schema';
import type { Climb } from '@boardsesh/queue';
import { getProductSize, getSizesForLayoutId } from '@boardsesh/board-constants/product-sizes';
import { getSizeRank } from '@boardsesh/board-constants/size-comparison';
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

describe('getPlaylistRenderBoardTarget', () => {
  it('hands the same target object back for the same board', () => {
    // `canAddClimbToBoard` caches its ~1400-entry valid-hold-id Set on the
    // target's IDENTITY. A fresh target per call rebuilds that Set once per
    // queue row AND once per candidate size inside the upsize search, so the
    // memo is what keeps a mixed queue sheet off an O(rows x holds) rebuild.
    const board = getKnownBoard('kilter', 1);
    const first = getPlaylistRenderBoardTarget(board);
    const second = getPlaylistRenderBoardTarget({ ...board, angle: board.angle + 5 });

    // Same name/layout/size/sets — the angle never changes which holds exist.
    expect(second).toBe(first);
  });

  it('builds a separate target for a different board', () => {
    const original = getPlaylistRenderBoardTarget(getKnownBoard('kilter', 1));
    const homewall = getPlaylistRenderBoardTarget(getKnownBoard('kilter', 8));

    expect(homewall).not.toBe(original);
    expect(homewall.layout_id).toBe(8);
  });
});

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

    // The default board is the layout's top-ranked size (height first, width to
    // break ties) — the 12x14 Commercial, not the wider-but-shorter Super Wide.
    const activeSize = getProductSize(activeBoard.boardName as BoardName, activeBoard.sizeId);
    if (!activeSize) {
      throw new Error('Expected kilter layout 1 active size to resolve');
    }
    const activeRank = getSizeRank(activeBoard.boardName as BoardName, activeBoard.sizeId);
    const higherRanked = getSizesForLayoutId(activeBoard.boardName as BoardName, activeBoard.layoutId).filter(
      (size) => getSizeRank(activeBoard.boardName as BoardName, size.id) > activeRank,
    );
    expect(higherRanked).toHaveLength(0);

    // The hold exists on the active board, so the exact-fit branch answers
    // before the upsize search ever runs.
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

    // Anything but 'exact' proves the precomputed target was used rather than
    // the real one; whether it lands on 'upsized' or 'incompatible' depends on
    // whether a bigger size in the layout could take the climb.
    expect(resultWithPrecomputedTarget?.fit).not.toBe('exact');
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

describe('MoonBoard hold-set fit', () => {
  // MoonBoard 2024 (layout 3): cell 1 is Hold Set D (set 5), cell 2 is Wooden
  // Holds (set 8). getMoonBoardDetails renders the full grid whichever sets are
  // bolted on, so without the set check both climbs below would read as an exact
  // fit on a base-only wall — and the row would open into a queue the set-scoped
  // backend fetch had already emptied (#3891).
  function moonBoard2024(setIds: number[]): PlaylistRenderBoard {
    const config = getBoardConfigForPlaylist('moonboard', 3);
    if (!config) throw new Error('Missing MoonBoard 2024 board config');
    return {
      boardName: config.boardName,
      layoutId: config.layoutId,
      sizeId: config.sizeId,
      setIds: setIds.join(','),
      angle: 40,
    };
  }

  it('marks a wooden-set climb incompatible on a base-only wall', () => {
    const baseOnlyWall = moonBoard2024([5, 6, 7]);
    const climb = makeClimb({ boardType: 'moonboard', layoutId: 3, frames: 'p1r42p2r43' });

    const result = resolvePlaylistClimbRenderBoard(climb, baseOnlyWall);

    expect(result?.incompatible).toBe(true);
    expect(result?.fit).toBe('incompatible');
  });

  it('renders the same climb on the active wall once the wooden set is installed', () => {
    const woodenWall = moonBoard2024([5, 6, 7, 8]);
    const climb = makeClimb({ boardType: 'moonboard', layoutId: 3, frames: 'p1r42p2r43' });

    const result = resolvePlaylistClimbRenderBoard(climb, woodenWall);

    expect(result?.incompatible).toBe(false);
    expect(result?.fit).toBe('exact');
    expect(result?.renderBoard).toEqual(woodenWall);
  });

  it('keeps a base-set climb on a base-only wall', () => {
    const baseOnlyWall = moonBoard2024([5, 6, 7]);
    const climb = makeClimb({ boardType: 'moonboard', layoutId: 3, frames: 'p1r42p9r43' });

    const result = resolvePlaylistClimbRenderBoard(climb, baseOnlyWall);

    expect(result?.incompatible).toBe(false);
    expect(result?.fit).toBe('exact');
  });
});
