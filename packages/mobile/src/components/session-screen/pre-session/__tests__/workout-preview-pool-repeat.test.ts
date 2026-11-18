// A pyramid that comes back down on the same climbs (#6740): a repeat slot shows
// its twin's climb under a queue item of its own, takes nothing from a pool, and
// changes whenever its twin does.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PYRAMID_OPTIONS, generatePyramidPlan, type GeneratorGradeScale } from '@boardsesh/playlist-generator';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';

const cryptoMock = vi.hoisted(() => {
  let next = 0;
  return { randomUUID: () => `qi-${next++}` };
});
vi.mock('expo-crypto', () => ({ randomUUID: cryptoMock.randomUUID }));

import {
  NO_TOP_UPS,
  buildPoolsReusing,
  linkedRowUuids,
  poolKeyForSlot,
  refreshSlotInState,
  selectItemsFromPools,
  type FetchGradePool,
  type PreviewFetchContext,
  type PreviewItem,
  type PreviewSlot,
  type WorkoutPreviewData,
} from '../workout-preview-pool';

const GRADES: GeneratorGradeScale = Array.from({ length: 33 }, (_, position) => ({ difficulty_id: position + 1 }));

const ctx: PreviewFetchContext = {
  board: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as UserBoard,
  isAuthenticated: false,
};

function makeClimb(uuid: string): Climb {
  return { uuid, name: `Climb ${uuid}`, frames: 'p1145r15', angle: 40, difficulty: '6a' } as Climb;
}

const pyramidSlots = (numberOfSteps: number, climbsPerStep = 1, repeatOnWayDown = true): PreviewSlot[] =>
  generatePyramidPlan(
    { ...DEFAULT_PYRAMID_OPTIONS, warmUp: 'none', targetGrade: 20, numberOfSteps, climbsPerStep, repeatOnWayDown },
    GRADES,
  );

/** One pool per grade of `slots`, each climb named after its grade: `g19-0`, `g19-1`... */
function poolsFor(slots: readonly PreviewSlot[], climbsPerGrade: number): Map<string, Climb[]> {
  const pools = new Map<string, Climb[]>();
  for (const slot of slots) {
    pools.set(
      poolKeyForSlot(slot),
      Array.from({ length: climbsPerGrade }, (_, position) => makeClimb(`g${slot.grade}-${position}`)),
    );
  }
  return pools;
}

const climbsOf = (items: readonly PreviewItem[]) => items.map((preview) => preview.item.climb.uuid);
const uuidsOf = (items: readonly PreviewItem[]) => items.map((preview) => preview.item.uuid);

function stateFor(slots: readonly PreviewSlot[], pools: Map<string, Climb[]>): WorkoutPreviewData {
  const { items, usedUuids } = selectItemsFromPools(slots, pools);
  return { items, pools, usedUuids, poolDemands: new Map(), exhaustedPoolKeys: new Set() };
}

