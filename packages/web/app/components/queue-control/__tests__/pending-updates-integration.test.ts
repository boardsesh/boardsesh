import { describe, it, expect } from 'vite-plus/test';
import { queueReducer } from '../reducer';
import type { QueueState, ClimbQueueItem } from '../types';
import type { SearchRequestPagination, Climb } from '@/app/lib/types';

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
  userAttempts: 0,
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
  minUserQuality: 0,
  hideWithoutUserQuality: false,
  onlyDrafts: false,
  projectsOnly: false,
  zoneBox: null,
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

describe('Pending Updates - Integration Tests', () => {
  describe('Rapid navigation scenario', () => {
    it('should handle rapid local updates followed by delayed server echoes', () => {
      const items: ClimbQueueItem[] = Array.from({ length: 15 }, (_, i) => ({
        climb: { ...mockClimb, uuid: `climb-${i}` },
        addedBy: 'user-1',
        uuid: `item-${i}`,
        suggested: false,
      }));

      let state = initialState;

      // Simulate rapid navigation (15 local updates with correlation IDs)
      items.forEach((item, i) => {
        state = queueReducer(state, {
          type: 'DELTA_UPDATE_CURRENT_CLIMB',
          payload: {
            item,
            shouldAddToQueue: false,
            isServerEvent: false,
            correlationId: `client-123-${i}`,
          },
        });
      });

      // Should have 15 pending updates (correlation IDs)
      expect(state.pendingCurrentClimbUpdates).toHaveLength(15);
      expect(state.currentClimbQueueItem).toEqual(items[14]); // Last item

      // Simulate server echoes arriving (delayed)
      items.forEach((item, index) => {
        state = queueReducer(state, {
          type: 'DELTA_UPDATE_CURRENT_CLIMB',
          payload: {
            item,
            shouldAddToQueue: false,
            isServerEvent: true,
            serverCorrelationId: `client-123-${index}`,
          },
        });

        // Each echo should be skipped and removed from pending
        expect(state.pendingCurrentClimbUpdates).toHaveLength(14 - index);
        // Current climb should remain the last item (not overwritten by echo)
        expect(state.currentClimbQueueItem).toEqual(items[14]);
      });

      // All pending updates should be cleared
      expect(state.pendingCurrentClimbUpdates).toHaveLength(0);
    });

    it('should handle interleaved local and server events', () => {
      const item1: ClimbQueueItem = {
        climb: { ...mockClimb, uuid: 'climb-1' },
        addedBy: 'user-1',
        uuid: 'item-1',
        suggested: false,
      };

      const item2: ClimbQueueItem = {
        climb: { ...mockClimb, uuid: 'climb-2' },
        addedBy: 'user-1',
        uuid: 'item-2',
        suggested: false,
      };

      const item3: ClimbQueueItem = {
        climb: { ...mockClimb, uuid: 'climb-3' },
        addedBy: 'user-2', // From another user
        uuid: 'item-3',
        suggested: false,
      };

      let state = initialState;

      // Local update 1
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: item1,
          shouldAddToQueue: false,
          isServerEvent: false,
          correlationId: 'client-123-1',
        },
      });
      expect(state.pendingCurrentClimbUpdates).toEqual(['client-123-1']);
      expect(state.currentClimbQueueItem).toEqual(item1);

      // Local update 2
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: item2,
          shouldAddToQueue: false,
          isServerEvent: false,
          correlationId: 'client-123-2',
        },
      });
      expect(state.pendingCurrentClimbUpdates).toEqual(['client-123-1', 'client-123-2']);
      expect(state.currentClimbQueueItem).toEqual(item2);

      // Server echo of item1 arrives (should be skipped)
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: item1,
          shouldAddToQueue: false,
          isServerEvent: true,
          serverCorrelationId: 'client-123-1',
        },
      });
      expect(state.pendingCurrentClimbUpdates).toEqual(['client-123-2']); // client-123-1 removed
      expect(state.currentClimbQueueItem).toEqual(item2); // Still item2

      // Server event from another user (should be applied)
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: item3,
          shouldAddToQueue: false,
          isServerEvent: true,
          serverCorrelationId: 'client-456-1',
          eventClientId: 'client-456',
          myClientId: 'client-123',
        },
      });
      expect(state.pendingCurrentClimbUpdates).toEqual(['client-123-2']); // Unchanged
      expect(state.currentClimbQueueItem).toEqual(item3); // Updated to item3

      // Server echo of item2 arrives (should be skipped)
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: item2,
          shouldAddToQueue: false,
          isServerEvent: true,
          serverCorrelationId: 'client-123-2',
        },
      });
      expect(state.pendingCurrentClimbUpdates).toEqual([]); // client-123-2 removed
      expect(state.currentClimbQueueItem).toEqual(item3); // Still item3
    });
  });

  describe('Edge cases', () => {
    it('should handle array saturation beyond 50 items', () => {
      const items: ClimbQueueItem[] = Array.from({ length: 55 }, (_, i) => ({
        climb: { ...mockClimb, uuid: `climb-${i}` },
        addedBy: 'user-1',
        uuid: `item-${i}`,
        suggested: false,
      }));

      let state = initialState;

      // Rapid navigation through 55 items
      items.forEach((item, i) => {
        state = queueReducer(state, {
          type: 'DELTA_UPDATE_CURRENT_CLIMB',
          payload: {
            item,
            shouldAddToQueue: false,
            isServerEvent: false,
            correlationId: `client-123-${i}`,
          },
        });
      });

      // Should be bounded to 50
      expect(state.pendingCurrentClimbUpdates).toHaveLength(50);
      // Should contain correlation IDs 5-54 (oldest 5 dropped)
      expect(state.pendingCurrentClimbUpdates[0]).toBe('client-123-5');
      expect(state.pendingCurrentClimbUpdates[49]).toBe('client-123-54');

      // Server echoes of dropped correlation IDs should NOT be skipped
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: items[0],
          shouldAddToQueue: false,
          isServerEvent: true,
          serverCorrelationId: 'client-123-0',
        },
      });
      expect(state.currentClimbQueueItem).toEqual(items[0]); // Applied (not in pending)

      // Server echoes of retained items SHOULD be skipped
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: items[10],
          shouldAddToQueue: false,
          isServerEvent: true,
          serverCorrelationId: 'client-123-10',
        },
      });
      expect(state.currentClimbQueueItem).toEqual(items[0]); // Skipped (still items[0])
      expect(state.pendingCurrentClimbUpdates.includes('client-123-10')).toBe(false); // Removed from pending
    });

    it('should handle full sync clearing all pending updates', () => {
      const items: ClimbQueueItem[] = Array.from({ length: 20 }, (_, i) => ({
        climb: { ...mockClimb, uuid: `climb-${i}` },
        addedBy: 'user-1',
        uuid: `item-${i}`,
        suggested: false,
      }));

      let state = initialState;

      // Add 20 pending updates
      items.forEach((item, i) => {
        state = queueReducer(state, {
          type: 'DELTA_UPDATE_CURRENT_CLIMB',
          payload: {
            item,
            shouldAddToQueue: false,
            isServerEvent: false,
            correlationId: `client-123-${i}`,
          },
        });
      });

      expect(state.pendingCurrentClimbUpdates).toHaveLength(20);

      // Full sync should clear all pending
      state = queueReducer(state, {
        type: 'INITIAL_QUEUE_DATA',
        payload: {
          queue: [items[5]],
          currentClimbQueueItem: items[5],
        },
      });

      expect(state.pendingCurrentClimbUpdates).toHaveLength(0);
      expect(state.queue).toEqual([items[5]]);
    });
  });

  describe('Race conditions', () => {
    it('should handle same UUID appearing multiple times (deduplication)', () => {
      const item: ClimbQueueItem = {
        climb: mockClimb,
        addedBy: 'user-1',
        uuid: 'item-1',
        suggested: false,
      };

      let state = initialState;

      // First local update
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item, shouldAddToQueue: false, isServerEvent: false },
      });

      // Deduplication check - same item again
      const state2 = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item, shouldAddToQueue: false, isServerEvent: false },
      });

      // Should be deduplicated (no state change)
      expect(state2).toBe(state);
    });

    it('should handle cleanup action during rapid navigation', () => {
      const items: ClimbQueueItem[] = Array.from({ length: 5 }, (_, i) => ({
        climb: { ...mockClimb, uuid: `climb-${i}` },
        addedBy: 'user-1',
        uuid: `item-${i}`,
        suggested: false,
      }));

      let state = initialState;

      // Add 5 pending updates
      items.forEach((item, i) => {
        state = queueReducer(state, {
          type: 'DELTA_UPDATE_CURRENT_CLIMB',
          payload: {
            item,
            shouldAddToQueue: false,
            isServerEvent: false,
            correlationId: `client-123-${i}`,
          },
        });
      });

      expect(state.pendingCurrentClimbUpdates).toHaveLength(5);

      // Cleanup item-2 (simulating timeout)
      state = queueReducer(state, {
        type: 'CLEANUP_PENDING_UPDATE',
        payload: { correlationId: 'client-123-2' },
      });

      expect(state.pendingCurrentClimbUpdates).toEqual([
        'client-123-0',
        'client-123-1',
        'client-123-3',
        'client-123-4',
      ]);

      // Server echo of item-2 should now be applied (not skipped)
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: items[2],
          shouldAddToQueue: false,
          isServerEvent: true,
          serverCorrelationId: 'client-123-2',
        },
      });

      expect(state.currentClimbQueueItem).toEqual(items[2]); // Applied (not in pending anymore)
    });
  });

  describe('ClientId-based echo detection', () => {
    const myClientId = 'client-123';
    const otherClientId = 'client-456';

    it('should skip server events from own client (our echo)', () => {
      const item: ClimbQueueItem = {
        climb: mockClimb,
        addedBy: 'user-1',
        uuid: 'item-1',
        suggested: false,
      };

      let state = initialState;

      // Local update from our client
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item,
          shouldAddToQueue: false,
          isServerEvent: false,
          correlationId: 'client-123-1',
        },
      });

      expect(state.currentClimbQueueItem).toEqual(item);
      expect(state.pendingCurrentClimbUpdates).toHaveLength(1);

      // Server echo with our own clientId and correlationId - should be skipped
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item,
          shouldAddToQueue: false,
          isServerEvent: true,
          eventClientId: myClientId,
          myClientId: myClientId,
          serverCorrelationId: 'client-123-1',
        },
      });

      // State should not change (echo skipped)
      expect(state.currentClimbQueueItem).toEqual(item);
      // Pending should be cleared
      expect(state.pendingCurrentClimbUpdates).toHaveLength(0);
    });

    it('should apply server events from other clients', () => {
      const item1: ClimbQueueItem = {
        climb: { ...mockClimb, uuid: 'climb-1' },
        addedBy: 'user-1',
        uuid: 'item-1',
        suggested: false,
      };

      const item2: ClimbQueueItem = {
        climb: { ...mockClimb, uuid: 'climb-2' },
        addedBy: 'user-2',
        uuid: 'item-2',
        suggested: false,
      };

      let state = initialState;

      // Local update from our client
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: item1,
          shouldAddToQueue: false,
          isServerEvent: false,
          correlationId: 'client-123-1',
        },
      });

      expect(state.currentClimbQueueItem).toEqual(item1);

      // Server event from OTHER client - should be applied
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: item2,
          shouldAddToQueue: false,
          isServerEvent: true,
          eventClientId: otherClientId,
          myClientId: myClientId,
          serverCorrelationId: 'client-456-1',
        },
      });

      // Should update to item2 (from other client)
      expect(state.currentClimbQueueItem).toEqual(item2);
    });

    it('should handle the same climb from different clients correctly', () => {
      const sharedClimb: ClimbQueueItem = {
        climb: mockClimb,
        addedBy: 'user-1',
        uuid: 'item-shared',
        suggested: false,
      };

      let state = initialState;

      // Our client navigates to this climb
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: sharedClimb,
          shouldAddToQueue: false,
          isServerEvent: false,
          correlationId: 'client-123-1',
        },
      });

      expect(state.currentClimbQueueItem).toEqual(sharedClimb);
      expect(state.pendingCurrentClimbUpdates).toHaveLength(1);

      // Other client also navigates to same climb - should be applied
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: sharedClimb,
          shouldAddToQueue: false,
          isServerEvent: true,
          eventClientId: otherClientId,
          myClientId: myClientId,
          serverCorrelationId: 'client-456-1',
        },
      });

      // Should still show the climb (applied from other client)
      expect(state.currentClimbQueueItem).toEqual(sharedClimb);
      // Pending should still have our update
      expect(state.pendingCurrentClimbUpdates).toHaveLength(1);

      // Now our echo arrives - should be skipped
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item: sharedClimb,
          shouldAddToQueue: false,
          isServerEvent: true,
          eventClientId: myClientId,
          myClientId: myClientId,
          serverCorrelationId: 'client-123-1',
        },
      });

      // Still showing the climb
      expect(state.currentClimbQueueItem).toEqual(sharedClimb);
      // Pending cleared (our echo removed)
      expect(state.pendingCurrentClimbUpdates).toHaveLength(0);
    });

    it('should fallback to pending list when clientIds unavailable', () => {
      const item: ClimbQueueItem = {
        climb: mockClimb,
        addedBy: 'user-1',
        uuid: 'item-1',
        suggested: false,
      };

      let state = initialState;

      // Local update
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item,
          shouldAddToQueue: false,
          isServerEvent: false,
          correlationId: 'client-123-1',
        },
      });

      expect(state.pendingCurrentClimbUpdates).toHaveLength(1);

      // Server event WITHOUT clientId - should use correlation ID if available
      state = queueReducer(state, {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: {
          item,
          shouldAddToQueue: false,
          isServerEvent: true,
          serverCorrelationId: 'client-123-1',
          // No clientIds provided
        },
      });

      // Should skip based on correlation ID match
      expect(state.currentClimbQueueItem).toEqual(item);
      expect(state.pendingCurrentClimbUpdates).toHaveLength(0); // Removed from pending
    });
  });
});
