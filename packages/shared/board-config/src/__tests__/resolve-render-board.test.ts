// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

import { describe, it, expect } from 'vitest';
import { getSetsForLayoutAndSize } from '@boardsesh/board-constants/product-sizes';
import { getSizeRank } from '@boardsesh/board-constants/size-comparison';
import { getDefaultRenderBoard, resolveRenderBoard, type RenderBoardCandidate } from '../resolve-render-board';

// Real Kilter layout 1 sizes, biggest first by `getSizeRank` (height, then width):
//   7  = 12 x 14 Commercial   (the layout's biggest)
//   28 = 16 x 12 Super Wide   (wider but shorter — biggest by raw area)
//   10 = 12 x 12 with kickboard
//   14 = 7 x 10 Small         (the layout's smallest)
const KILTER_LAYOUT = 1;
const COMMERCIAL_12X14 = 7;
const SUPER_WIDE_16X12 = 28;
const SQUARE_12X12 = 10;
const SMALL_7X10 = 14;
const KILTER_SETS = getSetsForLayoutAndSize('kilter', KILTER_LAYOUT, COMMERCIAL_12X14).map((set) => set.id);

// Woods: one layout, one synthetic hold set, two sizes with no product-size rows.
const WOODS_LAYOUT = 1;
const WOODS_8X10 = 1;
const WOODS_12X12 = 2;
const WOODS_SET = 1;

function ownedBoard(sizeId: number, overrides: Partial<RenderBoardCandidate> = {}): RenderBoardCandidate {
  return {
    boardType: 'kilter',
    layoutId: KILTER_LAYOUT,
    sizeId,
    setIds: KILTER_SETS,
    isOwned: true,
    ...overrides,
  };
}

describe('resolveRenderBoard', () => {
  it('uses the board the ascent was logged against, whatever else the climber owns', () => {
    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: [COMMERCIAL_12X14, SQUARE_12X12, SMALL_7X10],
      requiredSetIds: KILTER_SETS,
      tickBoard: ownedBoard(SQUARE_12X12),
      ownerBoards: [ownedBoard(SMALL_7X10), ownedBoard(COMMERCIAL_12X14)],
    });

    expect(result).toEqual({ layoutId: KILTER_LAYOUT, sizeId: SQUARE_12X12, setIds: KILTER_SETS });
  });

  it('ignores a tick board set on another layout — its holds would not line up', () => {
    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: [COMMERCIAL_12X14],
      tickBoard: ownedBoard(SQUARE_12X12, { layoutId: 8 }),
      ownerBoards: [],
    });

    expect(result?.layoutId).toBe(KILTER_LAYOUT);
    expect(result?.sizeId).toBe(COMMERCIAL_12X14);
  });

  it("falls back to the smallest of the climber's boards the climb fits on", () => {
    // The reported bug (#4221): an unassociated tick from a climber whose only
    // wall is a 12x12 used to render on the 12x14.
    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: [COMMERCIAL_12X14, SUPER_WIDE_16X12, SQUARE_12X12],
      requiredSetIds: KILTER_SETS,
      tickBoard: null,
      ownerBoards: [ownedBoard(COMMERCIAL_12X14), ownedBoard(SQUARE_12X12)],
    });

    expect(result?.sizeId).toBe(SQUARE_12X12);
  });

  it('prefers an owned board over a followed one, even when the followed one is smaller', () => {
    const followedSmall = ownedBoard(SMALL_7X10, { isOwned: false });
    const ownedBig = ownedBoard(COMMERCIAL_12X14);

    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: [COMMERCIAL_12X14, SMALL_7X10],
      // Caller order is owned-first; ownership outranks the smallest-fits rule.
      ownerBoards: [ownedBig, followedSmall],
    });

    expect(result?.sizeId).toBe(COMMERCIAL_12X14);
  });

  it('still prefers the owned board when the followed one comes first', () => {
    // The other side of the ownership branch: reduce starts on the followed
    // board, so the owned one has to win by replacing the accumulator.
    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: [COMMERCIAL_12X14, SMALL_7X10],
      ownerBoards: [ownedBoard(SMALL_7X10, { isOwned: false }), ownedBoard(COMMERCIAL_12X14)],
    });

    expect(result?.sizeId).toBe(COMMERCIAL_12X14);
  });

  it('breaks a same-size tie on caller order (lowest user_boards.id first)', () => {
    const first = ownedBoard(SQUARE_12X12, { setIds: KILTER_SETS });
    const second = ownedBoard(SQUARE_12X12, { setIds: [...KILTER_SETS].reverse() });

    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: [SQUARE_12X12],
      ownerBoards: [first, second],
    });

    expect(result?.setIds).toEqual(first.setIds);
  });

  it('skips a board of theirs that is missing a set the climb needs', () => {
    const woodOnly = ownedBoard(SQUARE_12X12, { setIds: [KILTER_SETS[0]] });

    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: [COMMERCIAL_12X14, SQUARE_12X12],
      requiredSetIds: KILTER_SETS,
      ownerBoards: [woodOnly, ownedBoard(COMMERCIAL_12X14)],
    });

    expect(result?.sizeId).toBe(COMMERCIAL_12X14);
  });

  it('skips boards of a different board type', () => {
    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: [COMMERCIAL_12X14, SMALL_7X10],
      ownerBoards: [ownedBoard(SMALL_7X10, { boardType: 'tension' })],
    });

    expect(result?.sizeId).toBe(COMMERCIAL_12X14);
  });

  it('renders at the size closest to their biggest board when none of theirs fits', () => {
    // They only have the 7x10; the climb needs at least a 12x12 with kickboard.
    // Closest by rank to the 7x10 is the 12x12, not the 12x14 the old default
    // would have drawn.
    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: [COMMERCIAL_12X14, SQUARE_12X12],
      ownerBoards: [ownedBoard(SMALL_7X10)],
    });

    expect(result?.sizeId).toBe(SQUARE_12X12);
    expect(getSizeRank('kilter', SQUARE_12X12)).toBeLessThan(getSizeRank('kilter', COMMERCIAL_12X14));
  });

  it('ignores a board from another product family when sizing the fallback', () => {
    // A Kilter Homewall (layout 8) size lives in a different coordinate frame,
    // so its rank says nothing about how big a Commercial wall they climb on.
    const homewall = ownedBoard(25, { layoutId: 8 });

    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: [COMMERCIAL_12X14, SQUARE_12X12],
      ownerBoards: [homewall],
    });

    expect(result).toEqual(getDefaultRenderBoard('kilter', KILTER_LAYOUT));
  });

  it('falls back to the layout default when the climber has no boards at all', () => {
    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: [SQUARE_12X12, SMALL_7X10],
      ownerBoards: [],
    });

    expect(result).toEqual(getDefaultRenderBoard('kilter', KILTER_LAYOUT));
    expect(result?.sizeId).toBe(COMMERCIAL_12X14);
  });

  it('treats unknown compatibility columns as "no constraint"', () => {
    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: null,
      requiredSetIds: null,
      ownerBoards: [ownedBoard(SMALL_7X10)],
    });

    expect(result?.sizeId).toBe(SMALL_7X10);
  });

  it('returns null for a board type we do not know', () => {
    expect(resolveRenderBoard({ boardType: 'not-a-board', climbLayoutId: 1 })).toBeNull();
  });
});

