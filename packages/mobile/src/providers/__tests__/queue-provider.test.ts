import { describe, it, expect } from 'vitest';
import { queueReducer, initialState } from '@boardsesh/queue';
import type { QueueState, ClimbQueueItem } from '@boardsesh/queue';
import { toClimbQueueItem, type SubscriptionQueueItem } from '../../lib/queue-conversion';
import { findNextQueueItem, findPreviousQueueItem } from '@boardsesh/play-view';

// ── Factory helpers ─────────────────────────────────────────────────────

function makeClimbQueueItem(overrides: { uuid: string } & Partial<ClimbQueueItem>): ClimbQueueItem {
  return {
    uuid: overrides.uuid,
    climb: {
      uuid: overrides.climb?.uuid ?? `climb-${overrides.uuid}`,
      name: overrides.climb?.name ?? 'Test Climb',
      frames: overrides.climb?.frames ?? '',
      setter_username: overrides.climb?.setter_username ?? 'test-setter',
      angle: overrides.climb?.angle ?? 40,
      ascensionist_count: overrides.climb?.ascensionist_count ?? 10,
      difficulty: overrides.climb?.difficulty ?? 'V4',
      quality_average: overrides.climb?.quality_average ?? '3.5',
      stars: overrides.climb?.stars ?? 3,
      difficulty_error: overrides.climb?.difficulty_error ?? '0.5',
      benchmark_difficulty: overrides.climb?.benchmark_difficulty ?? null,
      ...overrides.climb,
    },
    addedBy: overrides.addedBy ?? null,
    suggested: overrides.suggested ?? false,
  };
}

function makeState(overrides: Partial<QueueState> = {}): QueueState {
  return {
    ...initialState({}),
    ...overrides,
  };
}

function makeSubscriptionItem(uuid: string, climbUuid: string, name: string): SubscriptionQueueItem {
  return {
    uuid,
    climb: {
      uuid: climbUuid,
      name,
      frames: 'p1r12',
      setter_username: 'setter',
      angle: 40,
      ascensionist_count: 5,
      difficulty: '21',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.5',
      benchmark_difficulty: null,
    },
  };
}

// ── toClimbQueueItem ────────────────────────────────────────────────────

describe('toClimbQueueItem', () => {
  it('maps subscription item uuid and climb fields', () => {
    const subscriptionItem = makeSubscriptionItem('qi-1', 'climb-abc', 'Cool Route');

    const result = toClimbQueueItem(subscriptionItem);

    expect(result.uuid).toBe('qi-1');
    expect(result.climb.uuid).toBe('climb-abc');
    expect(result.climb.name).toBe('Cool Route');
    expect(result.climb.frames).toBe('p1r12');
  });

  it('carries through grade and metadata fields from the subscription payload', () => {
    const subscriptionItem = makeSubscriptionItem('qi-2', 'climb-xyz', 'Hard Problem');

    const result = toClimbQueueItem(subscriptionItem);

    expect(result.climb.setter_username).toBe('setter');
    expect(result.climb.angle).toBe(40);
    expect(result.climb.ascensionist_count).toBe(5);
    expect(result.climb.difficulty).toBe('21');
    expect(result.climb.quality_average).toBe('3.0');
    expect(result.climb.stars).toBe(3);
    expect(result.climb.difficulty_error).toBe('0.5');
    expect(result.climb.benchmark_difficulty).toBeNull();
  });

  it('produces a valid ClimbQueueItem shape without extra properties', () => {
    const subscriptionItem = makeSubscriptionItem('qi-3', 'climb-123', 'Slab King');

    const result = toClimbQueueItem(subscriptionItem);

    // Should have exactly uuid and climb at the top level
    expect(Object.keys(result)).toEqual(['uuid', 'climb']);
  });
});

// ── INITIAL_QUEUE_DATA ──────────────────────────────────────────────────

