import { describe, it, expect } from 'vitest';
import { queueReducer, initialState } from '../reducer';
import type { QueueState, ClimbQueueItem } from '../types';

function makeClimbQueueItem(
  overrides: Partial<Omit<ClimbQueueItem, 'climb'>> & { uuid: string; climb?: Partial<ClimbQueueItem['climb']> },
): ClimbQueueItem {
  return {
    uuid: overrides.uuid,
    climb: {
      uuid: overrides.climb?.uuid ?? `climb-${overrides.uuid}`,
      name: overrides.climb?.name ?? 'Test Climb',
      frames: overrides.climb?.frames ?? '',
      mirrored: overrides.climb?.mirrored ?? false,
      ...overrides.climb,
    },
    addedBy: overrides.addedBy ?? null,
    suggested: overrides.suggested ?? false,
  } as ClimbQueueItem;
}

function makeState(overrides: Partial<QueueState> = {}): QueueState {
  return {
    ...initialState({}),
    ...overrides,
  };
}

describe('initialState', () => {
  it('returns correct shape with empty defaults', () => {
    const state = initialState({});
    expect(state.queue).toEqual([]);
    expect(state.currentClimbQueueItem).toBeNull();
    expect(state.climbSearchParams).toEqual({});
    expect(state.playlistSuggestionSource).toBeNull();
    expect(state.hasDoneFirstFetch).toBe(false);
    expect(state.pendingCurrentClimbUpdates).toEqual([]);
    expect(state.needsResync).toBe(false);
  });

  it('preserves provided search params', () => {
    const params = { difficulty: 'hard' };
    const state = initialState(params);
    expect(state.climbSearchParams).toEqual(params);
  });
});

describe('ADD_TO_QUEUE', () => {
  it('adds item to the end of the queue', () => {
    const existingItem = makeClimbQueueItem({ uuid: 'existing' });
    const newItem = makeClimbQueueItem({ uuid: 'new-item' });
    const state = makeState({ queue: [existingItem] });

    const result = queueReducer(state, { type: 'ADD_TO_QUEUE', payload: newItem });
    expect(result.queue).toHaveLength(2);
    expect(result.queue[1].uuid).toBe('new-item');
  });
});

describe('REMOVE_FROM_QUEUE', () => {
  it('replaces the queue with the provided array', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const itemB = makeClimbQueueItem({ uuid: 'b' });
    const state = makeState({ queue: [itemA, itemB] });

    const result = queueReducer(state, { type: 'REMOVE_FROM_QUEUE', payload: [itemA] });
    expect(result.queue).toHaveLength(1);
    expect(result.queue[0].uuid).toBe('a');
  });
});

describe('INITIAL_QUEUE_DATA', () => {
  it('preserves current climb when not provided', () => {
    const current = makeClimbQueueItem({ uuid: 'current' });
    const next = makeClimbQueueItem({ uuid: 'next' });
    const state = makeState({ currentClimbQueueItem: current });

    const result = queueReducer(state, {
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [next] },
    });

    expect(result.currentClimbQueueItem).toBe(current);
  });

  it('clears current climb when explicitly set to null', () => {
    const current = makeClimbQueueItem({ uuid: 'current' });
    const state = makeState({ currentClimbQueueItem: current });

    const result = queueReducer(state, {
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [], currentClimbQueueItem: null },
    });

    expect(result.currentClimbQueueItem).toBeNull();
  });
});

describe('UPDATE_QUEUE', () => {
  it('preserves current climb when not provided', () => {
    const current = makeClimbQueueItem({ uuid: 'current' });
    const next = makeClimbQueueItem({ uuid: 'next' });
    const state = makeState({ currentClimbQueueItem: current });

    const result = queueReducer(state, {
      type: 'UPDATE_QUEUE',
      payload: { queue: [next] },
    });

    expect(result.currentClimbQueueItem).toBe(current);
  });

  it('clears current climb when explicitly set to null', () => {
    const current = makeClimbQueueItem({ uuid: 'current' });
    const state = makeState({ currentClimbQueueItem: current });

    const result = queueReducer(state, {
      type: 'UPDATE_QUEUE',
      payload: { queue: [], currentClimbQueueItem: null },
    });

    expect(result.currentClimbQueueItem).toBeNull();
  });
});

