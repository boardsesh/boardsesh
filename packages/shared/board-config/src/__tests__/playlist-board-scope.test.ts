import { describe, it, expect } from 'vitest';
import { climbFitsPlaylistBoard, resolveClimbBoardScope } from '../playlist-board-scope';

describe('climbFitsPlaylistBoard', () => {
  it('accepts a climb on the playlist board and layout', () => {
    expect(climbFitsPlaylistBoard({ boardType: 'kilter', layoutId: 8 }, { boardType: 'kilter', layoutId: 8 })).toBe(
      true,
    );
  });

  it('rejects a climb from another board', () => {
    expect(climbFitsPlaylistBoard({ boardType: 'tension', layoutId: 8 }, { boardType: 'kilter', layoutId: 8 })).toBe(
      false,
    );
  });

  it('rejects a climb from another layout of the same board', () => {
    expect(climbFitsPlaylistBoard({ boardType: 'kilter', layoutId: 1 }, { boardType: 'kilter', layoutId: 8 })).toBe(
      false,
    );
  });

  it('accepts any layout of its own board for a board-wide playlist', () => {
    expect(climbFitsPlaylistBoard({ boardType: 'kilter', layoutId: 1 }, { boardType: 'kilter', layoutId: null })).toBe(
      true,
    );
  });

  it('still rejects another board for a board-wide playlist', () => {
    expect(climbFitsPlaylistBoard({ boardType: 'tension', layoutId: 1 }, { boardType: 'kilter', layoutId: null })).toBe(
      false,
    );
  });

  it('does not reject on a guess when the climb layout is unknown', () => {
    expect(climbFitsPlaylistBoard({ boardType: 'kilter', layoutId: null }, { boardType: 'kilter', layoutId: 8 })).toBe(
      true,
    );
  });

  it('still checks the board when the climb layout is unknown', () => {
    expect(climbFitsPlaylistBoard({ boardType: 'tension', layoutId: null }, { boardType: 'kilter', layoutId: 8 })).toBe(
      false,
    );
  });
});

describe('resolveClimbBoardScope', () => {
  const fallback = { boardType: 'kilter', layoutId: 8 };

  it('prefers the board and layout the climb carries', () => {
    expect(resolveClimbBoardScope({ boardType: 'tension', layoutId: 10 }, fallback)).toEqual({
      boardType: 'tension',
      layoutId: 10,
    });
  });

  it('falls back to the host board config when the climb carries neither', () => {
    expect(resolveClimbBoardScope({}, fallback)).toEqual(fallback);
  });

  it('leaves the layout unknown when the climb names another board and no layout', () => {
    // NOT { tension, 8 }: layout 8 is a Kilter layout, and a Tension playlist
    // pinned to it exists on no board at all.
    expect(resolveClimbBoardScope({ boardType: 'tension' }, fallback)).toEqual({
      boardType: 'tension',
      layoutId: null,
    });
  });

  it('takes the host layout when the climb names the host board and no layout', () => {
    expect(resolveClimbBoardScope({ boardType: 'kilter' }, fallback)).toEqual({
      boardType: 'kilter',
      layoutId: 8,
    });
  });

  it('keeps a layout the climb carries on the host board', () => {
    // No `boardType` means a single-board payload, so this layout is already in
    // the host board's namespace — the pair is real.
    expect(resolveClimbBoardScope({ layoutId: 1 }, fallback)).toEqual({
      boardType: 'kilter',
      layoutId: 1,
    });
  });

  it('treats explicit nulls the same as absent fields', () => {
    expect(resolveClimbBoardScope({ boardType: null, layoutId: null }, fallback)).toEqual(fallback);
  });

  it('never pairs a layout id with a board it was not resolved in', () => {
    // The property the per-field fallback broke: whatever comes back, the layout
    // id either came from the same side as the board or is null.
    const cases: { boardType?: string | null; layoutId?: number | null }[] = [
      {},
      { boardType: 'kilter' },
      { boardType: 'tension' },
      { layoutId: 1 },
      { boardType: 'tension', layoutId: 10 },
      { boardType: null, layoutId: 10 },
    ];
    for (const climb of cases) {
      const scope = resolveClimbBoardScope(climb, fallback);
      if (scope.layoutId === null) continue;
      const cameFromTheClimb = climb.layoutId != null && scope.layoutId === climb.layoutId;
      const cameFromTheHost = scope.boardType === fallback.boardType && scope.layoutId === fallback.layoutId;
      expect(cameFromTheClimb || cameFromTheHost).toBe(true);
      // And a layout taken off the climb only survives on the climb's own board.
      if (cameFromTheClimb) expect(scope.boardType).toBe(climb.boardType ?? fallback.boardType);
    }
  });
});