describe('selectItemsFromPools with repeat slots', () => {
  it('fills a 7-step pyramid A B C D C B A, each row its own queue item', () => {
    const slots = pyramidSlots(7);
    const { items } = selectItemsFromPools(slots, poolsFor(slots, 3));

    expect(climbsOf(items)).toEqual(['g17-0', 'g18-0', 'g19-0', 'g20-0', 'g19-0', 'g18-0', 'g17-0']);
    expect(new Set(uuidsOf(items)).size).toBe(7);
    expect(items.map((preview) => preview.slot.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('gives the two peaks of an even pyramid different climbs', () => {
    const slots = pyramidSlots(6);
    const { items } = selectItemsFromPools(slots, poolsFor(slots, 3));

    expect(climbsOf(items)).toEqual(['g18-0', 'g19-0', 'g20-0', 'g20-1', 'g19-0', 'g18-0']);
  });

  it('comes down a step of two in exact reverse', () => {
    const slots = pyramidSlots(3, 2);
    const { items } = selectItemsFromPools(slots, poolsFor(slots, 4));

    expect(climbsOf(items)).toEqual(['g19-0', 'g19-1', 'g20-0', 'g20-1', 'g19-1', 'g19-0']);
  });

  it('fills the way down with fresh climbs when the switch is off', () => {
    const slots = pyramidSlots(5, 1, false);
    const { items } = selectItemsFromPools(slots, poolsFor(slots, 3));

    expect(climbsOf(items)).toEqual(['g18-0', 'g19-0', 'g20-0', 'g19-1', 'g18-1']);
  });

  it('leaves a repeat empty with its twin, and lists only the twin as short', () => {
    const slots = pyramidSlots(5);
    const pools = poolsFor(slots, 2);
    pools.set(poolKeyForSlot(slots[0]), []);
    const { items } = selectItemsFromPools(slots, pools);

    expect(items.map((preview) => preview.slot.index)).toEqual([1, 2, 3]);
  });

  it('keeps a repeat row through a rebuild while it shows its twin climb, else gives it a fresh item', () => {
    const slots = pyramidSlots(5);
    const pools = poolsFor(slots, 3);
    const first = selectItemsFromPools(slots, pools).items;

    const kept = selectItemsFromPools(slots, pools, undefined, uuidsOfItems(first)).items;
    expect(uuidsOf(kept)).toEqual(uuidsOf(first));

    // The twin's climb is gone from its pool, so the twin and its repeat both change.
    pools.set(
      poolKeyForSlot(slots[0]),
      (pools.get(poolKeyForSlot(slots[0])) ?? []).filter((climb) => climb.uuid !== 'g18-0'),
    );
    const rebuilt = selectItemsFromPools(slots, pools, undefined, uuidsOfItems(first)).items;
    expect(climbsOf(rebuilt)[0]).toBe(climbsOf(rebuilt)[4]);
    expect(climbsOf(rebuilt)[4]).not.toBe('g18-0');
    expect(rebuilt[4].item.uuid).not.toBe(first[4].item.uuid);
  });
});

function uuidsOfItems(items: readonly PreviewItem[]): Array<ClimbQueueItem | undefined> {
  return items.map((preview) => preview.item);
}

describe('buildPoolsReusing with repeat slots', () => {
  it('sizes each pool by the slots that take a climb of their own', async () => {
    const slots = pyramidSlots(7);
    const fetchPool = vi.fn<FetchGradePool>(async () => ({ climbs: [], topUpTiers: NO_TOP_UPS }));
    await buildPoolsReusing(slots, ctx, fetchPool);

    const demandByGrade = new Map(fetchPool.mock.calls.map(([grade, , demand]) => [grade, demand]));
    expect(demandByGrade).toEqual(
      new Map([
        [17, 1],
        [18, 1],
        [19, 1],
        [20, 1],
      ]),
    );
  });
});

describe('refreshSlotInState with repeat slots', () => {
  const neverFetch: FetchGradePool = async () => {
    throw new Error('no fetch expected');
  };

  it('changes the way-down climb with its way-up twin, keeping every queue item', async () => {
    const slots = pyramidSlots(5);
    const state = stateFor(slots, poolsFor(slots, 3));
    const before = state.items;

    const result = await refreshSlotInState(state, before[0].item.uuid, ctx, neverFetch);

    expect(result.changed).toBe(true);
    const after = result.state.items;
    expect(uuidsOf(after)).toEqual(uuidsOf(before));
    expect(climbsOf(after)[0]).not.toBe(climbsOf(before)[0]);
    expect(climbsOf(after)[4]).toBe(climbsOf(after)[0]);
    expect(climbsOf(after).slice(1, 4)).toEqual(climbsOf(before).slice(1, 4));
  });

  it('changes the way-up climb when the way-down row is refreshed', async () => {
    const slots = pyramidSlots(5);
    const state = stateFor(slots, poolsFor(slots, 3));
    const before = state.items;

    const result = await refreshSlotInState(state, before[3].item.uuid, ctx, neverFetch);

    const after = result.state.items;
    expect(climbsOf(after)[3]).not.toBe(climbsOf(before)[3]);
    expect(climbsOf(after)[1]).toBe(climbsOf(after)[3]);
    expect(after[3].item.uuid).toBe(before[3].item.uuid);
    expect(after[1].item.uuid).toBe(before[1].item.uuid);
  });

  it('says nothing new when the twins hold the only climb of their grade', async () => {
    const slots = pyramidSlots(3);
    const pools = poolsFor(slots, 1);
    const state = { ...stateFor(slots, pools), exhaustedPoolKeys: new Set(pools.keys()) };

    const result = await refreshSlotInState(state, state.items[2].item.uuid, ctx, neverFetch);

    expect(result.changed).toBe(false);
    expect(result.nothingNew).toBe(true);
  });
});

describe('linkedRowUuids', () => {
  it('names a row and its twin from either side, and a plain row alone', () => {
    const slots = pyramidSlots(5);
    const { items } = selectItemsFromPools(slots, poolsFor(slots, 3));
    const [first, second, peak, fourth, fifth] = uuidsOf(items);

    expect(linkedRowUuids(items, first)).toEqual([first, fifth]);
    expect(linkedRowUuids(items, fifth)).toEqual([first, fifth]);
    expect(linkedRowUuids(items, fourth)).toEqual([second, fourth]);
    expect(linkedRowUuids(items, peak)).toEqual([peak]);
    expect(linkedRowUuids(items, 'gone')).toEqual([]);
  });
});
