import { describe, expect, it, vi } from 'vitest';
import type { Climb, UserBoard } from '@boardsesh/shared-schema';
import type { PlannedClimbSlot } from '@boardsesh/playlist-generator';

// Monotonic uuids so each generated queue item is distinct (the real
// climbToQueueItem uses expo-crypto's randomUUID for the queue-item uuid).
const cryptoMock = vi.hoisted(() => {
  let n = 0;
  return { randomUUID: () => `qi-${n++}` };
});
vi.mock('expo-crypto', () => ({ randomUUID: cryptoMock.randomUUID }));

import {
  buildPools,
  pickRandomUnused,
  pickUnused,
  refreshSlotInState,
  selectItemsFromPools,
  type PreviewFetchContext,
  type WorkoutPreviewData,
} from '../workout-preview-pool';

function makeClimb(uuid: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: 'p1145r15',
    setter_username: 'tester',
    angle: 40,
    ascensionist_count: 10,
    difficulty: '6a',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
    is_no_match: false,
  } as Climb;
}

function slot(grade: number, index: number): PlannedClimbSlot {
  return { grade, section: 'main', index };
}

const ctx: PreviewFetchContext = {
  board: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as UserBoard,
  isAuthenticated: false,
};

function buildState(poolByGrade: Record<number, string[]>, slotSpecs: [number, number][]): WorkoutPreviewData {
  const pools = new Map<number, Climb[]>(
    Object.entries(poolByGrade).map(([grade, uuids]) => [Number(grade), uuids.map(makeClimb)]),
  );
  const slots = slotSpecs.map(([grade, index]) => slot(grade, index));
  const { items, usedUuids } = selectItemsFromPools(slots, pools);
  return { items, pools, usedUuids };
}

describe('pickUnused', () => {
  it('returns the first climb not in the used set', () => {
    const pool = [makeClimb('a'), makeClimb('b'), makeClimb('c')];
    expect(pickUnused(pool, new Set(['a']))?.uuid).toBe('b');
    expect(pickUnused(pool, new Set(['a', 'b', 'c']))).toBeNull();
  });
});

describe('pickRandomUnused', () => {
  it('returns a climb not in the used set', () => {
    const pool = [makeClimb('a'), makeClimb('b'), makeClimb('c')];
    const picked = pickRandomUnused(pool, new Set(['a']));
    expect(picked).not.toBeNull();
    expect(['b', 'c']).toContain(picked?.uuid);
  });

  it('returns null when every climb is used', () => {
    const pool = [makeClimb('a'), makeClimb('b')];
    expect(pickRandomUnused(pool, new Set(['a', 'b']))).toBeNull();
  });

  it('can pick a non-first unused climb (not just the first like pickUnused)', () => {
    const pool = [makeClimb('a'), makeClimb('b'), makeClimb('c'), makeClimb('d')];
    // Unused candidates are [b, c, d]; index 2 → 'd'. A value of 0.9 lands there.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    try {
      expect(pickRandomUnused(pool, new Set(['a']))?.uuid).toBe('d');
    } finally {
      randomSpy.mockRestore();
    }
  });
});

describe('selectItemsFromPools', () => {
  it('picks a distinct climb per slot when the pool is large enough', () => {
    const pools = new Map([[10, [makeClimb('a'), makeClimb('b'), makeClimb('c')]]]);
    const { items, usedUuids } = selectItemsFromPools([slot(10, 0), slot(10, 1), slot(10, 2)], pools);
    expect(items.map((preview) => preview.item.climb.uuid)).toEqual(['a', 'b', 'c']);
    expect(usedUuids).toEqual(new Set(['a', 'b', 'c']));
  });

  it('skips slots when the pool is shorter than the slot count', () => {
    const pools = new Map([[10, [makeClimb('a')]]]);
    const { items } = selectItemsFromPools([slot(10, 0), slot(10, 1)], pools);
    expect(items.map((preview) => preview.item.climb.uuid)).toEqual(['a']);
  });

  it('skips a slot whose grade pool is empty', () => {
    const pools = new Map([[10, []]]);
    const { items } = selectItemsFromPools([slot(10, 0), slot(10, 1)], pools);
    expect(items).toEqual([]);
  });
});

describe('buildPools', () => {
  it('fetches one shuffled pool per unique grade', async () => {
    const fetchPool = vi.fn(async (grade: number) => [makeClimb(`${grade}-x`), makeClimb(`${grade}-y`)]);
    const pools = await buildPools([slot(10, 0), slot(10, 1), slot(12, 2)], ctx, fetchPool);
    expect(fetchPool).toHaveBeenCalledTimes(2); // grades 10 and 12, deduped
    expect(pools.get(10)).toHaveLength(2);
    expect(pools.get(12)).toHaveLength(2);
  });
});

