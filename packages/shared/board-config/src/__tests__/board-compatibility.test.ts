import { describe, expect, it } from 'vitest';
import {
  canAddClimbToBoard,
  classifyClimbBoardCompatibility,
  findNextCompatibleQueueItem,
  type ActiveBoardForCompatibility,
  type ClimbBoardIdentity,
} from '../board-compatibility';
import type { BoardCompatibilityTarget } from '../types';

const KILTER_L1: ActiveBoardForCompatibility = { boardName: 'kilter', layoutId: 1 };
const KILTER_HOMEWALL_L8: ActiveBoardForCompatibility = { boardName: 'kilter', layoutId: 8 };
const MOONBOARD_2016: ActiveBoardForCompatibility = { boardName: 'moonboard', layoutId: 1 };

type TestQueueItem = { uuid: string; climb: ClimbBoardIdentity & { uuid: string } };

function makeItem(uuid: string, climb: ClimbBoardIdentity = {}): TestQueueItem {
  return { uuid, climb: { uuid: `c-${uuid}`, ...climb } };
}

describe('classifyClimbBoardCompatibility', () => {
  it('returns unknown when the active config is missing', () => {
    expect(classifyClimbBoardCompatibility(undefined, { boardType: 'kilter', layoutId: 1 })).toBe('unknown');
  });

  it('returns unknown when the climb carries no board metadata', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: undefined, layoutId: undefined })).toBe('unknown');
  });

  it('returns compatible when known boardType and layoutId match', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: 'kilter', layoutId: 1 })).toBe('compatible');
  });

  it('returns incompatible on a different boardType', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: 'tension', layoutId: 1 })).toBe('incompatible');
  });

  it('returns incompatible on a different layoutId', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: 'kilter', layoutId: 8 })).toBe('incompatible');
  });

  it('falls through to the layout check when boardType is unrecognised', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: 'mystery', layoutId: 1 })).toBe('compatible');
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: 'mystery', layoutId: 8 })).toBe('incompatible');
  });

  it('judges on layout alone when only layoutId is known', () => {
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: undefined, layoutId: 1 })).toBe('compatible');
    expect(classifyClimbBoardCompatibility(KILTER_L1, { boardType: undefined, layoutId: 8 })).toBe('incompatible');
  });

  it('treats Woods physical size as part of lighting identity', () => {
    const wall = { boardName: 'woods' as const, layoutId: 1, sizeId: 2 };
    expect(classifyClimbBoardCompatibility(wall, { boardType: 'woods', layoutId: 1, compatibleSizeIds: [1] })).toBe(
      'incompatible',
    );
    expect(classifyClimbBoardCompatibility(wall, { boardType: 'woods', layoutId: 1, compatibleSizeIds: [2] })).toBe(
      'compatible',
    );
    const queue = [
      makeItem('small', { boardType: 'woods', layoutId: 1, compatibleSizeIds: [1] }),
      makeItem('large', { boardType: 'woods', layoutId: 1, compatibleSizeIds: [2] }),
    ];
    expect(findNextCompatibleQueueItem(queue, 'small', wall)).toMatchObject({
      item: { uuid: 'large' },
      skippedCount: 1,
    });
  });

  // Issue #5109. Kilter product sizes: 7 is the 12 x 14 commercial wall, 10 the
  // 12 x 12 with kickboard. A climb set on the 12 x 14 uses placements the
  // smaller wall doesn't have, so writing it lights a partial climb and buzzes
  // success. Only callers that know the PHYSICAL wall name a size — the BLE
  // auto-sender does, the add gate and the swipe navigator don't.
  describe('connected-wall size', () => {
    const KILTER_L1_12X12: ActiveBoardForCompatibility = { boardName: 'kilter', layoutId: 1, sizeId: 10 };

    it('flags a climb set on a bigger wall of the same layout', () => {
      expect(
        classifyClimbBoardCompatibility(KILTER_L1_12X12, { boardType: 'kilter', layoutId: 1, compatibleSizeIds: [7] }),
      ).toBe('incompatible');
    });

    it('keeps a climb that fits the connected size compatible', () => {
      expect(
        classifyClimbBoardCompatibility(KILTER_L1_12X12, {
          boardType: 'kilter',
          layoutId: 1,
          compatibleSizeIds: [7, 10],
        }),
      ).toBe('compatible');
    });

    it('leaves the answer untouched when the caller names no wall size', () => {
      expect(
        classifyClimbBoardCompatibility(KILTER_L1, { boardType: 'kilter', layoutId: 1, compatibleSizeIds: [7] }),
      ).toBe('compatible');
    });

    it('treats missing and empty size metadata as no signal, not a mismatch', () => {
      // Legacy rows, party-synced climbs and `?? []` fetch paths all land here;
      // turning any of them into 'incompatible' would skip climbs that light fine.
      expect(classifyClimbBoardCompatibility(KILTER_L1_12X12, { boardType: 'kilter', layoutId: 1 })).toBe('compatible');
      expect(
        classifyClimbBoardCompatibility(KILTER_L1_12X12, { boardType: 'kilter', layoutId: 1, compatibleSizeIds: null }),
      ).toBe('compatible');
      expect(
        classifyClimbBoardCompatibility(KILTER_L1_12X12, { boardType: 'kilter', layoutId: 1, compatibleSizeIds: [] }),
      ).toBe('compatible');
    });

    it('stays unknown for a climb that names sizes but no board or layout', () => {
      // Sizes alone can't be judged: size ids only mean something once we know
      // which board the climb is from.
      expect(classifyClimbBoardCompatibility(KILTER_L1_12X12, { compatibleSizeIds: [7] })).toBe('unknown');
    });

    it('skips an upsized climb in the queue scan when the wall names its size', () => {
      const queue = [
        makeItem('twelve-by-fourteen', { boardType: 'kilter', layoutId: 1, compatibleSizeIds: [7] }),
        makeItem('fits', { boardType: 'kilter', layoutId: 1, compatibleSizeIds: [7, 10] }),
      ];
      expect(findNextCompatibleQueueItem(queue, 'twelve-by-fourteen', KILTER_L1_12X12)).toMatchObject({
        item: { uuid: 'fits' },
        skippedCount: 1,
      });
      // The same queue on a caller that only knows the board model (the swipe
      // navigator) still stops on the first item — behaviour there is unchanged.
      expect(findNextCompatibleQueueItem(queue, 'twelve-by-fourteen', KILTER_L1)).toMatchObject({
        item: { uuid: 'twelve-by-fourteen' },
        skippedCount: 0,
      });
    });
  });

  // MoonBoard 2024 (layout 3): cell 1 belongs to Hold Set D (set 5), cells 2 and
  // 17 to the wooden sets (8 and 10). The grid is the full grid whichever sets
  // are bolted on, so the cell-to-set map is the only thing that can tell a
  // wooden-set climb from a base-set one before it reaches the wall.
  describe('connected-wall hold sets', () => {
    const WOODEN_SET_FRAMES = 'p1r42p2r43p17r44';
    const BASE_SET_FRAMES = 'p1r42p9r43';
    const baseOnlyWall: ActiveBoardForCompatibility = { boardName: 'moonboard', layoutId: 3, setIds: '5' };

    it('flags a wooden-set climb on a wall built without the wooden sets', () => {
      expect(
        classifyClimbBoardCompatibility(baseOnlyWall, {
          boardType: 'moonboard',
          layoutId: 3,
          frames: WOODEN_SET_FRAMES,
        }),
      ).toBe('incompatible');
    });

    it('accepts the same climb once the wooden sets are installed', () => {
      expect(
        classifyClimbBoardCompatibility(
          { boardName: 'moonboard', layoutId: 3, setIds: [5, 8, 10] },
          { boardType: 'moonboard', layoutId: 3, frames: WOODEN_SET_FRAMES },
        ),
      ).toBe('compatible');
    });

    it('accepts a base-set climb on a base-only wall', () => {
      expect(
        classifyClimbBoardCompatibility(baseOnlyWall, { boardType: 'moonboard', layoutId: 3, frames: BASE_SET_FRAMES }),
      ).toBe('compatible');
    });

    it('skips the check when the wall names no sets or the climb has no frames', () => {
      expect(
        classifyClimbBoardCompatibility(
          { boardName: 'moonboard', layoutId: 3 },
          { boardType: 'moonboard', layoutId: 3, frames: WOODEN_SET_FRAMES },
        ),
      ).toBe('compatible');
      expect(classifyClimbBoardCompatibility(baseOnlyWall, { boardType: 'moonboard', layoutId: 3 })).toBe('compatible');
      expect(
        classifyClimbBoardCompatibility(
          { boardName: 'moonboard', layoutId: 3, setIds: '' },
          { boardType: 'moonboard', layoutId: 3, frames: WOODEN_SET_FRAMES },
        ),
      ).toBe('compatible');
    });

    it('does not apply the MoonBoard cell-set map to Aurora boards', () => {
      // Aurora placements are per-set, so an uninstalled set's holds are absent
      // from the wall's placement map — caught by hold-id containment at send
      // time. Running the MoonBoard map over Kilter frames would reject on hold
      // ids that mean something else entirely.
      expect(
        classifyClimbBoardCompatibility(
          { boardName: 'kilter', layoutId: 3, setIds: '1' },
          { boardType: 'kilter', layoutId: 3, frames: WOODEN_SET_FRAMES },
        ),
      ).toBe('compatible');
    });
  });

  // Production repros from issue #3193 (Sentry BOARDSESH-39 / BOARDSESH-6P):
  // kilter layout-1 climbs sent while the app was on a Homewall or MoonBoard config.
  it('flags a kilter original climb as incompatible with a kilter Homewall board (BOARDSESH-39)', () => {
    expect(classifyClimbBoardCompatibility(KILTER_HOMEWALL_L8, { boardType: 'kilter', layoutId: 1 })).toBe(
      'incompatible',
    );
  });

  it('flags a kilter climb as incompatible with a moonboard, even when layout ids collide (BOARDSESH-6P)', () => {
    // MoonBoard layout ids are a separate 1-7 space; boardType must win before layout.
    expect(classifyClimbBoardCompatibility(MOONBOARD_2016, { boardType: 'kilter', layoutId: 1 })).toBe('incompatible');
  });
});

