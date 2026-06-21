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
    expect(state.initialQueueDataReceivedFromPeers).toBe(false);
    expect(state.pendingCurrentClimbUpdates).toEqual([]);
    expect(state.lastReceivedSequence).toBeNull();
    expect(state.lastReceivedStateHash).toBeNull();
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
});