describe('INITIAL_QUEUE_DATA', () => {
  it('sets queue and currentClimbQueueItem from payload', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const itemB = makeClimbQueueItem({ uuid: 'b' });
    const state = makeState();

    const result = queueReducer(state, {
      type: 'INITIAL_QUEUE_DATA',
      payload: {
        queue: [itemA, itemB],
        currentClimbQueueItem: itemA,
      },
    });

    expect(result.queue).toHaveLength(2);
    expect(result.queue[0].uuid).toBe('a');
    expect(result.queue[1].uuid).toBe('b');
    expect(result.currentClimbQueueItem?.uuid).toBe('a');
  });

  it('marks initialQueueDataReceivedFromPeers as true', () => {
    const state = makeState({ initialQueueDataReceivedFromPeers: false });

    const result = queueReducer(state, {
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [], currentClimbQueueItem: null },
    });

    expect(result.initialQueueDataReceivedFromPeers).toBe(true);
  });

  it('clears pending updates on full sync', () => {
    const state = makeState({ pendingCurrentClimbUpdates: ['corr-1', 'corr-2'] });

    const result = queueReducer(state, {
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [], currentClimbQueueItem: null },
    });

    expect(result.pendingCurrentClimbUpdates).toEqual([]);
  });

  it('preserves existing currentClimbQueueItem when payload does not provide one', () => {
    const existingCurrent = makeClimbQueueItem({ uuid: 'existing' });
    const state = makeState({ currentClimbQueueItem: existingCurrent });

    const result = queueReducer(state, {
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [] },
    });

    expect(result.currentClimbQueueItem?.uuid).toBe('existing');
  });

  it('filters out corrupted (null) items and requests resync', () => {
    const validItem = makeClimbQueueItem({ uuid: 'valid' });
    const state = makeState();

    const result = queueReducer(state, {
      type: 'INITIAL_QUEUE_DATA',
      payload: {
        // Simulate corrupted data with null entries
        queue: [validItem, null as unknown as ClimbQueueItem],
        currentClimbQueueItem: null,
      },
    });

    expect(result.queue).toHaveLength(1);
    expect(result.queue[0].uuid).toBe('valid');
    expect(result.needsResync).toBe(true);
  });
});

// ── DELTA_ADD_QUEUE_ITEM ────────────────────────────────────────────────

describe('DELTA_ADD_QUEUE_ITEM', () => {
  it('adds a new item to the queue', () => {
    const newItem = makeClimbQueueItem({ uuid: 'new-item' });
    const state = makeState({ queue: [] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item: newItem },
    });

    expect(result.queue).toHaveLength(1);
    expect(result.queue[0].uuid).toBe('new-item');
  });

  it('is idempotent on duplicate uuid', () => {
    const item = makeClimbQueueItem({ uuid: 'item-1' });
    const state = makeState({ queue: [item] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item },
    });

    expect(result.queue).toHaveLength(1);
    // Referential identity preserved when no change
    expect(result).toBe(state);
  });

  it('appends to existing queue', () => {
    const existingItem = makeClimbQueueItem({ uuid: 'existing' });
    const newItem = makeClimbQueueItem({ uuid: 'new' });
    const state = makeState({ queue: [existingItem] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item: newItem },
    });

    expect(result.queue).toHaveLength(2);
    expect(result.queue[0].uuid).toBe('existing');
    expect(result.queue[1].uuid).toBe('new');
  });

  it('inserts at a specific position when provided', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const itemB = makeClimbQueueItem({ uuid: 'b' });
    const inserted = makeClimbQueueItem({ uuid: 'inserted' });
    const state = makeState({ queue: [itemA, itemB] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item: inserted, position: 1 },
    });

    expect(result.queue.map((queueItem) => queueItem.uuid)).toEqual(['a', 'inserted', 'b']);
  });

  it('skips items with null climb', () => {
    const badItem = { uuid: 'bad', climb: null } as unknown as ClimbQueueItem;
    const state = makeState({ queue: [] });

    const result = queueReducer(state, {
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item: badItem },
    });

    expect(result.queue).toHaveLength(0);
    expect(result).toBe(state);
  });
});

// ── DELTA_REMOVE_QUEUE_ITEM ─────────────────────────────────────────────

