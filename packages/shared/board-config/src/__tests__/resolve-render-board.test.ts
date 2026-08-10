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

  it('prefers an owned board over a followed one of the same size', () => {
    const followedSmall = ownedBoard(SMALL_7X10, { isOwned: false });
    const ownedBig = ownedBoard(COMMERCIAL_12X14);

    const result = resolveRenderBoard({
      boardType: 'kilter',
      climbLayoutId: KILTER_LAYOUT,
      compatibleSizeIds: [COMMERCIAL_12X14, SMALL_7X10],
      // Caller order is owned-first; the tie-break must not re-sort by size.
      ownerBoards: [ownedBig, followedSmall],
    });

    expect(result?.sizeId).toBe(COMMERCIAL_12X14);
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
});
