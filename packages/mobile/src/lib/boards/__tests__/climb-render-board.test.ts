// #5099: a climb must be drawn on the board it belongs to, not on whatever
// board the climber happens to have selected. Every case below is a state the
// app reaches by ordinary use — switching boards mid-session, a party peer on
// another wall, an older queue item with no board metadata at all.
import { describe, expect, it } from 'vitest';
import type { BoardConfig } from '../../../providers/drawer-host-provider';
import { getBoardConfigForPlaylist } from '../../playlists/board-details-for-playlist';
import { formatRenderBoardLabel, resolveClimbRenderBoard, type ClimbRenderBoardClimb } from '../climb-render-board';

function knownBoard(boardType: string, layoutId: number, angle = 40): BoardConfig {
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

const homewallClimb: ClimbRenderBoardClimb = { boardType: 'kilter', layoutId: 8, angle: 30, frames: '' };

describe('resolveClimbRenderBoard', () => {
  it('leaves a climb from the active board on the active board, untouched', () => {
    const activeBoard = knownBoard('kilter', 1, 45);
    const result = resolveClimbRenderBoard({ boardType: 'kilter', layoutId: 1, angle: 40, frames: '' }, activeBoard);

    // Identity, not equality: the drawer memoises board-render data on this
    // object, so a fresh copy would churn the render on every queue update.
    expect(result?.boardConfig).toBe(activeBoard);
    expect(result?.fit).toBe('exact');
    expect(result?.incompatible).toBe(false);
  });

  it('draws a climb from another board model on its own board, at its own angle', () => {
    // The #5099 repro: browse the Homewall (layout 8), switch the active board
    // to the Original 12x12 (layout 1), and the carried-over climb is still a
    // Homewall climb.
    const activeBoard = knownBoard('kilter', 1, 45);
    const result = resolveClimbRenderBoard(homewallClimb, activeBoard);

    expect(result?.boardConfig.boardName).toBe('kilter');
    expect(result?.boardConfig.layoutId).toBe(8);
    // The angle the climb was graded at, not the wall the climber walked to.
    expect(result?.boardConfig.angle).toBe(30);
    expect(result?.fit).toBe('incompatible');
    expect(result?.incompatible).toBe(true);
  });

  it('draws a cross-brand climb on its own board', () => {
    const result = resolveClimbRenderBoard(
      { boardType: 'tension', layoutId: 9, angle: 35, frames: '' },
      knownBoard('kilter', 1),
    );

    expect(result?.boardConfig.boardName).toBe('tension');
    expect(result?.boardConfig.layoutId).toBe(9);
    expect(result?.incompatible).toBe(true);
  });

  it('upsizes to a larger wall on the same layout when the climb needs one', () => {
    // Same board model, but `compatibleSizeIds` says the climb was set on a
    // bigger size — the small wall would silently drop holds.
    const activeBoard: BoardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 14, setIds: '1,20', angle: 40 };
    const result = resolveClimbRenderBoard(
      { boardType: 'kilter', layoutId: 1, angle: 40, frames: '', compatibleSizeIds: [10] },
      activeBoard,
    );

    expect(result?.boardConfig.layoutId).toBe(1);
    expect(result?.boardConfig.sizeId).toBe(10);
    expect(result?.fit).toBe('upsized');
    expect(result?.incompatible).toBe(true);
  });

  it('keeps the active board when the climb fits its size list', () => {
    const activeBoard: BoardConfig = { boardName: 'kilter', layoutId: 1, sizeId: 14, setIds: '1,20', angle: 40 };
    const result = resolveClimbRenderBoard(
      { boardType: 'kilter', layoutId: 1, angle: 40, frames: '', compatibleSizeIds: [10, 14] },
      activeBoard,
    );

    expect(result?.boardConfig).toBe(activeBoard);
    expect(result?.incompatible).toBe(false);
  });

  it('fails open for a climb that carries no board metadata', () => {
    // Older queue items and party-synced climbs from before the metadata
    // round-trip. We cannot judge them; blanking them would be a regression on
    // surfaces that work today.
    const activeBoard = knownBoard('kilter', 1);
    const result = resolveClimbRenderBoard({ angle: 40, frames: 'p1145r15' }, activeBoard);

    expect(result?.boardConfig).toBe(activeBoard);
    expect(result?.incompatible).toBe(false);
  });

  it('fails open for a climb that names the active board but no layout', () => {
    const activeBoard = knownBoard('kilter', 1);
    const result = resolveClimbRenderBoard({ boardType: 'kilter', angle: 40, frames: '' }, activeBoard);

    expect(result?.boardConfig).toBe(activeBoard);
    expect(result?.incompatible).toBe(false);
  });

  it('fails open for a climb from another brand that names no layout', () => {
    // Without a layout the only way to place it is to GUESS one — the brand's
    // first layout, via `getDefaultRenderBoard`. That guess can land on exactly
    // the wrong-placement render this resolver exists to prevent, so a missing
    // layout stays on the active board even when the brand disagrees.
    const activeBoard = knownBoard('kilter', 1);
    const result = resolveClimbRenderBoard({ boardType: 'tension', angle: 40, frames: '' }, activeBoard);

    expect(result?.boardConfig).toBe(activeBoard);
    expect(result?.fit).toBe('exact');
    expect(result?.incompatible).toBe(false);
  });

  it('fails open for a climb naming a board we cannot build render data for', () => {
    const activeBoard = knownBoard('kilter', 1);
    const result = resolveClimbRenderBoard(
      { boardType: 'not-a-board', layoutId: 999, angle: 40, frames: '' },
      activeBoard,
    );

    expect(result?.boardConfig).toBe(activeBoard);
    expect(result?.incompatible).toBe(false);
  });

  it('resolves the climb own board when there is no active board yet', () => {
    const result = resolveClimbRenderBoard(homewallClimb, null);

    expect(result?.boardConfig.boardName).toBe('kilter');
    expect(result?.boardConfig.layoutId).toBe(8);
    expect(result?.boardConfig.angle).toBe(30);
    // Nothing to disagree with, so no board-switch prompt.
    expect(result?.incompatible).toBe(false);
  });

  it('returns null when there is neither an active board nor a resolvable one', () => {
    expect(
      resolveClimbRenderBoard({ boardType: 'not-a-board', layoutId: 999, angle: 40, frames: '' }, null),
    ).toBeNull();
    expect(resolveClimbRenderBoard(null, null)).toBeNull();
  });

  it('keeps the active board when there is no climb to place', () => {
    const activeBoard = knownBoard('kilter', 1);
    expect(resolveClimbRenderBoard(null, activeBoard)?.boardConfig).toBe(activeBoard);
  });
});

describe('formatRenderBoardLabel', () => {
  it('names the layout when the layout name already carries the brand', () => {
    // "Kilter" alone cannot tell the #5099 case apart: Homewall and Original are
    // both Kilter, and the prompt would read "Switch to Kilter" on a Kilter board.
    expect(formatRenderBoardLabel(knownBoard('kilter', 8))).toBe('Kilter Board Homewall');
    expect(formatRenderBoardLabel(knownBoard('kilter', 1))).toBe('Kilter Board Original');
  });

  it('keeps the brand when the layout name would read as a different product', () => {
    // Tension layout 9 is catalogued as "Original Layout" — on its own that
    // names no board the climber would recognise.
    expect(formatRenderBoardLabel(knownBoard('tension', 9))).toBe('Tension');
  });

  it('falls back to the brand for a board with no catalogued layout name', () => {
    expect(formatRenderBoardLabel({ ...knownBoard('kilter', 1), layoutId: 9999 })).toBe('Kilter');
  });
});
