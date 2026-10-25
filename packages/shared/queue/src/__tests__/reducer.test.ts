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

  it('inserts at the head on position 0', () => {
    const state = makeState({ queue: [makeClimbQueueItem({ uuid: 'a' }), makeClimbQueueItem({ uuid: 'b' })] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item: makeClimbQueueItem({ uuid: 'inserted' }), position: 0 },
    });
    expect(result.queue.map((queueItem) => queueItem.uuid)).toEqual(['inserted', 'a', 'b']);
  });

  // position === queue.length is the inclusive upper bound in insertQueueItemIdempotent.
  it('appends when position equals the queue length', () => {
    const state = makeState({ queue: [makeClimbQueueItem({ uuid: 'a' }), makeClimbQueueItem({ uuid: 'b' })] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item: makeClimbQueueItem({ uuid: 'inserted' }), position: 2 },
    });
    expect(result.queue.map((queueItem) => queueItem.uuid)).toEqual(['a', 'b', 'inserted']);
  });

  // A client whose queue is behind the server can overshoot; the server clamps the
  // same way (see docs/websocket-implementation.md).
  it('appends without throwing when position overshoots the queue', () => {
    const state = makeState({ queue: [makeClimbQueueItem({ uuid: 'a' })] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item: makeClimbQueueItem({ uuid: 'inserted' }), position: 99 },
    });
    expect(result.queue.map((queueItem) => queueItem.uuid)).toEqual(['a', 'inserted']);
  });

  it('appends on a negative position', () => {
    const state = makeState({ queue: [makeClimbQueueItem({ uuid: 'a' })] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item: makeClimbQueueItem({ uuid: 'inserted' }), position: -1 },
    });
    expect(result.queue.map((queueItem) => queueItem.uuid)).toEqual(['a', 'inserted']);
  });

  it('appends when no position is given (the default add path)', () => {
    const state = makeState({ queue: [makeClimbQueueItem({ uuid: 'a' }), makeClimbQueueItem({ uuid: 'b' })] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item: makeClimbQueueItem({ uuid: 'inserted' }) },
    });
    expect(result.queue.map((queueItem) => queueItem.uuid)).toEqual(['a', 'b', 'inserted']);
  });

  // The self-echo of a positional add must stay a no-op, or a Play next would
  // insert the same item a second time when the server broadcast comes back.
  it('stays idempotent when the echo carries a position', () => {
    const item = makeClimbQueueItem({ uuid: 'item-1' });
    const state = makeState({ queue: [makeClimbQueueItem({ uuid: 'a' }), item] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item, position: 0 },
    });
    expect(result).toBe(state);
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
  it('preserves a historical flip across optimistic navigation and its echo', () => {
    const first = makeClimbQueueItem({ uuid: 'first' });
    const next = makeClimbQueueItem({ uuid: 'next' });
    let state = makeState({ queue: [first, next], currentClimbQueueItem: first });
    state = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item: next, correlationId: 'nav-next' },
    });
    state = queueReducer(state, {
      type: 'DELTA_MIRROR_CURRENT_CLIMB',
      payload: { mirroredUuid: first.uuid, mirrored: true },
    });
    expect(state.currentClimbQueueItem?.uuid).toBe(next.uuid);
    expect(state.currentClimbQueueItem?.climb.mirrored).not.toBe(true);
    state = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item: next, isServerEvent: true, serverCorrelationId: 'nav-next' },
    });
    expect(state.queue[0].climb.mirrored).toBe(true);
    state = queueReducer(state, { type: 'SET_CURRENT_CLIMB_QUEUE_ITEM', payload: state.queue[0] });
    expect(state.currentClimbQueueItem?.climb.mirrored).toBe(true);
  });

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