describe('findNextCompatibleQueueItem', () => {
  it('skips a run of spill climbs and returns the next compatible one with the count', () => {
    const queue = [
      makeItem('q0', { boardType: 'kilter', layoutId: 1 }),
      makeItem('q1', { boardType: 'tension', layoutId: 1 }), // spill
      makeItem('q2', { boardType: 'kilter', layoutId: 8 }), // spill (layout)
      makeItem('q3', { boardType: 'kilter', layoutId: 1 }), // compatible
    ];
    // Start at the spill at q1.
    const result = findNextCompatibleQueueItem(queue, 'q1', KILTER_L1);
    expect(result.item?.uuid).toBe('q3');
    expect(result.skippedCount).toBe(2);
  });

  it('returns the current item with skippedCount 0 when it is already compatible', () => {
    const queue = [
      makeItem('q0', { boardType: 'kilter', layoutId: 1 }),
      makeItem('q1', { boardType: 'kilter', layoutId: 1 }),
    ];
    const result = findNextCompatibleQueueItem(queue, 'q0', KILTER_L1);
    expect(result.item?.uuid).toBe('q0');
    expect(result.skippedCount).toBe(0);
  });

  it('returns null when every remaining climb is incompatible', () => {
    const queue = [
      makeItem('q0', { boardType: 'tension', layoutId: 1 }),
      makeItem('q1', { boardType: 'kilter', layoutId: 8 }),
    ];
    const result = findNextCompatibleQueueItem(queue, 'q0', KILTER_L1);
    expect(result.item).toBeNull();
    expect(result.skippedCount).toBe(2);
  });

  it('treats unknown-metadata climbs as sendable (not skipped)', () => {
    const queue = [
      makeItem('q0', { boardType: 'tension', layoutId: 1 }), // spill
      makeItem('q1', { boardType: undefined, layoutId: undefined }), // unknown → stop here
    ];
    const result = findNextCompatibleQueueItem(queue, 'q0', KILTER_L1);
    expect(result.item?.uuid).toBe('q1');
    expect(result.skippedCount).toBe(1);
  });

  it('returns the current item unskipped when the active config is unknown', () => {
    const queue = [
      makeItem('q0', { boardType: 'tension', layoutId: 1 }),
      makeItem('q1', { boardType: 'kilter', layoutId: 1 }),
    ];
    const result = findNextCompatibleQueueItem(queue, 'q0', undefined);
    expect(result.item?.uuid).toBe('q0');
    expect(result.skippedCount).toBe(0);
  });

  it('scans from the queue head when the current uuid is no longer in the queue', () => {
    // A racing queue mutation can remove the current item between the
    // incompatibility check and this scan; the fallback restarts from the head
    // and still refuses spills.
    const queue = [
      makeItem('q0', { boardType: 'tension', layoutId: 1 }), // spill
      makeItem('q1', { boardType: 'kilter', layoutId: 1 }), // compatible
    ];
    const result = findNextCompatibleQueueItem(queue, 'gone', KILTER_L1);
    expect(result.item?.uuid).toBe('q1');
    expect(result.skippedCount).toBe(1);
  });
});