describe('getDefaultRenderBoard', () => {
  it("picks the layout's biggest size — tallest first, widest to break ties", () => {
    // 16x12 has more area than 12x14 but is shorter; the Commercial 12x14 is the
    // board people mean by "the big Kilter".
    expect(getDefaultRenderBoard('kilter', KILTER_LAYOUT)).toEqual({
      layoutId: KILTER_LAYOUT,
      sizeId: COMMERCIAL_12X14,
      setIds: KILTER_SETS,
    });
  });

  it('resolves the orphaned Kilter layouts that are no longer in the size tables', () => {
    // Layouts 2-7 still show up in historical ticks. Web used to render nothing
    // at all for these.
    expect(getDefaultRenderBoard('kilter', 2)).toEqual({ layoutId: 2, sizeId: 11, setIds: [21] });
  });

  it("gives MoonBoard its single fixed size and that layout's sets", () => {
    const result = getDefaultRenderBoard('moonboard', 2);
    expect(result?.sizeId).toBe(1);
    expect(result?.setIds.length).toBeGreaterThan(0);
  });

  it('defaults MoonBoard to the 2024 layout when the layout is unknown', () => {
    expect(getDefaultRenderBoard('moonboard', null)?.layoutId).toBe(3);
  });

  it('falls back to the first layout when a board carries none', () => {
    expect(getDefaultRenderBoard('kilter', null)?.layoutId).toBe(KILTER_LAYOUT);
  });

  it('returns null for an unknown board', () => {
    expect(getDefaultRenderBoard('not-a-board', 1)).toBeNull();
  });

  it('gives Woods the 12x12 and its single synthetic hold set', () => {
    expect(getDefaultRenderBoard('woods', WOODS_LAYOUT)).toEqual({
      layoutId: WOODS_LAYOUT,
      sizeId: WOODS_12X12,
      setIds: [WOODS_SET],
    });
    expect(getDefaultRenderBoard('woods', null)).toEqual({
      layoutId: WOODS_LAYOUT,
      sizeId: WOODS_12X12,
      setIds: [WOODS_SET],
    });
  });
});

/**
 * Woods runs its own ladder: the Aurora product-size tables carry no Woods rows,
 * so the generic rungs 3 and 4 have nothing to read. Size is the whole point of
 * it — the 8x10 numbers its holds 0-484 and the 12x12 numbers its own 0-893, so
 * an 8x10 climb drawn on the 12x12 doesn't fail, it silently draws the wrong
 * holds.
 */