describe('DELTA_REMOVE_QUEUE_ITEM', () => {
  it('removes an item by uuid', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const itemB = makeClimbQueueItem({ uuid: 'b' });
    const state = makeState({ queue: [itemA, itemB] });

    const result = queueReducer(state, {
      type: 'DELTA_REMOVE_QUEUE_ITEM',
      payload: { uuid: 'a' },
    });

    expect(result.queue).toHaveLength(1);
    expect(result.queue[0].uuid).toBe('b');
  });

  it('clears currentClimbQueueItem when the removed item was current', () => {
    const item = makeClimbQueueItem({ uuid: 'current' });
    const state = makeState({ queue: [item], currentClimbQueueItem: item });

    const result = queueReducer(state, {
      type: 'DELTA_REMOVE_QUEUE_ITEM',
      payload: { uuid: 'current' },
    });

    expect(result.queue).toHaveLength(0);
    expect(result.currentClimbQueueItem).toBeNull();
  });

  it('preserves currentClimbQueueItem when a different item is removed', () => {
    const current = makeClimbQueueItem({ uuid: 'current' });
    const other = makeClimbQueueItem({ uuid: 'other' });
    const state = makeState({ queue: [current, other], currentClimbQueueItem: current });

    const result = queueReducer(state, {
      type: 'DELTA_REMOVE_QUEUE_ITEM',
      payload: { uuid: 'other' },
    });

    expect(result.queue).toHaveLength(1);
    expect(result.currentClimbQueueItem?.uuid).toBe('current');
  });

  it('is a no-op when uuid does not exist in queue', () => {
    const item = makeClimbQueueItem({ uuid: 'a' });
    const state = makeState({ queue: [item] });

    const result = queueReducer(state, {
      type: 'DELTA_REMOVE_QUEUE_ITEM',
      payload: { uuid: 'nonexistent' },
    });

    expect(result.queue).toHaveLength(1);
  });
});

// ── DELTA_UPDATE_CURRENT_CLIMB ──────────────────────────────────────────

describe('DELTA_UPDATE_CURRENT_CLIMB', () => {
  it('sets the current climb', () => {
    const item = makeClimbQueueItem({ uuid: 'climb-1' });
    const state = makeState();

    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item, isServerEvent: false },
    });

    expect(result.currentClimbQueueItem?.uuid).toBe('climb-1');
  });

  it('adds item to queue when shouldAddToQueue is true and item is not in queue', () => {
    const item = makeClimbQueueItem({ uuid: 'climb-1' });
    const state = makeState({ queue: [] });

    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item, shouldAddToQueue: true, isServerEvent: false },
    });

    expect(result.queue).toHaveLength(1);
    expect(result.queue[0].uuid).toBe('climb-1');
  });

  it('does not duplicate item in queue when shouldAddToQueue and item already present', () => {
    const item = makeClimbQueueItem({ uuid: 'climb-1' });
    const state = makeState({ queue: [item] });

    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item, shouldAddToQueue: true, isServerEvent: true },
    });

    expect(result.queue).toHaveLength(1);
  });

  it('sets current climb to null when item is null', () => {
    const existingCurrent = makeClimbQueueItem({ uuid: 'old' });
    const state = makeState({ currentClimbQueueItem: existingCurrent });

    const result = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item: null, isServerEvent: true },
    });

    expect(result.currentClimbQueueItem).toBeNull();
  });

  // Widget Next/Prev: the bridge calls dispatchWidgetNavigation(item, correlationId),
  // which dispatches exactly this action — absolute item, shouldAddToQueue:false, and
  // the native correlationId — WITHOUT a fresh JS mutation (native already sent it).
  // This guards the double-advance fix: the action registers the correlationId so the
  // racing CurrentClimbChanged broadcast echoes back as own-echo and is suppressed,
  // instead of moving the current climb a second time.
  it('widget navigation sets current by absolute item, no queue growth, and registers the correlationId', () => {
    const first = makeClimbQueueItem({ uuid: 'q1' });
    const second = makeClimbQueueItem({ uuid: 'q2' });
    const state = makeState({ queue: [first, second], currentClimbQueueItem: first });

    const afterNav = queueReducer(state, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item: second, shouldAddToQueue: false, correlationId: 'widget-navigate' },
    });

    expect(afterNav.currentClimbQueueItem?.uuid).toBe('q2');
    expect(afterNav.queue).toHaveLength(2); // shouldAddToQueue:false → the already-queued item isn't re-added
    expect(afterNav.pendingCurrentClimbUpdates).toContain('widget-navigate');
  });

  it('suppresses the widget-navigate server echo so it cannot double-advance', () => {
    const first = makeClimbQueueItem({ uuid: 'q1' });
    const second = makeClimbQueueItem({ uuid: 'q2' });
    const afterNav = makeState({
      queue: [first, second],
      currentClimbQueueItem: second,
      pendingCurrentClimbUpdates: ['widget-navigate'],
    });

    // The backend broadcasts CurrentClimbChanged with the same correlationId after the
    // widget's HTTP navigate. It must be treated as our own echo: current climb unchanged
    // and the correlationId consumed.
    const afterEcho = queueReducer(afterNav, {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item: second, isServerEvent: true, serverCorrelationId: 'widget-navigate' },
    });

    expect(afterEcho.currentClimbQueueItem?.uuid).toBe('q2');
    expect(afterEcho.pendingCurrentClimbUpdates).not.toContain('widget-navigate');
  });
});