describe('canAddClimbToBoard — MoonBoard hold-set containment', () => {
  // MoonBoard 2024 (layout 3). getMoonBoardDetails emits the whole grid as
  // holdsData whichever add-on sets are bolted on, so the hold-id check below
  // passes for every same-layout climb — the set check is the only thing that
  // can tell a wooden-set climb from a base-set one.
  const FULL_GRID_HOLDS = Array.from({ length: 198 }, (_, index) => ({ id: index + 1 }));

  function moonBoard2024(setIds?: number[]): BoardCompatibilityTarget {
    return { board_name: 'moonboard', layout_id: 3, holdsData: FULL_GRID_HOLDS, set_ids: setIds };
  }

  // Cell 1 is Hold Set D (set 5); cells 2 and 17 are the wooden sets (8 and 10).
  const BASE_SET_CLIMB = { boardType: 'moonboard', layoutId: 3, frames: 'p1r42p9r43' };
  const WOODEN_SET_CLIMB = { boardType: 'moonboard', layoutId: 3, frames: 'p1r42p2r43p17r44' };

  it('rejects a wooden-set climb on a wall built without the wooden sets', () => {
    expect(canAddClimbToBoard(WOODEN_SET_CLIMB, moonBoard2024([5]))).toEqual({
      ok: false,
      reason: 'holds_out_of_range',
    });
  });

  it('accepts the same climb once the wooden sets are installed', () => {
    expect(canAddClimbToBoard(WOODEN_SET_CLIMB, moonBoard2024([5, 8, 10]))).toEqual({ ok: true });
  });

  it('accepts a base-set climb on a base-only wall', () => {
    expect(canAddClimbToBoard(BASE_SET_CLIMB, moonBoard2024([5]))).toEqual({ ok: true });
  });

  it('skips the set check when the caller supplies no set_ids', () => {
    // Opt-in: callers that never knew about hold sets keep their old answer
    // rather than silently losing every wooden-set climb.
    expect(canAddClimbToBoard(WOODEN_SET_CLIMB, moonBoard2024())).toEqual({ ok: true });
  });

  it('does not apply the MoonBoard cell-set map to Aurora boards', () => {
    // Aurora hold placements are already per-set, so their uninstalled-set holds
    // fail the hold-id check instead. Running the MoonBoard map over a Kilter
    // frames string would reject on hold ids that mean something else entirely.
    const kilterTarget: BoardCompatibilityTarget = {
      board_name: 'kilter',
      layout_id: 3,
      holdsData: FULL_GRID_HOLDS,
      set_ids: [5],
    };
    expect(canAddClimbToBoard({ boardType: 'kilter', layoutId: 3, frames: 'p1r42p2r43p17r44' }, kilterTarget)).toEqual({
      ok: true,
    });
  });
});