describe('resolveRenderBoard — Woods', () => {
  function woodsBoard(sizeId: number, overrides: Partial<RenderBoardCandidate> = {}): RenderBoardCandidate {
    return { boardType: 'woods', layoutId: WOODS_LAYOUT, sizeId, setIds: [WOODS_SET], isOwned: true, ...overrides };
  }

  it('uses the board the ascent was logged against', () => {
    expect(
      resolveRenderBoard({
        boardType: 'woods',
        climbLayoutId: WOODS_LAYOUT,
        compatibleSizeIds: [WOODS_8X10],
        tickBoard: woodsBoard(WOODS_8X10),
        ownerBoards: [woodsBoard(WOODS_12X12)],
      }),
    ).toEqual({ layoutId: WOODS_LAYOUT, sizeId: WOODS_8X10, setIds: [WOODS_SET] });
  });

  it('refuses a tick board whose size the climb does not fit', () => {
    // Unlike the generic rung 1, which trusts the tick board outright: here that
    // would draw an 8x10 climb on 12x12 art, on holds that mean something else.
    expect(
      resolveRenderBoard({
        boardType: 'woods',
        climbLayoutId: WOODS_LAYOUT,
        compatibleSizeIds: [WOODS_8X10],
        tickBoard: woodsBoard(WOODS_12X12),
        ownerBoards: [woodsBoard(WOODS_8X10)],
      })?.sizeId,
    ).toBe(WOODS_8X10);
  });

  it('picks the smallest of their own Woods boards the climb fits on', () => {
    expect(
      resolveRenderBoard({
        boardType: 'woods',
        climbLayoutId: WOODS_LAYOUT,
        compatibleSizeIds: [WOODS_8X10, WOODS_12X12],
        ownerBoards: [woodsBoard(WOODS_12X12), woodsBoard(WOODS_8X10)],
      })?.sizeId,
    ).toBe(WOODS_8X10);
  });

  it('prefers an owned board over a followed one of the other size', () => {
    expect(
      resolveRenderBoard({
        boardType: 'woods',
        climbLayoutId: WOODS_LAYOUT,
        compatibleSizeIds: [WOODS_8X10, WOODS_12X12],
        ownerBoards: [woodsBoard(WOODS_8X10, { isOwned: false }), woodsBoard(WOODS_12X12)],
      })?.sizeId,
    ).toBe(WOODS_12X12);
  });

  it('skips a Woods board of theirs the climb does not fit', () => {
    expect(
      resolveRenderBoard({
        boardType: 'woods',
        climbLayoutId: WOODS_LAYOUT,
        compatibleSizeIds: [WOODS_8X10],
        ownerBoards: [woodsBoard(WOODS_12X12)],
      })?.sizeId,
    ).toBe(WOODS_8X10);
  });

  it('falls back to the size the climb is known to fit when they own no Woods board', () => {
    expect(
      resolveRenderBoard({
        boardType: 'woods',
        climbLayoutId: WOODS_LAYOUT,
        compatibleSizeIds: [WOODS_8X10],
        ownerBoards: [ownedBoard(SQUARE_12X12)],
      }),
    ).toEqual({ layoutId: WOODS_LAYOUT, sizeId: WOODS_8X10, setIds: [WOODS_SET] });
  });

  it('falls back to the 12x12 when nothing is known about the climb size', () => {
    expect(resolveRenderBoard({ boardType: 'woods', climbLayoutId: WOODS_LAYOUT })).toEqual({
      layoutId: WOODS_LAYOUT,
      sizeId: WOODS_12X12,
      setIds: [WOODS_SET],
    });
  });

  it('reads an empty compatibleSizeIds as no data, not as "fits nothing"', () => {
    // The schema documents `[]` as "the server has no compatibility data for
    // this climb (legacy row)", which is the same thing null means. Treating it
    // as a constraint would reject every rung and drop a climb the user has a
    // board for onto the default, matching nothing they own.
    expect(
      resolveRenderBoard({
        boardType: 'woods',
        climbLayoutId: WOODS_LAYOUT,
        compatibleSizeIds: [],
        tickBoard: woodsBoard(WOODS_8X10),
      })?.sizeId,
    ).toBe(WOODS_8X10);
    expect(
      resolveRenderBoard({
        boardType: 'woods',
        climbLayoutId: WOODS_LAYOUT,
        compatibleSizeIds: [],
        ownerBoards: [woodsBoard(WOODS_12X12)],
      })?.sizeId,
    ).toBe(WOODS_12X12);
    // With no board to reason from either, it still degrades to the 12x12
    // default rather than returning null.
    expect(resolveRenderBoard({ boardType: 'woods', climbLayoutId: WOODS_LAYOUT, compatibleSizeIds: [] })).toEqual({
      layoutId: WOODS_LAYOUT,
      sizeId: WOODS_12X12,
      setIds: [WOODS_SET],
    });
  });

  it('pins the layout to Woods when the climb carries none, whatever the tick board says', () => {
    // Woods ships exactly one layout, so a stale or cross-board tick layout id
    // must not be echoed back — the caller uses this id to look up board art.
    expect(
      resolveRenderBoard({
        boardType: 'woods',
        climbLayoutId: null,
        compatibleSizeIds: [WOODS_8X10],
        tickBoard: woodsBoard(WOODS_8X10, { layoutId: 99 }),
      }),
    ).toEqual({ layoutId: WOODS_LAYOUT, sizeId: WOODS_8X10, setIds: [WOODS_SET] });
  });
});