describe('SET_CURRENT_CLIMB', () => {
  it('inserts item after current when current exists in queue', () => {
    const current = makeClimbQueueItem({ uuid: 'current' });
    const trailing = makeClimbQueueItem({ uuid: 'trailing' });
    const newCurrent = makeClimbQueueItem({ uuid: 'new-current' });
    const state = makeState({
      queue: [current, trailing],
      currentClimbQueueItem: current,
    });

    const result = queueReducer(state, { type: 'SET_CURRENT_CLIMB', payload: newCurrent });
    expect(result.currentClimbQueueItem?.uuid).toBe('new-current');
    expect(result.queue.map((item) => item.uuid)).toEqual(['current', 'new-current', 'trailing']);
  });

  it('appends to queue when no current climb exists', () => {
    const newCurrent = makeClimbQueueItem({ uuid: 'new-current' });
    const state = makeState({ queue: [], currentClimbQueueItem: null });

    const result = queueReducer(state, { type: 'SET_CURRENT_CLIMB', payload: newCurrent });
    expect(result.queue).toHaveLength(1);
    expect(result.queue[0].uuid).toBe('new-current');
  });
});

describe('DELTA_ADD_QUEUE_ITEM', () => {
  it('is idempotent - adding same uuid twice does not duplicate', () => {
    const item = makeClimbQueueItem({ uuid: 'item-1' });
    const state = makeState({ queue: [item] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item },
    });
    expect(result.queue).toHaveLength(1);
    expect(result).toBe(state); // referential identity preserved
  });

  it('adds new item to queue', () => {
    const item = makeClimbQueueItem({ uuid: 'new-item' });
    const state = makeState({ queue: [] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item },
    });
    expect(result.queue).toHaveLength(1);
    expect(result.queue[0].uuid).toBe('new-item');
  });

  it('inserts at specified position', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const itemB = makeClimbQueueItem({ uuid: 'b' });
    const newItem = makeClimbQueueItem({ uuid: 'inserted' });
    const state = makeState({ queue: [itemA, itemB] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item: newItem, position: 1 },
    });
    expect(result.queue.map((queueItem) => queueItem.uuid)).toEqual(['a', 'inserted', 'b']);
  });
});

describe('DELTA_REMOVE_QUEUE_ITEM', () => {
  it('clears currentClimbQueueItem if the removed item was current', () => {
    const item = makeClimbQueueItem({ uuid: 'current-item' });
    const state = makeState({
      queue: [item],
      currentClimbQueueItem: item,
    });

    const result = queueReducer(state, {
      type: 'DELTA_REMOVE_QUEUE_ITEM',
      payload: { uuid: 'current-item' },
    });
    expect(result.queue).toHaveLength(0);
    expect(result.currentClimbQueueItem).toBeNull();
  });

  it('preserves currentClimbQueueItem if a different item is removed', () => {
    const current = makeClimbQueueItem({ uuid: 'current' });
    const other = makeClimbQueueItem({ uuid: 'other' });
    const state = makeState({
      queue: [current, other],
      currentClimbQueueItem: current,
    });

    const result = queueReducer(state, {
      type: 'DELTA_REMOVE_QUEUE_ITEM',
      payload: { uuid: 'other' },
    });
    expect(result.queue).toHaveLength(1);
    expect(result.currentClimbQueueItem?.uuid).toBe('current');
  });
});

describe('DELTA_REORDER_QUEUE_ITEM', () => {
  it('reorders with valid indices', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const itemB = makeClimbQueueItem({ uuid: 'b' });
    const itemC = makeClimbQueueItem({ uuid: 'c' });
    const state = makeState({ queue: [itemA, itemB, itemC] });

    const result = queueReducer(state, {
      type: 'DELTA_REORDER_QUEUE_ITEM',
      payload: { uuid: 'a', oldIndex: 0, newIndex: 2 },
    });
    expect(result.queue.map((item) => item.uuid)).toEqual(['b', 'c', 'a']);
  });

  it('returns unchanged state with invalid indices', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const state = makeState({ queue: [itemA] });

    const result = queueReducer(state, {
      type: 'DELTA_REORDER_QUEUE_ITEM',
      payload: { uuid: 'a', oldIndex: 0, newIndex: 5 },
    });
    expect(result).toBe(state);
  });

  it('returns unchanged state when uuid does not match item at oldIndex', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const itemB = makeClimbQueueItem({ uuid: 'b' });
    const state = makeState({ queue: [itemA, itemB] });

    const result = queueReducer(state, {
      type: 'DELTA_REORDER_QUEUE_ITEM',
      payload: { uuid: 'b', oldIndex: 0, newIndex: 1 },
    });
    expect(result).toBe(state);
  });
});