describe('REFRESH_AUTHORED_CLIMB', () => {
  // The setter saved a climb again from the editor. DELTA_UPDATE_CURRENT_CLIMB
  // deliberately leaves an already-current item alone, and never rewrites a slot
  // already in the queue — so this is what corrects the stale copies.
  const publishedPatch = {
    name: 'Renamed',
    frames: 'p1r12p2r14',
    is_draft: false,
    published_at: '2026-10-03T10:00:00.000Z',
  };

  it('refreshes the current item and its queue slot', () => {
    const draft = makeClimbQueueItem({
      uuid: 'climb-a',
      climb: { uuid: 'climb-a', name: 'First go', frames: 'p1r12', is_draft: true, published_at: null },
    });
    const state = makeState({ queue: [draft], currentClimbQueueItem: draft });

    const result = queueReducer(state, {
      type: 'REFRESH_AUTHORED_CLIMB',
      payload: { climbUuid: 'climb-a', patch: publishedPatch },
    });

    expect(result.currentClimbQueueItem?.climb).toMatchObject(publishedPatch);
    expect(result.queue[0].climb).toMatchObject(publishedPatch);
  });

  it('drops the holds version when the holds change, and keeps it on a rename', () => {
    const queued = makeClimbQueueItem({
      uuid: 'climb-a',
      climb: { uuid: 'climb-a', name: 'First go', frames: 'p1r12', holdsRevisionNumber: 2 },
    });
    const state = makeState({ queue: [queued], currentClimbQueueItem: queued });

    const renamed = queueReducer(state, {
      type: 'REFRESH_AUTHORED_CLIMB',
      payload: { climbUuid: 'climb-a', patch: { name: 'Renamed', frames: 'p1r12' } },
    });
    expect(renamed.queue[0].climb).toMatchObject({ holdsRevisionNumber: 2 });

    const moved = queueReducer(state, {
      type: 'REFRESH_AUTHORED_CLIMB',
      payload: { climbUuid: 'climb-a', patch: publishedPatch },
    });
    expect(moved.queue[0].climb).toMatchObject({ holdsRevisionNumber: null });
    expect(moved.currentClimbQueueItem?.climb.holdsRevisionNumber).toBeNull();
  });

  it('refreshes a queued copy that is not the current climb, and leaves the current one alone', () => {
    const other = makeClimbQueueItem({ uuid: 'other' });
    const draft = makeClimbQueueItem({ uuid: 'climb-a', climb: { uuid: 'climb-a', is_draft: true } });
    const state = makeState({ queue: [other, draft], currentClimbQueueItem: other });

    const result = queueReducer(state, {
      type: 'REFRESH_AUTHORED_CLIMB',
      payload: { climbUuid: 'climb-a', patch: publishedPatch },
    });

    expect(result.queue[1].climb.is_draft).toBe(false);
    expect(result.queue[0]).toBe(other);
    expect(result.currentClimbQueueItem).toBe(other);
  });

  it('matches on the climb, so a climb queued twice is corrected in both slots', () => {
    const first = makeClimbQueueItem({ uuid: 'slot-1', climb: { uuid: 'climb-a', is_draft: true } });
    const second = makeClimbQueueItem({ uuid: 'slot-2', climb: { uuid: 'climb-a', is_draft: true } });
    const state = makeState({ queue: [first, second], currentClimbQueueItem: second });

    const result = queueReducer(state, {
      type: 'REFRESH_AUTHORED_CLIMB',
      payload: { climbUuid: 'climb-a', patch: publishedPatch },
    });

    expect(result.queue.map((item) => item.climb.is_draft)).toEqual([false, false]);
    expect(result.currentClimbQueueItem?.climb.is_draft).toBe(false);
    // Slot identity and order are what the session state hash covers.
    expect(result.queue.map((item) => item.uuid)).toEqual(['slot-1', 'slot-2']);
  });

  it('keeps what the editor does not author: grade, sends, mirroring, attribution', () => {
    const queued = makeClimbQueueItem({
      uuid: 'climb-a',
      addedBy: 'user-7',
      climb: {
        uuid: 'climb-a',
        difficulty: '6c/V5',
        ascensionist_count: 12,
        quality_average: '3.5',
        mirrored: true,
        angle: 40,
        is_draft: true,
      },
    });
    const state = makeState({ queue: [queued], currentClimbQueueItem: queued });

    const result = queueReducer(state, {
      type: 'REFRESH_AUTHORED_CLIMB',
      payload: { climbUuid: 'climb-a', patch: publishedPatch },
    });

    expect(result.currentClimbQueueItem).toMatchObject({ uuid: 'climb-a', addedBy: 'user-7' });
    expect(result.currentClimbQueueItem?.climb).toMatchObject({
      difficulty: '6c/V5',
      ascensionist_count: 12,
      quality_average: '3.5',
      mirrored: true,
      angle: 40,
    });
  });

  it('does not touch the echo-suppression list or the playlist source', () => {
    const draft = makeClimbQueueItem({ uuid: 'climb-a', climb: { uuid: 'climb-a', is_draft: true } });
    const state = makeState({
      queue: [draft],
      currentClimbQueueItem: draft,
      pendingCurrentClimbUpdates: ['corr-1'],
    });

    const result = queueReducer(state, {
      type: 'REFRESH_AUTHORED_CLIMB',
      payload: { climbUuid: 'climb-a', patch: publishedPatch },
    });

    expect(result.pendingCurrentClimbUpdates).toBe(state.pendingCurrentClimbUpdates);
    expect(result.playlistSuggestionSource).toBe(state.playlistSuggestionSource);
  });

  it('returns the same state when the climb is not queued', () => {
    const other = makeClimbQueueItem({ uuid: 'other' });
    const state = makeState({ queue: [other], currentClimbQueueItem: other });

    const result = queueReducer(state, {
      type: 'REFRESH_AUTHORED_CLIMB',
      payload: { climbUuid: 'climb-a', patch: publishedPatch },
    });

    expect(result).toBe(state);
  });

  it('returns the same state when the queued copy already matches', () => {
    const published = makeClimbQueueItem({ uuid: 'climb-a', climb: { uuid: 'climb-a', ...publishedPatch } });
    const state = makeState({ queue: [published], currentClimbQueueItem: published });

    const result = queueReducer(state, {
      type: 'REFRESH_AUTHORED_CLIMB',
      payload: { climbUuid: 'climb-a', patch: publishedPatch },
    });

    expect(result).toBe(state);
  });

  it('leaves the same-uuid short-circuit of DELTA_UPDATE_CURRENT_CLIMB as it was', () => {
    // The save path still sends this first. It must keep ignoring the payload and
    // keep seeding the correlationId that suppresses the server echo.
    const draft = makeClimbQueueItem({ uuid: 'climb-a', climb: { uuid: 'climb-a', is_draft: true } });
    const resaved = makeClimbQueueItem({ uuid: 'climb-a', climb: { uuid: 'climb-a', is_draft: false } });
    const state = makeState({ queue: [draft], currentClimbQueueItem: draft });

    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item: resaved, shouldAddToQueue: true, isServerEvent: false, correlationId: 'corr-9' },
    });

    expect(result.currentClimbQueueItem).toBe(draft);
    expect(result.queue[0]).toBe(draft);
    expect(result.pendingCurrentClimbUpdates).toEqual(['corr-9']);
  });
});