describe('refreshSlotInState', () => {
  it('keeps the queue-item uuid and swaps to a different climb from the cache', async () => {
    const state = buildState({ 10: ['a', 'b'] }, [[10, 0]]); // one slot → climb 'a'
    const targetUuid = state.items[0].item.uuid;
    const fetchPool = vi.fn();

    const { state: next, changed } = await refreshSlotInState(state, targetUuid, ctx, fetchPool);

    expect(changed).toBe(true);
    expect(next.items[0].item.uuid).toBe(targetUuid); // queue-item identity preserved
    expect(next.items[0].item.climb.uuid).toBe('b'); // genuinely different climb
    expect(fetchPool).not.toHaveBeenCalled(); // cache had an unused climb
    expect(next.usedUuids).toEqual(new Set(['b']));
  });

  it('re-rolls across the pool instead of toggling between two climbs', async () => {
    // One slot, five-climb pool → initial pick is 'a'. The old first-unused
    // refresh toggled a↔b forever; a random pick reaches the rest of the pool.
    let state = buildState({ 10: ['a', 'b', 'c', 'd', 'e'] }, [[10, 0]]);
    expect(state.items[0].item.climb.uuid).toBe('a');
    const fetchPool = vi.fn();

    // Refresh 1: unused = [b, c, d, e]; 0.3 * 4 → index 1 → 'c'.
    // Refresh 2: unused = [a, b, d, e]; 0.8 * 4 → index 3 → 'e'.
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.3).mockReturnValueOnce(0.8);
    try {
      const seen = new Set([state.items[0].item.climb.uuid]);
      for (let refresh = 0; refresh < 2; refresh++) {
        const targetUuid = state.items[0].item.uuid;
        const result = await refreshSlotInState(state, targetUuid, ctx, fetchPool);
        expect(result.changed).toBe(true);
        state = result.state;
        seen.add(state.items[0].item.climb.uuid);
      }
      expect(seen).toEqual(new Set(['a', 'c', 'e'])); // three distinct climbs, not an a↔b toggle
      expect(fetchPool).not.toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('refreshes within the slot grade and never crosses into another grade', async () => {
    // Pyramid/ladder workouts put different grades in different slots. Refreshing
    // a grade-18 row must always land on another grade-18 climb, never the
    // grade-17 slot's climbs — the pool is keyed by slot.grade.
    let state = buildState({ 17: ['g17-a', 'g17-b', 'g17-c'], 18: ['g18-a', 'g18-b', 'g18-c'] }, [
      [17, 0],
      [18, 1],
    ]);
    const grade18Uuid = state.items[1].item.uuid; // queue-item uuid is preserved across refreshes
    const fetchPool = vi.fn();

    const seen = new Set<string>([state.items[1].item.climb.uuid]);
    for (let refresh = 0; refresh < 8; refresh++) {
      const result = await refreshSlotInState(state, grade18Uuid, ctx, fetchPool);
      expect(result.changed).toBe(true);
      state = result.state;
      const refreshedUuid = state.items[1].item.climb.uuid;
      expect(refreshedUuid.startsWith('g18-')).toBe(true); // stayed on grade 18
      seen.add(refreshedUuid);
      expect(state.items[0].item.climb.uuid.startsWith('g17-')).toBe(true); // grade-17 row untouched
    }
    expect(seen.size).toBeGreaterThan(1); // re-rolled within grade 18 rather than sticking
    expect([...seen].every((uuid) => uuid.startsWith('g18-'))).toBe(true); // every pick stayed on grade
    expect(fetchPool).not.toHaveBeenCalled(); // cache always had an unused grade-18 climb
  });

  it('never re-picks a climb already shown in another row (cache miss → refetch)', async () => {
    // Two slots at grade 10, pool exactly [a, b] → rows show a and b (both used).
    const state = buildState({ 10: ['a', 'b'] }, [
      [10, 0],
      [10, 1],
    ]);
    const targetUuid = state.items[0].item.uuid; // currently 'a'
    // Refetch returns a fresh climb 'c' not shown anywhere.
    const fetchPool = vi.fn(async () => [makeClimb('a'), makeClimb('b'), makeClimb('c')]);

    const { state: next, changed } = await refreshSlotInState(state, targetUuid, ctx, fetchPool);

    expect(changed).toBe(true);
    expect(fetchPool).toHaveBeenCalledTimes(1);
    expect(next.items[0].item.climb.uuid).toBe('c'); // the only not-elsewhere-shown climb
    expect(next.items[1].item.climb.uuid).toBe('b'); // sibling untouched
  });

  it('allows a differing repeat when every climb at the grade is already shown', async () => {
    // Two slots, two-climb catalog → a and b both used; refetch yields nothing new.
    const state = buildState({ 10: ['a', 'b'] }, [
      [10, 0],
      [10, 1],
    ]);
    const targetUuid = state.items[0].item.uuid; // 'a'
    const fetchPool = vi.fn(async () => [makeClimb('a'), makeClimb('b')]);

    const { state: next, changed } = await refreshSlotInState(state, targetUuid, ctx, fetchPool);

    expect(changed).toBe(true);
    expect(next.items[0].item.climb.uuid).toBe('b'); // differs from the old 'a' (a duplicate of row 1)
  });

  it('no-ops when the grade has only the climb already shown', async () => {
    const state = buildState({ 10: ['a'] }, [[10, 0]]);
    const targetUuid = state.items[0].item.uuid;
    const fetchPool = vi.fn(async () => [makeClimb('a')]);

    const { changed } = await refreshSlotInState(state, targetUuid, ctx, fetchPool);

    expect(changed).toBe(false);
  });

  it('no-ops for a stale uuid that is no longer in the list', async () => {
    const state = buildState({ 10: ['a', 'b'] }, [[10, 0]]);
    const fetchPool = vi.fn();
    const { changed } = await refreshSlotInState(state, 'nonexistent', ctx, fetchPool);
    expect(changed).toBe(false);
    expect(fetchPool).not.toHaveBeenCalled();
  });
});