describe('MIRROR_CLIMB', () => {
  it('toggles mirrored on current climb', () => {
    const item = makeClimbQueueItem({ uuid: 'climb-1' });
    item.climb.mirrored = false;
    const state = makeState({ currentClimbQueueItem: item });

    const result = queueReducer(state, { type: 'MIRROR_CLIMB' });
    expect(result.currentClimbQueueItem?.climb.mirrored).toBe(true);
  });

  it('returns unchanged state when no current climb', () => {
    const state = makeState({ currentClimbQueueItem: null });
    const result = queueReducer(state, { type: 'MIRROR_CLIMB' });
    expect(result).toBe(state);
  });
});

describe('DELTA_MIRROR_CURRENT_CLIMB', () => {
  it('applies mirrored state when mirroredUuid matches current climb', () => {
    const item = makeClimbQueueItem({ uuid: 'climb-1' });
    item.climb.mirrored = false;
    const state = makeState({
      currentClimbQueueItem: item,
      queue: [item],
    });

    const result = queueReducer(state, {
      type: 'DELTA_MIRROR_CURRENT_CLIMB',
      payload: { mirrored: true, mirroredUuid: 'climb-1' },
    });
    expect(result.currentClimbQueueItem?.climb.mirrored).toBe(true);
    expect(result.queue[0].climb.mirrored).toBe(true);
  });

  it('returns unchanged state when mirroredUuid is null', () => {
    const item = makeClimbQueueItem({ uuid: 'climb-1' });
    const state = makeState({ currentClimbQueueItem: item });

    const result = queueReducer(state, {
      type: 'DELTA_MIRROR_CURRENT_CLIMB',
      payload: { mirrored: true, mirroredUuid: null },
    });
    expect(result).toBe(state);
  });

  it('returns unchanged state when mirroredUuid does not match current', () => {
    const item = makeClimbQueueItem({ uuid: 'climb-1' });
    const state = makeState({ currentClimbQueueItem: item });

    const result = queueReducer(state, {
      type: 'DELTA_MIRROR_CURRENT_CLIMB',
      payload: { mirrored: true, mirroredUuid: 'different-climb' },
    });
    expect(result).toBe(state);
  });
});

