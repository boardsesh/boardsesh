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

  it('falls back per field when the climb carries only its board', () => {
    expect(resolveClimbBoardScope({ boardType: 'tension' }, fallback)).toEqual({
      boardType: 'tension',
      layoutId: 8,
    });
  });

  it('falls back per field when the climb carries only its layout', () => {
    expect(resolveClimbBoardScope({ layoutId: 1 }, fallback)).toEqual({
      boardType: 'kilter',
      layoutId: 1,
    });
  });

  it('treats explicit nulls the same as absent fields', () => {
    expect(resolveClimbBoardScope({ boardType: null, layoutId: null }, fallback)).toEqual(fallback);
  });
});
