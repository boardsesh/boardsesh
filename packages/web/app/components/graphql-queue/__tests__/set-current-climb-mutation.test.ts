import { describe, it, expect } from 'vitest';
import { queueReducer } from '../../queue-control/reducer';
import type { QueueState, ClimbQueueItem } from '../../queue-control/types';
import type { Climb, SearchRequestPagination } from '@/app/lib/types';

const mockClimb: Climb = {
  uuid: 'climb-1',
  setter_username: 'setter1',
  name: 'Test Climb',
  description: '',
  frames: '',
  angle: 40,
  ascensionist_count: 5,
  difficulty: '7',
  quality_average: '3.5',
  stars: 3,
  difficulty_error: '',
  mirrored: false,
  benchmark_difficulty: null,
  userAscents: 0,
  userAttempts: 0,
};

const mockClimbQueueItem: ClimbQueueItem = {
  climb: mockClimb,
  addedBy: 'user-1',
  uuid: 'queue-item-1',
  suggested: false,
};

const mockSearchParams: SearchRequestPagination = {
  page: 1,
  pageSize: 20,
  gradeAccuracy: 1,
  maxGrade: 18,
  minAscents: 1,
  minGrade: 1,
  minRating: 1,
  sortBy: 'quality',
  sortOrder: 'desc',
  name: '',
  onlyClassics: false,
  onlyTallClimbs: false,
  settername: [],
  setternameSuggestion: '',
  holdsFilter: {},
  hideAttempted: false,
  hideCompleted: false,
  showOnlyAttempted: false,
  showOnlyCompleted: false,
  onlyDrafts: false,
};

const initialState: QueueState = {
  queue: [],
  currentClimbQueueItem: null,
  climbSearchParams: mockSearchParams,
  hasDoneFirstFetch: false,
  initialQueueDataReceivedFromPeers: false,
  pendingCurrentClimbUpdates: [],
  lastReceivedSequence: null,
  lastReceivedStateHash: null,
  needsResync: false,
};

describe('SET_CURRENT_CLIMB mutation optimization', () => {
  it('adds item to queue and sets as current in a single dispatch', () => {
    const newItem: ClimbQueueItem = {
      ...mockClimbQueueItem,
      uuid: 'new-item',
    };

    const result = queueReducer(initialState, {
      type: 'SET_CURRENT_CLIMB',
      payload: newItem,
    });

    // A single SET_CURRENT_CLIMB action should both add to queue AND set current
    expect(result.currentClimbQueueItem).toEqual(newItem);
    expect(result.queue).toHaveLength(1);
    expect(result.queue[0]).toEqual(newItem);
  });

  it('inserts after the current item position in the queue', () => {
    const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
    const item2: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-2' };
    const item3: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-3' };
    const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

    const stateWithCurrent: QueueState = {
      ...initialState,
      queue: [item1, item2, item3],
      currentClimbQueueItem: item2, // item2 is at index 1
    };

    const result = queueReducer(stateWithCurrent, {
      type: 'SET_CURRENT_CLIMB',
      payload: newItem,
    });

    // New item should be inserted right after item2 (position 2)
    expect(result.currentClimbQueueItem).toEqual(newItem);
    expect(result.queue).toHaveLength(4);
    expect(result.queue).toEqual([item1, item2, newItem, item3]);
  });

  it('appends to queue when currentClimbQueueItem is null', () => {
    const existingItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'existing' };
    const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

    const stateWithQueue: QueueState = {
      ...initialState,
      queue: [existingItem],
      currentClimbQueueItem: null,
    };

    const result = queueReducer(stateWithQueue, {
      type: 'SET_CURRENT_CLIMB',
      payload: newItem,
    });

    // With no current item, the new item should be appended to the end
    expect(result.currentClimbQueueItem).toEqual(newItem);
    expect(result.queue).toHaveLength(2);
    expect(result.queue).toEqual([existingItem, newItem]);
  });

  it('produces valid unique UUIDs via uuid package', () => {
    // The uuid package (v4) is used in createClimbQueueItem
    // This test verifies the UUID format used in the queue system
    const { v4: uuidv4 } = require('uuid');
    const uuid1 = uuidv4();
    const uuid2 = uuidv4();

    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    expect(uuid1).toMatch(uuidRegex);
    expect(uuid2).toMatch(uuidRegex);
    expect(uuid1).not.toBe(uuid2);
  });

  it('preserves existing queue items around the insertion point', () => {
    const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
    const item2: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-2' };
    const item3: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-3' };
    const item4: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-4' };
    const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

    const stateWithQueue: QueueState = {
      ...initialState,
      queue: [item1, item2, item3, item4],
      currentClimbQueueItem: item2, // current is at index 1
    };

    const result = queueReducer(stateWithQueue, {
      type: 'SET_CURRENT_CLIMB',
      payload: newItem,
    });

    // Items before insertion point (item1, item2) are preserved
    expect(result.queue[0]).toEqual(item1);
    expect(result.queue[1]).toEqual(item2);
    // New item inserted at index 2
    expect(result.queue[2]).toEqual(newItem);
    // Items after insertion point (item3, item4) are preserved
    expect(result.queue[3]).toEqual(item3);
    expect(result.queue[4]).toEqual(item4);
    expect(result.queue).toHaveLength(5);
  });

  it('works with empty queue and null currentClimbQueueItem', () => {
    const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'first-item' };

    const result = queueReducer(initialState, {
      type: 'SET_CURRENT_CLIMB',
      payload: newItem,
    });

    // On a completely empty state, it should set current and create a single-item queue
    expect(result.currentClimbQueueItem).toEqual(newItem);
    expect(result.queue).toHaveLength(1);
    expect(result.queue[0]).toEqual(newItem);
    // Other state fields should be unmodified
    expect(result.hasDoneFirstFetch).toBe(false);
    expect(result.pendingCurrentClimbUpdates).toEqual([]);
  });

  it('appends when current item is set but not found in queue', () => {
    // Edge case: currentClimbQueueItem references an item not in the queue array
    const orphanCurrent: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'orphan' };
    const existingItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'existing' };
    const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

    const stateWithOrphan: QueueState = {
      ...initialState,
      queue: [existingItem],
      currentClimbQueueItem: orphanCurrent, // not in the queue array
    };

    const result = queueReducer(stateWithOrphan, {
      type: 'SET_CURRENT_CLIMB',
      payload: newItem,
    });

    // Since current item is not found (findIndex returns -1), fallback to append
    expect(result.currentClimbQueueItem).toEqual(newItem);
    expect(result.queue).toHaveLength(2);
    expect(result.queue).toEqual([existingItem, newItem]);
  });

  it('inserts after the last item when current is at the end of the queue', () => {
    const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
    const item2: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-2' };
    const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

    const stateWithCurrentAtEnd: QueueState = {
      ...initialState,
      queue: [item1, item2],
      currentClimbQueueItem: item2, // last item
    };

    const result = queueReducer(stateWithCurrentAtEnd, {
      type: 'SET_CURRENT_CLIMB',
      payload: newItem,
    });

    // New item should be appended after item2
    expect(result.queue).toEqual([item1, item2, newItem]);
    expect(result.currentClimbQueueItem).toEqual(newItem);
  });
});