describe('DELTA_UPDATE_CURRENT_CLIMB', () => {
  // Activation from a list: `suggested` (browse-origin) items after the new
  // current are pruned by default, kept when the caller opts out (#4829 — a
  // party client, whose prune would never reach the server).
  const listSource = {
    playlistUuid: 'climblist',
    activatedClimbUuid: 'climb-w1',
    boardKey: 'woods:1:2:1',
    climbs: [{ uuid: 'climb-w1', name: 'W1' }] as unknown as ClimbQueueItem['climb'][],
  };
  const leftoverState = () =>
    makeState({
      queue: [
        makeClimbQueueItem({ uuid: 'k1', suggested: true }),
        makeClimbQueueItem({ uuid: 'k2', suggested: true }),
        makeClimbQueueItem({ uuid: 'd1' }),
      ],
      currentClimbQueueItem: undefined,
    });

  it('prunes suggested items after the new current on a list activation by default', () => {
    const state = leftoverState();
    state.currentClimbQueueItem = state.queue[0];
    const w1 = makeClimbQueueItem({ uuid: 'w1', climb: { uuid: 'climb-w1' }, suggested: true });
    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item: w1, shouldAddToQueue: true, insertAfterCurrent: true, playlistSuggestionSource: listSource },
    });
    // k2 (suggested, after w1) goes; d1 (deliberate add) survives.
    expect(result.queue.map(({ uuid }) => uuid)).toEqual(['k1', 'w1', 'd1']);
  });

  it('keeps suggested items when pruneSuggestedAfterCurrent is false (party client)', () => {
    const state = leftoverState();
    state.currentClimbQueueItem = state.queue[0];
    const w1 = makeClimbQueueItem({ uuid: 'w1', climb: { uuid: 'climb-w1' }, suggested: true });
    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: {
        item: w1,
        shouldAddToQueue: true,
        insertAfterCurrent: true,
        playlistSuggestionSource: listSource,
        pruneSuggestedAfterCurrent: false,
      },
    });
    expect(result.queue.map(({ uuid }) => uuid)).toEqual(['k1', 'w1', 'k2', 'd1']);
    expect(result.playlistSuggestionSource).toBe(listSource);
  });

  it('suppresses echo via correlationId', () => {
    const item = makeClimbQueueItem({ uuid: 'climb-1' });
    const correlationId = 'corr-123';
    const state = makeState({
      currentClimbQueueItem: item,
      pendingCurrentClimbUpdates: [correlationId],
    });

    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: {
        item,
        isServerEvent: true,
        serverCorrelationId: correlationId,
      },
    });
    // Should remove the matching correlationId from pending
    expect(result.pendingCurrentClimbUpdates).not.toContain(correlationId);
    // Should NOT update current climb (echo suppression)
    expect(result.currentClimbQueueItem).toBe(state.currentClimbQueueItem);
  });

  it('adds correlationId to pending for local updates', () => {
    const item = makeClimbQueueItem({ uuid: 'new-climb' });
    const state = makeState({ currentClimbQueueItem: null });

    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: {
        item,
        correlationId: 'local-corr-1',
      },
    });
    expect(result.pendingCurrentClimbUpdates).toContain('local-corr-1');
    expect(result.currentClimbQueueItem?.uuid).toBe('new-climb');
  });

  // #3868: a LOCAL re-dispatch of the ALREADY-current climb (re-asserting it to
  // re-light a peer's wall, or the re-broadcast of a now-hydrated current) hits
  // the same-uuid early return. It must still seed the correlationId so the echo
  // of the mutation being sent for it is suppressed instead of re-applied.
  it('seeds the correlationId when a local re-dispatch targets the already-current climb', () => {
    const item = makeClimbQueueItem({ uuid: 'climb-1' });
    const state = makeState({ currentClimbQueueItem: item, pendingCurrentClimbUpdates: [] });

    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: {
        item,
        correlationId: 'reassert-corr-1',
      },
    });
    // The id is recorded so a later server echo with this correlationId is dropped...
    expect(result.pendingCurrentClimbUpdates).toContain('reassert-corr-1');
    // ...and nothing about the current climb (or queue) churns.
    expect(result.currentClimbQueueItem).toBe(state.currentClimbQueueItem);
    expect(result.queue).toBe(state.queue);
  });

  it('leaves state untouched for a local re-tap of the current climb with no correlationId', () => {
    const item = makeClimbQueueItem({ uuid: 'climb-1' });
    const state = makeState({ currentClimbQueueItem: item });

    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item },
    });
    // No broadcast id ⇒ pure local no-op: same state reference back.
    expect(result).toBe(state);
  });

  // Issue #2217: a peer (or the local light bulb) activating a NEW climb should
  // slot it right after the current climb, pushing the current climb into
  // history — not append it to the end and jump the current pointer there.
  it('inserts a not-yet-queued climb right after the current climb when insertAfterCurrent is set', () => {
    const itemA = makeClimbQueueItem({ uuid: 'item-a' });
    const itemB = makeClimbQueueItem({ uuid: 'item-b' });
    const itemC = makeClimbQueueItem({ uuid: 'item-c' });
    const itemX = makeClimbQueueItem({ uuid: 'item-x' });
    const state = makeState({ queue: [itemA, itemB, itemC], currentClimbQueueItem: itemA });

    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: {
        item: itemX,
        shouldAddToQueue: true,
        insertAfterCurrent: true,
        isServerEvent: true,
      },
    });

    expect(result.queue.map((queueItem) => queueItem.uuid)).toEqual(['item-a', 'item-x', 'item-b', 'item-c']);
    expect(result.currentClimbQueueItem?.uuid).toBe('item-x');
  });

  it('appends a not-yet-queued climb to the end when insertAfterCurrent is NOT set (documents the pre-#2217 behaviour the mapper now avoids)', () => {
    const itemA = makeClimbQueueItem({ uuid: 'item-a' });
    const itemB = makeClimbQueueItem({ uuid: 'item-b' });
    const itemX = makeClimbQueueItem({ uuid: 'item-x' });
    const state = makeState({ queue: [itemA, itemB], currentClimbQueueItem: itemA });

    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: {
        item: itemX,
        shouldAddToQueue: true,
        isServerEvent: true,
      },
    });

    expect(result.queue.map((queueItem) => queueItem.uuid)).toEqual(['item-a', 'item-b', 'item-x']);
  });
});