// A move of the shared wall that the session has not confirmed yet, and what a
// server snapshot does to it (found in QA of #6783: a reconnect's FullSync, read
// before the move landed, put the wall back). Paired: a snapshot that predates
// the move keeps it; a snapshot that shows anyone else's move, or that comes
// after events this client never saw, wins.
describe('unconfirmed moves', () => {
  const wall = makeClimbQueueItem({ uuid: 'wall' });
  const next = makeClimbQueueItem({ uuid: 'next' });
  const later = makeClimbQueueItem({ uuid: 'later' });
  const crewPick = makeClimbQueueItem({ uuid: 'crew-pick' });
  // The last sequence this client applied before any of the moves below.
  const SEEN = 5;

  function moveTo(
    state: QueueState,
    item: ClimbQueueItem,
    correlationId: string,
    extra: { sessionId?: string; shouldAddToQueue?: boolean } = { sessionId: 'session-1' },
  ): QueueState {
    return queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: {
        item,
        shouldAddToQueue: extra.shouldAddToQueue ?? false,
        insertAfterCurrent: true,
        isServerEvent: false,
        correlationId,
        sessionId: extra.sessionId,
      },
    });
  }

  function snapshot(
    state: QueueState,
    queue: ClimbQueueItem[],
    current: ClimbQueueItem | null,
    options: { sequence?: number; sessionId?: string | null; live?: boolean } = {},
  ): QueueState {
    // sessionId null: a local INITIAL_QUEUE_DATA that names no session (leaving one, say).
    const sessionId = options.sessionId === undefined ? 'session-1' : (options.sessionId ?? undefined);
    return queueReducer(state, {
      type: 'INITIAL_QUEUE_DATA',
      serverSequence: options.sequence ?? SEEN,
      payload: { queue, currentClimbQueueItem: current, sessionId, live: options.live ?? true },
    });
  }

  function serverMove(
    state: QueueState,
    item: ClimbQueueItem,
    sequence: number,
    serverCorrelationId?: string,
  ): QueueState {
    return queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      serverSequence: sequence,
      payload: { item, shouldAddToQueue: true, insertAfterCurrent: true, isServerEvent: true, serverCorrelationId },
    });
  }

  const onWall = () =>
    makeState({
      queue: [wall, next],
      currentClimbQueueItem: wall,
      serverSequence: SEEN,
      serverSequenceSessionId: 'session-1',
    });

  it('records a move that is sent to a session, with the climb it moved off', () => {
    const moved = moveTo(onWall(), next, 'corr-1');
    expect(moved.unconfirmedMove).toEqual({
      sessionId: 'session-1',
      correlationId: 'corr-1',
      itemUuid: 'next',
      shouldAddToQueue: false,
      insertAfterCurrent: true,
      movedOff: ['wall'],
      movedOffTruncated: false,
      resend: 'none',
    });
  });

  it('does not record a move that is not sent (solo, or an unresolved climb)', () => {
    const moved = moveTo(onWall(), next, 'corr-1', {});
    expect(moved.currentClimbQueueItem?.uuid).toBe('next');
    expect(moved.unconfirmedMove).toBeNull();
  });

  it('keeps the move and its pending id through a snapshot that predates it', () => {
    const moved = moveTo(onWall(), next, 'corr-1');
    const synced = snapshot(moved, [wall, next], wall);
    expect(synced.currentClimbQueueItem?.uuid).toBe('next');
    expect(synced.pendingCurrentClimbUpdates).toEqual(['corr-1']);
    expect(synced.unconfirmedMove?.correlationId).toBe('corr-1');
    // ...so the move's own echo is still recognised and swallowed.
    const echoed = serverMove(synced, next, SEEN + 1, 'corr-1');
    expect(echoed.currentClimbQueueItem?.uuid).toBe('next');
    expect(echoed.pendingCurrentClimbUpdates).toEqual([]);
    expect(echoed.unconfirmedMove).toBeNull();
  });

  it('takes the snapshot when it shows a climb nobody here moved off', () => {
    const moved = moveTo(onWall(), next, 'corr-1');
    const synced = snapshot(moved, [wall, next, crewPick], crewPick, { sequence: SEEN + 1 });
    expect(synced.currentClimbQueueItem?.uuid).toBe('crew-pick');
    expect(synced.pendingCurrentClimbUpdates).toEqual([]);
    expect(synced.unconfirmedMove).toBeNull();
  });

  // The review's case: the move ran on the old socket (the session moved to
  // `next`), a crewmate then moved the wall back to `wall`, and this client saw
  // neither. The snapshot shows a climb it moved off, but its sequence is ahead.
  it('takes a snapshot on a climb it moved off when the session has moved on since', () => {
    const moved = moveTo(onWall(), next, 'corr-1');
    const synced = snapshot(moved, [wall, next], wall, { sequence: SEEN + 2 });
    expect(synced.currentClimbQueueItem?.uuid).toBe('wall');
    expect(synced.unconfirmedMove).toBeNull();
    expect(synced.pendingCurrentClimbUpdates).toEqual([]);
  });

  it('keeps the move across events it saw that left the wall alone', () => {
    const added = makeClimbQueueItem({ uuid: 'added' });
    const moved = queueReducer(moveTo(onWall(), next, 'corr-1'), {
      type: 'DELTA_ADD_QUEUE_ITEM',
      serverSequence: SEEN + 1,
      payload: { item: added },
    });
    expect(moved.unconfirmedMove?.correlationId).toBe('corr-1');
    const synced = snapshot(moved, [wall, next, added], wall, { sequence: SEEN + 1 });
    expect(synced.currentClimbQueueItem?.uuid).toBe('next');
  });

  it('retires the move once a snapshot already shows it', () => {
    const moved = moveTo(onWall(), next, 'corr-1');
    const synced = snapshot(moved, [wall, next], next, { sequence: SEEN + 1 });
    expect(synced.currentClimbQueueItem?.uuid).toBe('next');
    expect(synced.unconfirmedMove).toBeNull();
    expect(synced.pendingCurrentClimbUpdates).toEqual([]);
  });

  // Joined straight from another room: the sequence this client last applied
  // counts in that room, so an equal number here proves nothing.
  it('takes a snapshot whose sequence matches one this client applied in another session', () => {
    const moved = moveTo({ ...onWall(), serverSequenceSessionId: 'session-0' }, next, 'corr-1');
    const synced = snapshot(moved, [wall, next], wall);
    expect(synced.currentClimbQueueItem?.uuid).toBe('wall');
    expect(synced.serverSequenceSessionId).toBe('session-1');
  });

  it('takes a snapshot of another session, or one that names none, whatever it shows', () => {
    const moved = moveTo(onWall(), next, 'corr-1');
    expect(snapshot(moved, [wall, next], wall, { sessionId: 'session-2' }).currentClimbQueueItem?.uuid).toBe('wall');
    expect(snapshot(moved, [wall, next], wall, { sessionId: null }).currentClimbQueueItem?.uuid).toBe('wall');
    expect(snapshot(moved, [wall, next], wall, { sessionId: null }).unconfirmedMove).toBeNull();
  });

  it('puts a climb the move added back right after the snapshot’s current climb', () => {
    const fresh = makeClimbQueueItem({ uuid: 'fresh' });
    const moved = moveTo(onWall(), fresh, 'corr-1', { sessionId: 'session-1', shouldAddToQueue: true });
    expect(moved.queue.map((item) => item.uuid)).toEqual(['wall', 'fresh', 'next']);
    // The snapshot has never heard of it.
    const synced = snapshot(moved, [wall, next], wall);
    expect(synced.queue.map((item) => item.uuid)).toEqual(['wall', 'fresh', 'next']);
    expect(synced.currentClimbQueueItem).toBe(moved.currentClimbQueueItem);
  });

  it('treats any climb along a chain of unconfirmed moves as predating the latest one', () => {
    const state = makeState({
      queue: [wall, next, later],
      currentClimbQueueItem: wall,
      serverSequence: SEEN,
      serverSequenceSessionId: 'session-1',
    });
    const chained = moveTo(moveTo(state, next, 'corr-1'), later, 'corr-2');
    expect(chained.unconfirmedMove?.movedOff).toEqual(['wall', 'next']);
    expect(snapshot(chained, [wall, next, later], wall).currentClimbQueueItem?.uuid).toBe('later');
    // The first move's echo came: the session is on `next` now, at a sequence this client saw.
    const firstEcho = serverMove(chained, next, SEEN + 1, 'corr-1');
    expect(firstEcho.currentClimbQueueItem?.uuid).toBe('later');
    expect(firstEcho.unconfirmedMove?.correlationId).toBe('corr-2');
    expect(snapshot(firstEcho, [wall, next, later], next, { sequence: SEEN + 1 }).currentClimbQueueItem?.uuid).toBe(
      'later',
    );
    // A later snapshot back on `wall` can only be a crewmate's move.
    expect(snapshot(firstEcho, [wall, next, later], wall, { sequence: SEEN + 2 }).currentClimbQueueItem?.uuid).toBe(
      'wall',
    );
    expect(serverMove(firstEcho, later, SEEN + 2, 'corr-2').unconfirmedMove).toBeNull();
  });

  // `movedOff` keeps the last 20 climbs. Past that the record cannot prove the
  // session still holds one of them, so it protects nothing, as before it existed.
  it('lets every snapshot win once a chain outgrows the climbs it keeps', () => {
    const climbs = Array.from({ length: 22 }, (_, index) => makeClimbQueueItem({ uuid: `climb-${index}` }));
    const start = makeState({
      queue: climbs,
      currentClimbQueueItem: climbs[0],
      serverSequence: SEEN,
      serverSequenceSessionId: 'session-1',
    });
    // Twenty moves: climb-0 to climb-19 moved off, every one kept.
    const atCap = climbs.slice(1, 21).reduce((state, climb, index) => moveTo(state, climb, `corr-${index + 1}`), start);
    expect(atCap.unconfirmedMove).toMatchObject({ itemUuid: 'climb-20', movedOffTruncated: false });
    expect(atCap.unconfirmedMove?.movedOff).toHaveLength(20);
    expect(snapshot(atCap, climbs, climbs[0]).currentClimbQueueItem?.uuid).toBe('climb-20');

    // One more, and climb-0 falls off the list.
    const pastCap = moveTo(atCap, climbs[21], 'corr-21');
    expect(pastCap.unconfirmedMove).toMatchObject({ itemUuid: 'climb-21', movedOffTruncated: true });
    expect(pastCap.unconfirmedMove?.movedOff).toHaveLength(20);
    expect(pastCap.unconfirmedMove?.movedOff).not.toContain('climb-0');
    // The session still on the chain's first climb: the snapshot wins and retires it.
    const synced = snapshot(pastCap, climbs, climbs[0]);
    expect(synced.currentClimbQueueItem?.uuid).toBe('climb-0');
    expect(synced.unconfirmedMove).toBeNull();
    // A climb the list still holds proves nothing either.
    expect(snapshot(pastCap, climbs, climbs[10]).currentClimbQueueItem?.uuid).toBe('climb-10');

    // It stays that way down the chain; a chain after a confirmed move starts clean.
    expect(moveTo(pastCap, climbs[0], 'corr-22').unconfirmedMove?.movedOffTruncated).toBe(true);
    const confirmed = serverMove(pastCap, climbs[21], SEEN + 1, 'corr-21');
    expect(confirmed.unconfirmedMove).toBeNull();
    expect(moveTo(confirmed, climbs[1], 'corr-23').unconfirmedMove).toMatchObject({
      movedOff: ['climb-21'],
      movedOffTruncated: false,
    });
  });

  it('retires the move when a peer moves the wall, even back to the climb it moved off', () => {
    const moved = moveTo(onWall(), next, 'corr-1');
    const peerMoved = serverMove(moved, wall, SEEN + 1);
    expect(peerMoved.currentClimbQueueItem?.uuid).toBe('wall');
    expect(peerMoved.unconfirmedMove).toBeNull();
    expect(snapshot(peerMoved, [wall, next], wall, { sequence: SEEN + 1 }).currentClimbQueueItem?.uuid).toBe('wall');
  });

  it('retires the move when the climb leaves the wall locally', () => {
    const moved = moveTo(onWall(), next, 'corr-1');
    expect(moveTo(moved, later, 'corr-local', {}).unconfirmedMove).toBeNull();
    expect(
      queueReducer(moved, { type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: 'next' } }).unconfirmedMove,
    ).toBeNull();
    expect(queueReducer(moved, { type: 'CLEAR_QUEUE' }).unconfirmedMove).toBeNull();
  });

  // A local replacement (the climber's own queue replace, a rolled-back
  // reorder, a privacy scrub) is never a server snapshot. One that moves the
  // wall retires the move like any local move that is not sent; one that keeps
  // the current climb keeps it.
  it('retires the move on a local queue replacement only when it moves the wall', () => {
    const moved = moveTo(onWall(), next, 'corr-1');
    const kept = queueReducer(moved, {
      type: 'UPDATE_QUEUE',
      payload: { queue: [next, wall], currentClimbQueueItem: moved.currentClimbQueueItem },
    });
    expect(kept.unconfirmedMove?.correlationId).toBe('corr-1');
    const replaced = queueReducer(moved, {
      type: 'UPDATE_QUEUE',
      payload: { queue: [later], currentClimbQueueItem: later },
    });
    expect(replaced.currentClimbQueueItem?.uuid).toBe('later');
    expect(replaced.unconfirmedMove).toBeNull();
  });

  // null in movedOff: the wall had no current climb before the move.
  it('reads a snapshot with no current climb as predating a move made from an empty wall', () => {
    const emptyWall = makeState({
      queue: [wall, next],
      currentClimbQueueItem: null,
      serverSequence: SEEN,
      serverSequenceSessionId: 'session-1',
    });
    const moved = moveTo(emptyWall, next, 'corr-1');
    expect(moved.unconfirmedMove?.movedOff).toEqual([null]);
    // Nothing happened since: the session simply has not seen the move.
    const predates = snapshot(moved, [wall, next], null);
    expect(predates.currentClimbQueueItem?.uuid).toBe('next');
    expect(predates.unconfirmedMove?.correlationId).toBe('corr-1');
    // Something happened that this client never saw: the snapshot wins.
    const movedOn = snapshot(moved, [wall, next], null, { sequence: SEEN + 1 });
    expect(movedOn.currentClimbQueueItem).toBeNull();
    expect(movedOn.unconfirmedMove).toBeNull();
    // An empty snapshot proves nothing for a move made from a climb.
    expect(snapshot(moveTo(onWall(), next, 'corr-2'), [wall, next], null).currentClimbQueueItem).toBeNull();
  });

  it('retires the move when its echo times out', () => {
    const moved = moveTo(onWall(), next, 'corr-1');
    expect(
      queueReducer(moved, { type: 'CLEANUP_PENDING_UPDATE', payload: { correlationId: 'other' } }).unconfirmedMove,
    ).not.toBeNull();
    expect(
      queueReducer(moved, { type: 'CLEANUP_PENDING_UPDATE', payload: { correlationId: 'corr-1' } }).unconfirmedMove,
    ).toBeNull();
    expect(
      queueReducer(moved, { type: 'CLEANUP_PENDING_UPDATES_BATCH', payload: { correlationIds: ['corr-1'] } })
        .unconfirmedMove,
    ).toBeNull();
  });

  it('takes a re-assert of the same climb as the move’s newest send', () => {
    const moved = queueReducer(moveTo(onWall(), next, 'corr-1'), {
      type: 'UNCONFIRMED_MOVE_NOT_SENT',
      payload: { correlationId: 'corr-1', serverViewIsLive: false },
    });
    const reasserted = moveTo(moved, next, 'corr-2');
    expect(reasserted.unconfirmedMove).toMatchObject({ correlationId: 'corr-2', resend: 'none', movedOff: ['wall'] });
  });

  describe('re-send state', () => {
    const notSent = (state: QueueState, correlationId: string, serverViewIsLive: boolean) =>
      queueReducer(state, { type: 'UNCONFIRMED_MOVE_NOT_SENT', payload: { correlationId, serverViewIsLive } });

    it('waits for a live snapshot that still predates the move', () => {
      const waiting = notSent(moveTo(onWall(), next, 'corr-1'), 'corr-1', false);
      expect(waiting.unconfirmedMove?.resend).toBe('awaiting-snapshot');
      expect(snapshot(waiting, [wall, next], wall).unconfirmedMove?.resend).toBe('ready');
      expect(snapshot(waiting, [wall, next, crewPick], crewPick, { sequence: SEEN + 1 }).unconfirmedMove).toBeNull();
      expect(snapshot(waiting, [wall, next], wall, { sequence: SEEN + 2 }).unconfirmedMove).toBeNull();
    });

    it('keeps the wall but releases nothing on a point read (HTTP resync)', () => {
      const waiting = notSent(moveTo(onWall(), next, 'corr-1'), 'corr-1', false);
      const read = snapshot(waiting, [wall, next], wall, { live: false });
      expect(read.currentClimbQueueItem?.uuid).toBe('next');
      expect(read.unconfirmedMove?.resend).toBe('awaiting-snapshot');
    });

    // An HTTP resync can land while a re-send is due or already out. It follows
    // the rule any snapshot does: the move is kept while nothing happened
    // since, retired when the read shows it or moved on. The provider surfaces
    // a retirement it did not cause (the re-send's echo or its failure).
    it('weighs a point read during a due or sent re-send like any snapshot', () => {
      const ready = notSent(moveTo(onWall(), next, 'corr-1'), 'corr-1', true);
      const resent = queueReducer(ready, { type: 'UNCONFIRMED_MOVE_RESENT', payload: { correlationId: 'corr-1' } });
      for (const [state, resend] of [
        [ready, 'ready'],
        [resent, 'resent'],
      ] as const) {
        const predates = snapshot(state, [wall, next], wall, { live: false });
        expect(predates.currentClimbQueueItem?.uuid).toBe('next');
        expect(predates.unconfirmedMove?.resend).toBe(resend);
        const showsMove = snapshot(state, [wall, next], next, { sequence: SEEN + 1, live: false });
        expect(showsMove.currentClimbQueueItem?.uuid).toBe('next');
        expect(showsMove.unconfirmedMove).toBeNull();
        const movedOn = snapshot(state, [wall, next, crewPick], crewPick, { sequence: SEEN + 2, live: false });
        expect(movedOn.currentClimbQueueItem?.uuid).toBe('crew-pick');
        expect(movedOn.unconfirmedMove).toBeNull();
      }
    });

    it('is ready at once when the server view is already live', () => {
      expect(notSent(moveTo(onWall(), next, 'corr-1'), 'corr-1', true).unconfirmedMove?.resend).toBe('ready');
    });

    it('ignores a lost send that is not the move’s latest, or a second loss', () => {
      const moved = moveTo(onWall(), next, 'corr-1');
      expect(notSent(moved, 'corr-0', true)).toBe(moved);
      const ready = notSent(moved, 'corr-1', true);
      const resent = queueReducer(ready, { type: 'UNCONFIRMED_MOVE_RESENT', payload: { correlationId: 'corr-1' } });
      expect(resent.unconfirmedMove?.resend).toBe('resent');
      expect(notSent(resent, 'corr-1', true)).toBe(resent);
      // A resent move is never made ready again by a snapshot either.
      expect(snapshot(resent, [wall, next], wall).unconfirmedMove?.resend).toBe('resent');
    });

    it('drops the move on request, only when the id matches', () => {
      const moved = moveTo(onWall(), next, 'corr-1');
      expect(queueReducer(moved, { type: 'UNCONFIRMED_MOVE_DROPPED', payload: { correlationId: 'other' } })).toBe(
        moved,
      );
      expect(
        queueReducer(moved, { type: 'UNCONFIRMED_MOVE_DROPPED', payload: { correlationId: 'corr-1' } }).unconfirmedMove,
      ).toBeNull();
      expect(queueReducer(moved, { type: 'UNCONFIRMED_MOVE_DROPPED', payload: {} }).unconfirmedMove).toBeNull();
    });
  });
});
