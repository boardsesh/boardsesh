import { describe, it, expect } from 'vitest';
import { queueReducer } from '../reducer';
import { QueueState, QueueAction, ClimbQueueItem } from '../types';
import { SearchRequestPagination, Climb } from '@/app/lib/types';

const mockClimb: Climb = {
  uuid: 'climb-1',
  setter_username: 'setter1',
  name: 'Test Climb',
  description: 'A test climb',
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
  userAttempts: 0
};

const mockClimbQueueItem: ClimbQueueItem = {
  climb: mockClimb,
  addedBy: 'user-1',
  uuid: 'queue-item-1',
  suggested: false
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
  onlyDrafts: false
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

describe('queueReducer', () => {
  describe('ADD_TO_QUEUE', () => {
    it('should add a climb to an empty queue', () => {
      const action: QueueAction = {
        type: 'ADD_TO_QUEUE',
        payload: mockClimbQueueItem
      };

      const result = queueReducer(initialState, action);

      expect(result.queue).toHaveLength(1);
      expect(result.queue[0]).toEqual(mockClimbQueueItem);
      expect(result.currentClimbQueueItem).toBeNull();
    });

    it('should add a climb to an existing queue', () => {
      const existingItem: ClimbQueueItem = {
        ...mockClimbQueueItem,
        uuid: 'existing-item'
      };
      
      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [existingItem]
      };

      const newItem: ClimbQueueItem = {
        ...mockClimbQueueItem,
        uuid: 'new-item'
      };

      const action: QueueAction = {
        type: 'ADD_TO_QUEUE',
        payload: newItem
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result.queue).toHaveLength(2);
      expect(result.queue[0]).toEqual(existingItem);
      expect(result.queue[1]).toEqual(newItem);
    });
  });

  describe('REMOVE_FROM_QUEUE', () => {
    it('should remove items from queue', () => {
      const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
      const item2: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-2' };
      const item3: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-3' };

      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [item1, item2, item3]
      };

      const action: QueueAction = {
        type: 'REMOVE_FROM_QUEUE',
        payload: [item1, item3] // Remove item2
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result.queue).toHaveLength(2);
      expect(result.queue).toEqual([item1, item3]);
    });

    it('should handle removing all items', () => {
      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [mockClimbQueueItem]
      };

      const action: QueueAction = {
        type: 'REMOVE_FROM_QUEUE',
        payload: []
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result.queue).toHaveLength(0);
    });
  });

  describe('SET_CURRENT_CLIMB', () => {
    it('should set current climb and add to empty queue', () => {
      const action: QueueAction = {
        type: 'SET_CURRENT_CLIMB',
        payload: mockClimbQueueItem
      };

      const result = queueReducer(initialState, action);

      expect(result.currentClimbQueueItem).toEqual(mockClimbQueueItem);
      expect(result.queue).toHaveLength(1);
      expect(result.queue[0]).toEqual(mockClimbQueueItem);
    });

    it('should insert climb after current position in queue', () => {
      const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
      const item2: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-2' };
      const item3: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-3' };
      const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

      const stateWithCurrentClimb: QueueState = {
        ...initialState,
        queue: [item1, item2, item3],
        currentClimbQueueItem: item2
      };

      const action: QueueAction = {
        type: 'SET_CURRENT_CLIMB',
        payload: newItem
      };

      const result = queueReducer(stateWithCurrentClimb, action);

      expect(result.currentClimbQueueItem).toEqual(newItem);
      expect(result.queue).toHaveLength(4);
      expect(result.queue).toEqual([item1, item2, newItem, item3]);
    });

    it('should handle when current climb is not in queue', () => {
      const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
      const currentItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'current-not-in-queue' };
      const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

      const stateWithCurrentClimb: QueueState = {
        ...initialState,
        queue: [item1],
        currentClimbQueueItem: currentItem
      };

      const action: QueueAction = {
        type: 'SET_CURRENT_CLIMB',
        payload: newItem
      };

      const result = queueReducer(stateWithCurrentClimb, action);

      expect(result.currentClimbQueueItem).toEqual(newItem);
      expect(result.queue).toHaveLength(2);
      expect(result.queue).toEqual([item1, newItem]);
    });
  });

  describe('SET_CURRENT_CLIMB_QUEUE_ITEM', () => {
    it('should set current climb queue item without modifying queue', () => {
      const existingItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'existing' };
      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [existingItem]
      };

      const action: QueueAction = {
        type: 'SET_CURRENT_CLIMB_QUEUE_ITEM',
        payload: existingItem
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result.currentClimbQueueItem).toEqual(existingItem);
      expect(result.queue).toEqual([existingItem]);
    });

    it('should add suggested item to queue if not present', () => {
      const existingItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'existing' };
      const suggestedItem: ClimbQueueItem = { 
        ...mockClimbQueueItem, 
        uuid: 'suggested',
        suggested: true
      };

      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [existingItem]
      };

      const action: QueueAction = {
        type: 'SET_CURRENT_CLIMB_QUEUE_ITEM',
        payload: suggestedItem
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result.currentClimbQueueItem).toEqual(suggestedItem);
      expect(result.queue).toHaveLength(2);
      expect(result.queue).toEqual([existingItem, suggestedItem]);
    });

    it('should not add suggested item if already in queue', () => {
      const suggestedItem: ClimbQueueItem = { 
        ...mockClimbQueueItem, 
        uuid: 'suggested',
        suggested: true
      };

      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [suggestedItem]
      };

      const action: QueueAction = {
        type: 'SET_CURRENT_CLIMB_QUEUE_ITEM',
        payload: suggestedItem
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result.currentClimbQueueItem).toEqual(suggestedItem);
      expect(result.queue).toHaveLength(1);
      expect(result.queue).toEqual([suggestedItem]);
    });
  });

  describe('SET_CLIMB_SEARCH_PARAMS', () => {
    it('should update climb search params', () => {
      const newParams: SearchRequestPagination = {
        page: 2,
        pageSize: 10,
        gradeAccuracy: 1,
        maxGrade: 18,
        minAscents: 1,
        minGrade: 1,
        minRating: 1,
        sortBy: 'difficulty',
        sortOrder: 'asc',
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
        onlyDrafts: false
      };

      const action: QueueAction = {
        type: 'SET_CLIMB_SEARCH_PARAMS',
        payload: newParams
      };

      const result = queueReducer(initialState, action);

      expect(result.climbSearchParams).toEqual(newParams);
      expect(result.queue).toEqual(initialState.queue);
      expect(result.currentClimbQueueItem).toEqual(initialState.currentClimbQueueItem);
    });
  });

  describe('UPDATE_QUEUE', () => {
    it('should update queue and current climb', () => {
      const newQueue = [mockClimbQueueItem];
      const newCurrentClimb = mockClimbQueueItem;

      const action: QueueAction = {
        type: 'UPDATE_QUEUE',
        payload: {
          queue: newQueue,
          currentClimbQueueItem: newCurrentClimb
        }
      };

      const result = queueReducer(initialState, action);

      expect(result.queue).toEqual(newQueue);
      expect(result.currentClimbQueueItem).toEqual(newCurrentClimb);
    });

    it('should preserve current climb when not provided', () => {
      const existingCurrentClimb = mockClimbQueueItem;
      const stateWithCurrentClimb: QueueState = {
        ...initialState,
        currentClimbQueueItem: existingCurrentClimb
      };

      const newQueue = [{ ...mockClimbQueueItem, uuid: 'new-item' }];

      const action: QueueAction = {
        type: 'UPDATE_QUEUE',
        payload: {
          queue: newQueue
        }
      };

      const result = queueReducer(stateWithCurrentClimb, action);

      expect(result.queue).toEqual(newQueue);
      expect(result.currentClimbQueueItem).toEqual(existingCurrentClimb);
    });
  });

  describe('INITIAL_QUEUE_DATA', () => {
    it('should set initial queue data and mark as received from peers', () => {
      const newQueue = [mockClimbQueueItem];
      const newCurrentClimb = mockClimbQueueItem;

      const action: QueueAction = {
        type: 'INITIAL_QUEUE_DATA',
        payload: {
          queue: newQueue,
          currentClimbQueueItem: newCurrentClimb
        }
      };

      const result = queueReducer(initialState, action);

      expect(result.queue).toEqual(newQueue);
      expect(result.currentClimbQueueItem).toEqual(newCurrentClimb);
      expect(result.initialQueueDataReceivedFromPeers).toBe(true);
    });
  });

  describe('SET_FIRST_FETCH', () => {
    it('should set hasDoneFirstFetch to true', () => {
      const action: QueueAction = {
        type: 'SET_FIRST_FETCH',
        payload: true
      };

      const result = queueReducer(initialState, action);

      expect(result.hasDoneFirstFetch).toBe(true);
    });

    it('should set hasDoneFirstFetch to false', () => {
      const stateWithFirstFetch: QueueState = {
        ...initialState,
        hasDoneFirstFetch: true
      };

      const action: QueueAction = {
        type: 'SET_FIRST_FETCH',
        payload: false
      };

      const result = queueReducer(stateWithFirstFetch, action);

      expect(result.hasDoneFirstFetch).toBe(false);
    });
  });

  describe('MIRROR_CLIMB', () => {
    it('should toggle mirrored state of current climb', () => {
      const currentClimb: ClimbQueueItem = {
        ...mockClimbQueueItem,
        climb: { ...mockClimb, mirrored: false }
      };

      const stateWithCurrentClimb: QueueState = {
        ...initialState,
        currentClimbQueueItem: currentClimb
      };

      const action: QueueAction = {
        type: 'MIRROR_CLIMB'
      };

      const result = queueReducer(stateWithCurrentClimb, action);

      expect(result.currentClimbQueueItem?.climb.mirrored).toBe(true);
    });

    it('should toggle mirrored state from true to false', () => {
      const currentClimb: ClimbQueueItem = {
        ...mockClimbQueueItem,
        climb: { ...mockClimb, mirrored: true }
      };

      const stateWithCurrentClimb: QueueState = {
        ...initialState,
        currentClimbQueueItem: currentClimb
      };

      const action: QueueAction = {
        type: 'MIRROR_CLIMB'
      };

      const result = queueReducer(stateWithCurrentClimb, action);

      expect(result.currentClimbQueueItem?.climb.mirrored).toBe(false);
    });

    it('should do nothing when no current climb', () => {
      const action: QueueAction = {
        type: 'MIRROR_CLIMB'
      };

      const result = queueReducer(initialState, action);

      expect(result).toEqual(initialState);
    });
  });

  describe('DELTA_ADD_QUEUE_ITEM', () => {
    it('should add item to queue', () => {
      const action: QueueAction = {
        type: 'DELTA_ADD_QUEUE_ITEM',
        payload: { item: mockClimbQueueItem }
      };

      const result = queueReducer(initialState, action);

      expect(result.queue).toHaveLength(1);
      expect(result.queue[0]).toEqual(mockClimbQueueItem);
    });

    it('should add item at specific position', () => {
      // Each item needs a unique climb.uuid since deduplication is by climb, not queue item
      const item1: ClimbQueueItem = {
        ...mockClimbQueueItem,
        uuid: 'item-1',
        climb: { ...mockClimb, uuid: 'climb-1' }
      };
      const item2: ClimbQueueItem = {
        ...mockClimbQueueItem,
        uuid: 'item-2',
        climb: { ...mockClimb, uuid: 'climb-2' }
      };
      const newItem: ClimbQueueItem = {
        ...mockClimbQueueItem,
        uuid: 'new-item',
        climb: { ...mockClimb, uuid: 'climb-new' }
      };

      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [item1, item2]
      };

      const action: QueueAction = {
        type: 'DELTA_ADD_QUEUE_ITEM',
        payload: { item: newItem, position: 1 }
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result.queue).toHaveLength(3);
      expect(result.queue[1]).toEqual(newItem);
      expect(result.queue).toEqual([item1, newItem, item2]);
    });

    it('should skip adding duplicate item (deduplication)', () => {
      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [mockClimbQueueItem]
      };

      const action: QueueAction = {
        type: 'DELTA_ADD_QUEUE_ITEM',
        payload: { item: mockClimbQueueItem }
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result.queue).toHaveLength(1);
      expect(result).toBe(stateWithQueue); // Should return same state reference
    });
  });

  describe('DELTA_REMOVE_QUEUE_ITEM', () => {
    it('should remove item by uuid', () => {
      const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
      const item2: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-2' };

      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [item1, item2]
      };

      const action: QueueAction = {
        type: 'DELTA_REMOVE_QUEUE_ITEM',
        payload: { uuid: 'item-1' }
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result.queue).toHaveLength(1);
      expect(result.queue[0]).toEqual(item2);
    });

    it('should clear current climb if removed item was current', () => {
      const stateWithCurrentClimb: QueueState = {
        ...initialState,
        queue: [mockClimbQueueItem],
        currentClimbQueueItem: mockClimbQueueItem
      };

      const action: QueueAction = {
        type: 'DELTA_REMOVE_QUEUE_ITEM',
        payload: { uuid: mockClimbQueueItem.uuid }
      };

      const result = queueReducer(stateWithCurrentClimb, action);

      expect(result.queue).toHaveLength(0);
      expect(result.currentClimbQueueItem).toBeNull();
    });
  });

  describe('DELTA_REORDER_QUEUE_ITEM', () => {
    it('should reorder item in queue', () => {
      const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
      const item2: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-2' };
      const item3: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-3' };

      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [item1, item2, item3]
      };

      const action: QueueAction = {
        type: 'DELTA_REORDER_QUEUE_ITEM',
        payload: { uuid: 'item-1', oldIndex: 0, newIndex: 2 }
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result.queue).toEqual([item2, item3, item1]);
    });

    it('should return unchanged state for invalid indices', () => {
      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [mockClimbQueueItem]
      };

      const action: QueueAction = {
        type: 'DELTA_REORDER_QUEUE_ITEM',
        payload: { uuid: mockClimbQueueItem.uuid, oldIndex: 5, newIndex: 0 }
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result).toBe(stateWithQueue);
    });

    it('should return unchanged state if uuid does not match item at oldIndex', () => {
      const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
      const item2: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-2' };

      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [item1, item2]
      };

      const action: QueueAction = {
        type: 'DELTA_REORDER_QUEUE_ITEM',
        payload: { uuid: 'wrong-uuid', oldIndex: 0, newIndex: 1 }
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result).toBe(stateWithQueue);
    });
  });

  describe('DELTA_UPDATE_CURRENT_CLIMB', () => {
    it('should update current climb', () => {
      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: mockClimbQueueItem, shouldAddToQueue: false }
      };

      const result = queueReducer(initialState, action);

      expect(result.currentClimbQueueItem).toEqual(mockClimbQueueItem);
      expect(result.queue).toHaveLength(0);
    });

    it('should add to queue when shouldAddToQueue is true', () => {
      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: mockClimbQueueItem, shouldAddToQueue: true }
      };

      const result = queueReducer(initialState, action);

      expect(result.currentClimbQueueItem).toEqual(mockClimbQueueItem);
      expect(result.queue).toHaveLength(1);
      expect(result.queue[0]).toEqual(mockClimbQueueItem);
    });

    it('should skip if same item is already current (deduplication)', () => {
      const stateWithCurrentClimb: QueueState = {
        ...initialState,
        currentClimbQueueItem: mockClimbQueueItem
      };

      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: mockClimbQueueItem, shouldAddToQueue: false }
      };

      const result = queueReducer(stateWithCurrentClimb, action);

      expect(result).toBe(stateWithCurrentClimb);
    });

    it('should handle null item', () => {
      const stateWithCurrentClimb: QueueState = {
        ...initialState,
        currentClimbQueueItem: mockClimbQueueItem
      };

      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: null, shouldAddToQueue: false }
      };

      const result = queueReducer(stateWithCurrentClimb, action);

      expect(result.currentClimbQueueItem).toBeNull();
    });
  });

  describe('DELTA_MIRROR_CURRENT_CLIMB', () => {
    it('should set mirrored state on current climb', () => {
      const currentClimb: ClimbQueueItem = {
        ...mockClimbQueueItem,
        climb: { ...mockClimb, mirrored: false }
      };

      const stateWithCurrentClimb: QueueState = {
        ...initialState,
        currentClimbQueueItem: currentClimb,
        queue: [currentClimb]
      };

      const action: QueueAction = {
        type: 'DELTA_MIRROR_CURRENT_CLIMB',
        payload: { mirrored: true }
      };

      const result = queueReducer(stateWithCurrentClimb, action);

      expect(result.currentClimbQueueItem?.climb.mirrored).toBe(true);
      expect(result.queue[0].climb.mirrored).toBe(true);
    });

    it('should do nothing when no current climb', () => {
      const action: QueueAction = {
        type: 'DELTA_MIRROR_CURRENT_CLIMB',
        payload: { mirrored: true }
      };

      const result = queueReducer(initialState, action);

      expect(result).toBe(initialState);
    });
  });

  describe('DELTA_REPLACE_QUEUE_ITEM', () => {
    it('should replace item in queue by uuid', () => {
      const originalItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
      const replacementItem: ClimbQueueItem = {
        ...mockClimbQueueItem,
        uuid: 'item-1',
        climb: { ...mockClimb, name: 'Updated Climb' }
      };

      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [originalItem]
      };

      const action: QueueAction = {
        type: 'DELTA_REPLACE_QUEUE_ITEM',
        payload: { uuid: 'item-1', item: replacementItem }
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result.queue[0].climb.name).toBe('Updated Climb');
    });

    it('should update current climb if replaced item was current', () => {
      const stateWithCurrentClimb: QueueState = {
        ...initialState,
        queue: [mockClimbQueueItem],
        currentClimbQueueItem: mockClimbQueueItem
      };

      const replacementItem: ClimbQueueItem = {
        ...mockClimbQueueItem,
        climb: { ...mockClimb, name: 'Updated Climb' }
      };

      const action: QueueAction = {
        type: 'DELTA_REPLACE_QUEUE_ITEM',
        payload: { uuid: mockClimbQueueItem.uuid, item: replacementItem }
      };

      const result = queueReducer(stateWithCurrentClimb, action);

      expect(result.currentClimbQueueItem?.climb.name).toBe('Updated Climb');
    });

    it('should return unchanged state if uuid not found', () => {
      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [mockClimbQueueItem]
      };

      const action: QueueAction = {
        type: 'DELTA_REPLACE_QUEUE_ITEM',
        payload: { uuid: 'non-existent', item: mockClimbQueueItem }
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result).toBe(stateWithQueue);
    });
  });

  describe('default case', () => {
    it('should return unchanged state for unknown action', () => {
      const unknownAction = { type: 'UNKNOWN_ACTION' } as unknown as QueueAction;

      const result = queueReducer(initialState, unknownAction);

      expect(result).toEqual(initialState);
    });
  });

  describe('DELTA_UPDATE_CURRENT_CLIMB - Server Event Handling', () => {
    it('should track pending updates for local actions', () => {
      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: mockClimbQueueItem,
          shouldAddToQueue: false,
          isServerEvent: false,
          correlationId: 'client-123-1',
        },
      };

      const result = queueReducer(initialState, action);

      expect(result.pendingCurrentClimbUpdates).toContain('client-123-1');
      expect(result.pendingCurrentClimbUpdates).toHaveLength(1);
    });

    it('should skip server events that match pending updates', () => {
      const stateWithPending: QueueState = {
        ...initialState,
        pendingCurrentClimbUpdates: ['client-123-1'],
        currentClimbQueueItem: null,
      };

      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: mockClimbQueueItem,
          shouldAddToQueue: false,
          isServerEvent: true,
          serverCorrelationId: 'client-123-1',
        },
      };

      const result = queueReducer(stateWithPending, action);

      // Should not update current climb (echo was skipped)
      expect(result.currentClimbQueueItem).toBeNull();
      // Should remove from pending
      expect(result.pendingCurrentClimbUpdates).not.toContain('client-123-1');
      expect(result.pendingCurrentClimbUpdates).toHaveLength(0);
    });

    it('should apply server events that do not match pending updates', () => {
      const otherItem: ClimbQueueItem = {
        ...mockClimbQueueItem,
        uuid: 'other-uuid',
      };

      const stateWithPending: QueueState = {
        ...initialState,
        pendingCurrentClimbUpdates: ['client-123-1'],
      };

      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: otherItem,
          shouldAddToQueue: false,
          isServerEvent: true,
          serverCorrelationId: 'client-456-1', // Different correlation ID
        },
      };

      const result = queueReducer(stateWithPending, action);

      // Should apply the update (different correlation ID)
      expect(result.currentClimbQueueItem).toEqual(otherItem);
      // Should not remove from pending (different correlation ID)
      expect(result.pendingCurrentClimbUpdates).toContain('client-123-1');
    });

    it('should maintain pending array bounded to last 50 items', () => {
      // Create state with 49 pending correlation IDs
      const existingPending = Array.from({ length: 49 }, (_, i) => `client-123-${i}`);
      const stateWithPending: QueueState = {
        ...initialState,
        pendingCurrentClimbUpdates: existingPending,
      };

      const newItem: ClimbQueueItem = {
        ...mockClimbQueueItem,
        uuid: 'uuid-50',
      };

      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: newItem,
          shouldAddToQueue: false,
          isServerEvent: false,
          correlationId: 'client-123-50',
        },
      };

      const result = queueReducer(stateWithPending, action);

      expect(result.pendingCurrentClimbUpdates).toHaveLength(50);
      expect(result.pendingCurrentClimbUpdates[49]).toBe('client-123-50');
    });

    it('should drop oldest item when exceeding 50 pending items', () => {
      // Create state with 50 pending correlation IDs
      const existingPending = Array.from({ length: 50 }, (_, i) => `client-123-${i}`);
      const stateWithPending: QueueState = {
        ...initialState,
        pendingCurrentClimbUpdates: existingPending,
      };

      const newItem: ClimbQueueItem = {
        ...mockClimbQueueItem,
        uuid: 'uuid-51',
      };

      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: newItem,
          shouldAddToQueue: false,
          isServerEvent: false,
          correlationId: 'client-123-51',
        },
      };

      const result = queueReducer(stateWithPending, action);

      expect(result.pendingCurrentClimbUpdates).toHaveLength(50);
      expect(result.pendingCurrentClimbUpdates[0]).toBe('client-123-1'); // client-123-0 dropped
      expect(result.pendingCurrentClimbUpdates[49]).toBe('client-123-51');
    });

    it('should not track pending for server events', () => {
      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: mockClimbQueueItem,
          shouldAddToQueue: false,
          isServerEvent: true,
        },
      };

      const result = queueReducer(initialState, action);

      expect(result.pendingCurrentClimbUpdates).toHaveLength(0);
    });

    it('should handle null item from server event', () => {
      const stateWithPending: QueueState = {
        ...initialState,
        pendingCurrentClimbUpdates: ['client-123-1'],
        currentClimbQueueItem: mockClimbQueueItem,
      };

      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: null,
          shouldAddToQueue: false,
          isServerEvent: true,
        },
      };

      const result = queueReducer(stateWithPending, action);

      expect(result.currentClimbQueueItem).toBeNull();
      // Pending list should still contain the entry (server event without matching correlationId)
      expect(result.pendingCurrentClimbUpdates).toContain('client-123-1');
    });

    it('should add to queue when shouldAddToQueue is true for local action', () => {
      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: mockClimbQueueItem,
          shouldAddToQueue: true,
          isServerEvent: false,
          correlationId: 'client-123-1',
        },
      };

      const result = queueReducer(initialState, action);

      expect(result.queue).toContain(mockClimbQueueItem);
      expect(result.pendingCurrentClimbUpdates).toContain('client-123-1');
    });

    it('should not add duplicate to queue when item already exists', () => {
      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [mockClimbQueueItem],
      };

      const action: QueueAction = {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: mockClimbQueueItem,
          shouldAddToQueue: true,
          isServerEvent: false,
          correlationId: 'client-123-1',
        },
      };

      const result = queueReducer(stateWithQueue, action);

      expect(result.queue).toHaveLength(1); // No duplicate
      expect(result.pendingCurrentClimbUpdates).toContain('client-123-1');
    });
  });

  describe('INITIAL_QUEUE_DATA - Pending Updates', () => {
    it('should clear pending updates on initial queue data sync', () => {
      const stateWithPending: QueueState = {
        ...initialState,
        pendingCurrentClimbUpdates: ['client-123-1', 'client-123-2', 'client-123-3'],
      };

      const action: QueueAction = {
        type: 'INITIAL_QUEUE_DATA',
        payload: {
          queue: [mockClimbQueueItem],
          currentClimbQueueItem: mockClimbQueueItem,
        },
      };

      const result = queueReducer(stateWithPending, action);

      expect(result.pendingCurrentClimbUpdates).toHaveLength(0);
      expect(result.initialQueueDataReceivedFromPeers).toBe(true);
    });
  });

  describe('CLEANUP_PENDING_UPDATE', () => {
    it('should remove specific correlationId from pending updates', () => {
      const stateWithPending: QueueState = {
        ...initialState,
        pendingCurrentClimbUpdates: ['client-123-1', 'client-123-2', 'client-123-3'],
      };

      const action: QueueAction = {
        type: 'CLEANUP_PENDING_UPDATE',
        payload: { correlationId: 'client-123-2' },
      };

      const result = queueReducer(stateWithPending, action);

      expect(result.pendingCurrentClimbUpdates).toHaveLength(2);
      expect(result.pendingCurrentClimbUpdates).toContain('client-123-1');
      expect(result.pendingCurrentClimbUpdates).toContain('client-123-3');
      expect(result.pendingCurrentClimbUpdates).not.toContain('client-123-2');
    });

    it('should handle cleanup of non-existent correlationId gracefully', () => {
      const stateWithPending: QueueState = {
        ...initialState,
        pendingCurrentClimbUpdates: ['client-123-1', 'client-123-2'],
      };

      const action: QueueAction = {
        type: 'CLEANUP_PENDING_UPDATE',
        payload: { correlationId: 'client-999-1' },
      };

      const result = queueReducer(stateWithPending, action);

      expect(result.pendingCurrentClimbUpdates).toHaveLength(2);
      expect(result.pendingCurrentClimbUpdates).toContain('client-123-1');
      expect(result.pendingCurrentClimbUpdates).toContain('client-123-2');
    });

    it('should handle cleanup on empty pending array', () => {
      const action: QueueAction = {
        type: 'CLEANUP_PENDING_UPDATE',
        payload: { correlationId: 'client-123-1' },
      };

      const result = queueReducer(initialState, action);

      expect(result.pendingCurrentClimbUpdates).toHaveLength(0);
    });

  });

  describe('DELTA_UPDATE_CURRENT_CLIMB - insertAfterCurrent', () => {
    it('should insert after current item position when insertAfterCurrent is true', () => {
      const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
      const item2: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-2' };
      const item3: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-3' };
      const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

      const stateWithCurrent: QueueState = {
        ...initialState,
        queue: [item1, item2, item3],
        currentClimbQueueItem: item2,
      };

      const result = queueReducer(stateWithCurrent, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: newItem, shouldAddToQueue: true, insertAfterCurrent: true },
      });

      expect(result.currentClimbQueueItem).toEqual(newItem);
      expect(result.queue).toHaveLength(4);
      expect(result.queue).toEqual([item1, item2, newItem, item3]);
    });

    it('should append when insertAfterCurrent is true but no current item exists', () => {
      const existingItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'existing' };
      const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

      const stateWithQueue: QueueState = {
        ...initialState,
        queue: [existingItem],
        currentClimbQueueItem: null,
      };

      const result = queueReducer(stateWithQueue, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: newItem, shouldAddToQueue: true, insertAfterCurrent: true },
      });

      expect(result.currentClimbQueueItem).toEqual(newItem);
      expect(result.queue).toHaveLength(2);
      expect(result.queue).toEqual([existingItem, newItem]);
    });

    it('should append when insertAfterCurrent is true but current item not found in queue', () => {
      const orphanCurrent: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'orphan' };
      const existingItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'existing' };
      const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

      const stateWithOrphan: QueueState = {
        ...initialState,
        queue: [existingItem],
        currentClimbQueueItem: orphanCurrent,
      };

      const result = queueReducer(stateWithOrphan, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: newItem, shouldAddToQueue: true, insertAfterCurrent: true },
      });

      expect(result.currentClimbQueueItem).toEqual(newItem);
      expect(result.queue).toHaveLength(2);
      expect(result.queue).toEqual([existingItem, newItem]);
    });

    it('should not add duplicate when insertAfterCurrent is true and item already in queue', () => {
      const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
      const existingItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

      const stateWithItem: QueueState = {
        ...initialState,
        queue: [item1, existingItem],
        currentClimbQueueItem: item1,
      };

      const result = queueReducer(stateWithItem, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: existingItem, shouldAddToQueue: true, insertAfterCurrent: true },
      });

      expect(result.queue).toHaveLength(2);
    });

    it('should still append when insertAfterCurrent is false', () => {
      const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
      const item2: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-2' };
      const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

      const stateWithCurrent: QueueState = {
        ...initialState,
        queue: [item1, item2],
        currentClimbQueueItem: item1,
      };

      const result = queueReducer(stateWithCurrent, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: newItem, shouldAddToQueue: true, insertAfterCurrent: false },
      });

      expect(result.queue).toEqual([item1, item2, newItem]);
    });

    it('should insert after last item when current is at end of queue', () => {
      const item1: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-1' };
      const item2: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'item-2' };
      const newItem: ClimbQueueItem = { ...mockClimbQueueItem, uuid: 'new-item' };

      const stateWithCurrentAtEnd: QueueState = {
        ...initialState,
        queue: [item1, item2],
        currentClimbQueueItem: item2,
      };

      const result = queueReducer(stateWithCurrentAtEnd, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: newItem, shouldAddToQueue: true, insertAfterCurrent: true },
      });

      expect(result.queue).toEqual([item1, item2, newItem]);
      expect(result.currentClimbQueueItem).toEqual(newItem);
    });
  });
});