describe('REGRADE_CLIMBS', () => {
  it('patches matching climbs in the queue and the current item', () => {
    const queued = makeClimbQueueItem({ uuid: 'q1', climb: { uuid: 'climb-a', angle: 40, difficulty: '6a/V3' } });
    const current = makeClimbQueueItem({ uuid: 'c1', climb: { uuid: 'climb-b', angle: 40, difficulty: '6b/V4' } });
    const state = makeState({ queue: [queued], currentClimbQueueItem: current });

    const result = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: {
        grades: {
          'climb-a': {
            angle: 50,
            difficulty: '6c/V5',
            quality_average: '3.5',
            ascensionist_count: 10,
            benchmark_difficulty: null,
          },
          'climb-b': {
            angle: 50,
            difficulty: '7a/V6',
            quality_average: '4.0',
            ascensionist_count: 20,
            benchmark_difficulty: null,
          },
        },
      },
    });

    expect(result.queue[0].climb.difficulty).toBe('6c/V5');
    expect(result.queue[0].climb.angle).toBe(50);
    expect(result.currentClimbQueueItem?.climb.difficulty).toBe('7a/V6');
    expect(result.currentClimbQueueItem?.climb.angle).toBe(50);
  });

  it('keeps reference equality for items without a patch', () => {
    const patched = makeClimbQueueItem({ uuid: 'q1', climb: { uuid: 'climb-a', angle: 40, difficulty: '6a/V3' } });
    const untouched = makeClimbQueueItem({ uuid: 'q2', climb: { uuid: 'climb-z', angle: 40, difficulty: '5+/V1' } });
    const state = makeState({ queue: [patched, untouched] });

    const result = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: {
        grades: {
          'climb-a': {
            angle: 50,
            difficulty: '6c/V5',
            quality_average: '3.5',
            ascensionist_count: 10,
            benchmark_difficulty: null,
          },
        },
      },
    });

    expect(result.queue[1]).toBe(untouched); // same reference — not re-created
    expect(result.queue[0]).not.toBe(patched); // patched item is a fresh object
  });

  it('patches every occurrence of the same climb uuid', () => {
    const first = makeClimbQueueItem({ uuid: 'q1', climb: { uuid: 'dup', angle: 40, difficulty: '6a/V3' } });
    const second = makeClimbQueueItem({ uuid: 'q2', climb: { uuid: 'dup', angle: 40, difficulty: '6a/V3' } });
    const state = makeState({ queue: [first, second] });

    const result = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: {
        grades: {
          dup: {
            angle: 50,
            difficulty: '6c/V5',
            quality_average: '3.5',
            ascensionist_count: 10,
            benchmark_difficulty: null,
          },
        },
      },
    });

    expect(result.queue[0].climb.difficulty).toBe('6c/V5');
    expect(result.queue[1].climb.difficulty).toBe('6c/V5');
  });

  it('returns the same state when no uuid matches', () => {
    const queued = makeClimbQueueItem({ uuid: 'q1', climb: { uuid: 'climb-a', angle: 40, difficulty: '6a/V3' } });
    const state = makeState({ queue: [queued] });

    const result = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: {
        grades: {
          'not-in-queue': {
            angle: 50,
            difficulty: '6c/V5',
            quality_average: '3.5',
            ascensionist_count: 10,
            benchmark_difficulty: null,
          },
        },
      },
    });

    expect(result).toBe(state);
  });

  it('patches boardsesh grade fields onto a matching climb', () => {
    const queued = makeClimbQueueItem({
      uuid: 'q1',
      climb: {
        uuid: 'climb-a',
        angle: 40,
        difficulty: '6a/V3',
        boardseshDifficulty: 20,
        boardseshConfidence: 'confirmed',
      },
    });
    const state = makeState({ queue: [queued] });

    const result = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: {
        grades: {
          'climb-a': {
            angle: 50,
            difficulty: '6c/V5',
            quality_average: '3.5',
            ascensionist_count: 10,
            benchmark_difficulty: null,
            boardseshDifficulty: 25,
            boardseshConfidence: 'provisional',
          },
        },
      },
    });

    expect(result.queue[0].climb.boardseshDifficulty).toBe(25);
    expect(result.queue[0].climb.boardseshConfidence).toBe('provisional');
  });

  it('clears a stale boardsesh grade when the patch carries an explicit null', () => {
    const queued = makeClimbQueueItem({
      uuid: 'q1',
      climb: {
        uuid: 'climb-a',
        angle: 40,
        difficulty: '6a/V3',
        boardseshDifficulty: 20,
        boardseshConfidence: 'confirmed',
      },
    });
    const state = makeState({ queue: [queued] });

    const result = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: {
        grades: {
          'climb-a': {
            angle: 50,
            difficulty: '6c/V5',
            quality_average: '3.5',
            ascensionist_count: 10,
            benchmark_difficulty: null,
            boardseshDifficulty: null,
            boardseshConfidence: null,
          },
        },
      },
    });

    // The angle-appropriate fields still apply even though the grade cleared.
    expect(result.queue[0].climb.difficulty).toBe('6c/V5');
    expect(result.queue[0].climb.boardseshDifficulty).toBeNull();
    expect(result.queue[0].climb.boardseshConfidence).toBeNull();
  });

  it('keeps reference equality for untouched climbs when clearing a boardsesh grade elsewhere', () => {
    const patched = makeClimbQueueItem({
      uuid: 'q1',
      climb: {
        uuid: 'climb-a',
        angle: 40,
        difficulty: '6a/V3',
        boardseshDifficulty: 20,
        boardseshConfidence: 'confirmed',
      },
    });
    const untouched = makeClimbQueueItem({
      uuid: 'q2',
      climb: {
        uuid: 'climb-z',
        angle: 40,
        difficulty: '5+/V1',
        boardseshDifficulty: 15,
        boardseshConfidence: 'confirmed',
      },
    });
    const state = makeState({ queue: [patched, untouched] });

    const result = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: {
        grades: {
          'climb-a': {
            angle: 50,
            difficulty: '6c/V5',
            quality_average: '3.5',
            ascensionist_count: 10,
            benchmark_difficulty: null,
            boardseshDifficulty: null,
            boardseshConfidence: null,
          },
        },
      },
    });

    expect(result.queue[1]).toBe(untouched); // same reference — not re-created
    expect(result.queue[0].climb.boardseshDifficulty).toBeNull();
  });

  it('is idempotent when the climb already carries the target angle', () => {
    const queued = makeClimbQueueItem({ uuid: 'q1', climb: { uuid: 'climb-a', angle: 50, difficulty: '6c/V5' } });
    const state = makeState({ queue: [queued] });

    const result = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: {
        grades: {
          'climb-a': {
            angle: 50,
            difficulty: '6c/V5',
            quality_average: '3.5',
            ascensionist_count: 10,
            benchmark_difficulty: null,
          },
        },
      },
    });

    expect(result).toBe(state);
  });

  it('re-grades the current climb and upcoming items but NOT history', () => {
    // Queue laid out as [history, current, upcoming] with the current item
    // sitting inside the queue (real usage — SET_CURRENT_CLIMB inserts it).
    const history = makeClimbQueueItem({ uuid: 'h1', climb: { uuid: 'climb-h', angle: 40, difficulty: '7a/V6' } });
    const current = makeClimbQueueItem({ uuid: 'c1', climb: { uuid: 'climb-c', angle: 40, difficulty: '6b/V4' } });
    const upcoming = makeClimbQueueItem({ uuid: 'u1', climb: { uuid: 'climb-u', angle: 40, difficulty: '6a/V3' } });
    const state = makeState({ queue: [history, current, upcoming], currentClimbQueueItem: current });

    const gradeAt25 = (difficulty: string) => ({
      angle: 25,
      difficulty,
      quality_average: '3.0',
      ascensionist_count: 5,
      benchmark_difficulty: null,
    });

    const result = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: {
        grades: {
          'climb-h': gradeAt25('5+/V1'),
          'climb-c': gradeAt25('6a/V3'),
          'climb-u': gradeAt25('5c/V2'),
        },
      },
    });

    // History keeps the angle it was CLIMBED at — same reference, untouched.
    expect(result.queue[0]).toBe(history);
    expect(result.queue[0].climb.angle).toBe(40);
    expect(result.queue[0].climb.difficulty).toBe('7a/V6');

    // Current + upcoming follow the live angle.
    expect(result.queue[1].climb.angle).toBe(25);
    expect(result.queue[1].climb.difficulty).toBe('6a/V3');
    expect(result.currentClimbQueueItem?.climb.angle).toBe(25);
    expect(result.queue[2].climb.angle).toBe(25);
    expect(result.queue[2].climb.difficulty).toBe('5c/V2');
  });

  it('does not re-grade a history occurrence that shares a climb uuid with an upcoming item', () => {
    // The SAME climb sits in history (climbed at 40°) and upcoming (re-added).
    // The grade is keyed by climb.uuid, but only the upcoming occurrence must
    // follow the new angle; the history occurrence pins its climbed-at angle.
    const historyDup = makeClimbQueueItem({ uuid: 'h1', climb: { uuid: 'dup', angle: 40, difficulty: '7a/V6' } });
    const current = makeClimbQueueItem({ uuid: 'c1', climb: { uuid: 'climb-c', angle: 40, difficulty: '6b/V4' } });
    const upcomingDup = makeClimbQueueItem({ uuid: 'u1', climb: { uuid: 'dup', angle: 40, difficulty: '7a/V6' } });
    const state = makeState({ queue: [historyDup, current, upcomingDup], currentClimbQueueItem: current });

    const result = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: {
        grades: {
          dup: {
            angle: 25,
            difficulty: '5+/V1',
            quality_average: '3.0',
            ascensionist_count: 5,
            benchmark_difficulty: null,
          },
        },
      },
    });

    // History occurrence: pinned (same reference, original grade).
    expect(result.queue[0]).toBe(historyDup);
    expect(result.queue[0].climb.difficulty).toBe('7a/V6');
    expect(result.queue[0].climb.angle).toBe(40);
    // Upcoming occurrence: re-graded to the live angle.
    expect(result.queue[2].climb.difficulty).toBe('5+/V1');
    expect(result.queue[2].climb.angle).toBe(25);
  });

  it('re-grades the whole queue when there is no current item', () => {
    // No current climb → the entire queue is "upcoming" (buildQueueListModel),
    // so every item follows the live angle.
    const first = makeClimbQueueItem({ uuid: 'q1', climb: { uuid: 'climb-a', angle: 40, difficulty: '6a/V3' } });
    const second = makeClimbQueueItem({ uuid: 'q2', climb: { uuid: 'climb-b', angle: 40, difficulty: '6b/V4' } });
    const state = makeState({ queue: [first, second], currentClimbQueueItem: null });

    const result = queueReducer(state, {
      type: 'REGRADE_CLIMBS',
      payload: {
        grades: {
          'climb-a': {
            angle: 25,
            difficulty: '5+/V1',
            quality_average: '3.0',
            ascensionist_count: 5,
            benchmark_difficulty: null,
          },
          'climb-b': {
            angle: 25,
            difficulty: '5c/V2',
            quality_average: '3.0',
            ascensionist_count: 5,
            benchmark_difficulty: null,
          },
        },
      },
    });

    expect(result.queue[0].climb.angle).toBe(25);
    expect(result.queue[1].climb.angle).toBe(25);
  });
});