/**
 * Rule 5. Woods' two boards number their holds from their own origins — the 8x10
 * runs 0-484, the 12x12 runs 0-893 — so every 8x10 climb's hold ids exist on the
 * 12x12 as different holds and rule 3 waves it straight through. Size
 * containment is the only thing that can separate them.
 */
describe('canAddClimbToBoard — size containment', () => {
  const WOODS_12X12_HOLDS = Array.from({ length: 894 }, (_, index) => ({ id: index }));

  function woodsWall(sizeId: number): BoardCompatibilityTarget {
    return { board_name: 'woods', layout_id: 1, size_id: sizeId, set_ids: [1], holdsData: WOODS_12X12_HOLDS };
  }

  // Hold ids well inside the 8x10's 0-484 range, so rule 3 cannot reject it.
  const EIGHT_BY_TEN_CLIMB = {
    boardType: 'woods',
    layoutId: 1,
    frames: 'p12r4p207r2p418r3',
    compatibleSizeIds: [1],
  };

  it('rejects an 8x10 climb on the 12x12, which hold-id containment lets through', () => {
    expect(canAddClimbToBoard({ ...EIGHT_BY_TEN_CLIMB, compatibleSizeIds: undefined }, woodsWall(2))).toEqual({
      ok: true,
    });
    expect(canAddClimbToBoard(EIGHT_BY_TEN_CLIMB, woodsWall(2))).toEqual({ ok: false, reason: 'size' });
  });

  it('accepts the same climb on the 8x10 it was set on', () => {
    expect(canAddClimbToBoard(EIGHT_BY_TEN_CLIMB, woodsWall(1))).toEqual({ ok: true });
  });

  it('accepts a climb that names several sizes when the wall is one of them', () => {
    expect(canAddClimbToBoard({ ...EIGHT_BY_TEN_CLIMB, compatibleSizeIds: [1, 2] }, woodsWall(2))).toEqual({
      ok: true,
    });
  });

  it('skips the check when either half is unknown, so Aurora and MoonBoard are unchanged', () => {
    // The wall names no size (every caller that never knew about sizes).
    expect(
      canAddClimbToBoard(EIGHT_BY_TEN_CLIMB, { board_name: 'woods', layout_id: 1, holdsData: WOODS_12X12_HOLDS }),
    ).toEqual({ ok: true });
    // A Kilter climb with no denormalised sizes on a wall that does name one.
    expect(
      canAddClimbToBoard(
        { boardType: 'kilter', layoutId: 1, frames: 'p1r42' },
        { board_name: 'kilter', layout_id: 1, size_id: 10, holdsData: [{ id: 1 }] },
      ),
    ).toEqual({ ok: true });
  });
});
