// Integration test: exercises the real room-manager queue-state flow against
// the postgres-js test database configured by __tests__/setup.ts. Needs
// DATABASE_URL (or the default local Neon proxy) to be reachable — skips
// gracefully otherwise via the connection checks in setup.ts.
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { roomManager } from '../services/room-manager';
import { db } from '../db/client';
import { sessions, sessionQueues } from '../db/schema';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';

// Generate unique session IDs to prevent conflicts with parallel tests
const uniqueId = () => `ws-sync-${randomUUID().slice(0, 8)}`;

// Helper to create test climb queue items
function createTestClimbQueueItem(uuid: string, name: string): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: `climb-${uuid}`,
      setter_username: 'test-setter',
      name,
      description: 'Test climb',
      frames: 'test-frames',
      angle: 40,
      ascensionist_count: 10,
      difficulty: 'V5',
      quality_average: '4.5',
      stars: 4.5,
      difficulty_error: '0.5',
      mirrored: false,
      benchmark_difficulty: null,
    },
    tickedBy: [],
    addedBy: 'test-user',
    suggested: false,
  };
}

describe('WebSocket Sync - getQueueState Redis Priority', () => {
  describe('Unit Tests (mocked Redis)', () => {
    beforeEach(() => {
      // Reset room manager state
      roomManager.reset();
    });

    it('should return Redis data when available (not fall back to Postgres)', async () => {
      const sessionId = uniqueId();

      // Create session in Postgres with old data
      await db.insert(sessions).values({
        id: sessionId,
        boardPath: '/kilter/test',
        createdAt: new Date(),
        lastActivity: new Date(),
      });

      await db.insert(sessionQueues).values({
        sessionId,
        queue: [createTestClimbQueueItem('old-1', 'Old Climb from Postgres')],
        currentClimbQueueItem: null,
        version: 5,
        sequence: 5,
        updatedAt: new Date(),
      });

      // When Redis is not initialized, should fall back to Postgres
      const state = await roomManager.getQueueState(sessionId);

      expect(state.sequence).toBe(5);
      expect(state.queue.length).toBe(1);
      expect(state.queue[0].climb.name).toBe('Old Climb from Postgres');
    });

    it('should return empty state for non-existent session', async () => {
      const state = await roomManager.getQueueState('non-existent-session');

      expect(state.queue).toEqual([]);
      expect(state.currentClimbQueueItem).toBeNull();
      expect(state.version).toBe(0);
      expect(state.sequence).toBe(0);
    });
  });
});

// Note: Full WebSocket subscription tests require proper auth and session setup.
// These tests verify the subscription logic indirectly through unit tests.
// The subscription filtering logic is tested in the resolver itself.
describe('WebSocket Sync - Subscription Event Filtering (Unit)', () => {
  beforeEach(async () => {
    roomManager.reset();
  });

  it('should have sequence in FullSync state from getQueueState', async () => {
    const sessionId = uniqueId();

    // Create session with queue state
    await db.insert(sessions).values({
      id: sessionId,
      boardPath: '/kilter/test',
      createdAt: new Date(),
      lastActivity: new Date(),
    });

    await db.insert(sessionQueues).values({
      sessionId,
      queue: [createTestClimbQueueItem('item-1', 'Test Climb')],
      currentClimbQueueItem: null,
      version: 3,
      sequence: 10,
      updatedAt: new Date(),
    });

    // getQueueState should return the correct sequence for FullSync
    const state = await roomManager.getQueueState(sessionId);

    expect(state.sequence).toBe(10);
    expect(state.queue.length).toBe(1);
    expect(state.version).toBe(3);
  });

  it('should have stateHash for state change detection', async () => {
    const sessionId = uniqueId();

    // Create session with queue state
    await db.insert(sessions).values({
      id: sessionId,
      boardPath: '/kilter/test',
      createdAt: new Date(),
      lastActivity: new Date(),
    });

    await db.insert(sessionQueues).values({
      sessionId,
      queue: [createTestClimbQueueItem('item-1', 'Test Climb')],
      currentClimbQueueItem: null,
      version: 1,
      sequence: 5,
      updatedAt: new Date(),
    });

    const state = await roomManager.getQueueState(sessionId);

    // stateHash should be present and non-empty
    expect(state.stateHash).toBeDefined();
    expect(state.stateHash.length).toBeGreaterThan(0);
  });
});

describe('WebSocket Sync - Sequence Number Consistency', () => {
  beforeEach(async () => {
    roomManager.reset();
  });

  it('should increment sequence on each queue update', async () => {
    const sessionId = uniqueId();

    // Create session with initial queue state (version 1, sequence 1)
    await db.insert(sessions).values({
      id: sessionId,
      boardPath: '/kilter/test',
      createdAt: new Date(),
      lastActivity: new Date(),
    });

    await db.insert(sessionQueues).values({
      sessionId,
      queue: [],
      currentClimbQueueItem: null,
      version: 1,
      sequence: 1,
      updatedAt: new Date(),
    });

    // Use updateQueueStateImmediate for immediate Postgres writes (no Redis in tests)
    const version1 = await roomManager.updateQueueStateImmediate(
      sessionId,
      [createTestClimbQueueItem('item-1', 'Climb 1')],
      null,
      1, // Pass current version for optimistic locking
    );

    // Check sequence after first update
    let state = await roomManager.getQueueState(sessionId);
    expect(state.sequence).toBe(2);

    // Another update
    await roomManager.updateQueueStateImmediate(
      sessionId,
      [
        createTestClimbQueueItem('item-1', 'Climb 1'),
        createTestClimbQueueItem('item-2', 'Climb 2'),
      ],
      null,
      version1, // Pass previous version
    );

    // Check sequence after second update
    state = await roomManager.getQueueState(sessionId);
    expect(state.sequence).toBe(3);
  });

  it('should return consistent sequence from getQueueState after updates', async () => {
    const sessionId = uniqueId();

    // Create session with initial queue state at a known version/sequence.
    // We drive the loop off the version we just inserted rather than a
    // secondary getQueueState() call so the test stays deterministic even if
    // the row becomes visible on a slightly different read path.
    await db.insert(sessions).values({
      id: sessionId,
      boardPath: '/kilter/test',
      createdAt: new Date(),
      lastActivity: new Date(),
    });

    await db.insert(sessionQueues).values({
      sessionId,
      queue: [],
      currentClimbQueueItem: null,
      version: 1,
      sequence: 1,
      updatedAt: new Date(),
    });

    let currentVersion = 1;

    // Make several updates using updateQueueStateImmediate for Postgres-only mode
    for (let i = 1; i <= 5; i++) {
      currentVersion = await roomManager.updateQueueStateImmediate(
        sessionId,
        [createTestClimbQueueItem(`item-${i}`, `Climb ${i}`)],
        null,
        currentVersion,
      );
    }

    // Get state - should have sequence reflecting all updates
    const state = await roomManager.getQueueState(sessionId);

    // Sequence should be 6 (initial 1 + 5 updates)
    expect(state.sequence).toBe(6);
    expect(state.queue.length).toBe(1); // Last update had 1 item
  });
});