// ── Queue navigation helpers ────────────────────────────────────────────

describe('findNextQueueItem', () => {
  it('returns null for an empty queue', () => {
    expect(findNextQueueItem([], null)).toBeNull();
  });

  it('returns the first item when there is no current climb', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const itemB = makeClimbQueueItem({ uuid: 'b' });

    expect(findNextQueueItem([itemA, itemB], null)?.uuid).toBe('a');
  });

  it('returns the next item after the current climb', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const itemB = makeClimbQueueItem({ uuid: 'b' });
    const itemC = makeClimbQueueItem({ uuid: 'c' });

    expect(findNextQueueItem([itemA, itemB, itemC], itemA)?.uuid).toBe('b');
    expect(findNextQueueItem([itemA, itemB, itemC], itemB)?.uuid).toBe('c');
  });

  it('returns null when current climb is the last item', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const itemB = makeClimbQueueItem({ uuid: 'b' });

    expect(findNextQueueItem([itemA, itemB], itemB)).toBeNull();
  });

  it('returns the first item when current climb is not found in queue', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const orphan = makeClimbQueueItem({ uuid: 'orphan' });

    // findIndex returns -1, so nextIndex is 0 => queue[0]
    expect(findNextQueueItem([itemA], orphan)?.uuid).toBe('a');
  });
});

describe('findPreviousQueueItem', () => {
  it('returns null for an empty queue', () => {
    expect(findPreviousQueueItem([], null)).toBeNull();
  });

  it('returns null when there is no current climb', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });

    expect(findPreviousQueueItem([itemA], null)).toBeNull();
  });

  it('returns the previous item before the current climb', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const itemB = makeClimbQueueItem({ uuid: 'b' });
    const itemC = makeClimbQueueItem({ uuid: 'c' });

    expect(findPreviousQueueItem([itemA, itemB, itemC], itemC)?.uuid).toBe('b');
    expect(findPreviousQueueItem([itemA, itemB, itemC], itemB)?.uuid).toBe('a');
  });

  it('returns null when current climb is the first item', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const itemB = makeClimbQueueItem({ uuid: 'b' });

    expect(findPreviousQueueItem([itemA, itemB], itemA)).toBeNull();
  });

  it('returns null when current climb is not found in queue', () => {
    const itemA = makeClimbQueueItem({ uuid: 'a' });
    const orphan = makeClimbQueueItem({ uuid: 'orphan' });

    // findIndex returns -1, prevIndex is -2
    expect(findPreviousQueueItem([itemA], orphan)).toBeNull();
  });
});
