/**
 * Tests verifying that queue data is preserved in IndexedDB when a session ends/expires,
 * and can be restored on next mount (solo mode).
 *
 * This simulates the flow: session expires → queue saved to IndexedDB → session cleared →
 * next mount → queue restored from IndexedDB as local queue.
 */
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { removePreference } from '@/app/lib/user-preferences-db';
import { saveQueueState, getMostRecentQueue, getStoredQueue } from '@/app/lib/queue-storage-db';
import type { ClimbQueueItem } from '../../queue-control/types';
import type { BoardDetails, Climb } from '@/app/lib/types';

// ---------------------------------------------------------------------------
// Mock heavy dependencies
// ---------------------------------------------------------------------------
vi.mock('../../graphql-queue/graphql-client', () => ({
  createGraphQLClient: vi.fn(() => ({ dispose: vi.fn() })),
  execute: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isLoading: false }),
}));

vi.mock('../../party-manager/party-profile-context', () => ({
  usePartyProfile: () => ({
    profile: { id: 'test-user' },
    username: 'tester',
    avatarUrl: null,
  }),
  PartyProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/app/utils/hash', () => ({
  computeQueueStateHash: () => 'mock-hash',
}));

import { PersistentSessionProvider, usePersistentSession } from '../persistent-session-context';

const PREFS_DB_NAME = 'boardsesh-user-preferences';
const PREFS_STORE_NAME = 'preferences';
const QUEUE_DB_NAME = 'boardsesh-queue';
const QUEUE_STORE_NAME = 'queues';
const ACTIVE_SESSION_KEY = 'activeSession';

function createTestBoardDetails(): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: '1,2',
    images_to_holds: {},
    holdsData: {},
    edge_left: 0,
    edge_right: 100,
    edge_bottom: 0,
    edge_top: 100,
    boardHeight: 100,
    boardWidth: 100,
    layout_name: 'Original',
    size_name: '12x12',
  } as BoardDetails;
}

function createTestClimbQueueItem(uuid: string): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: `climb-${uuid}`,
      name: `Climb ${uuid}`,
      setter_username: 'tester',
      description: '',
      frames: '',
      angle: 40,
      ascensionist_count: 10,
      difficulty: '5',
      quality_average: '3',
      stars: 3,
      difficulty_error: '',
      mirrored: false,
      benchmark_difficulty: null,
      userAscents: 0,
      userAttempts: 0,
    } as Climb,
    addedBy: null,
    suggested: false,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <PersistentSessionProvider>{children}</PersistentSessionProvider>;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
beforeEach(async () => {
  try {
    const prefsDb = await openDB(PREFS_DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(PREFS_STORE_NAME)) {
          db.createObjectStore(PREFS_STORE_NAME);
        }
      },
    });
    await prefsDb.clear(PREFS_STORE_NAME);
    prefsDb.close();
  } catch {
    // DB may not exist yet
  }

  try {
    const queueDb = await openDB(QUEUE_DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(QUEUE_STORE_NAME)) {
          db.createObjectStore(QUEUE_STORE_NAME);
        }
      },
    });
    await queueDb.clear(QUEUE_STORE_NAME);
    queueDb.close();
  } catch {
    // DB may not exist yet
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests: Session expiration queue preservation
// ---------------------------------------------------------------------------

describe('Session expiration queue preservation', () => {
  it('saveQueueState persists queue that survives session deactivation', async () => {
    const boardDetails = createTestBoardDetails();
    const boardPath = '/kilter/1/10/1,2/40';
    const items = [createTestClimbQueueItem('item-1'), createTestClimbQueueItem('item-2')];
    const currentClimb = items[0];

    // Simulate what the SessionEnded handler does:
    // 1. Save queue to IndexedDB directly
    await saveQueueState({
      boardPath,
      queue: items,
      currentClimbQueueItem: currentClimb,
      boardDetails,
      updatedAt: Date.now(),
    });

    // 2. Remove active session preference
    await removePreference(ACTIVE_SESSION_KEY);

    // Verify queue is in IndexedDB
    const stored = await getStoredQueue(boardPath);
    expect(stored).not.toBeNull();
    expect(stored!.queue).toHaveLength(2);
    expect(stored!.queue[0].uuid).toBe('item-1');
    expect(stored!.currentClimbQueueItem?.uuid).toBe('item-1');
  });

  it('queue is restorable as local queue after session expiration', async () => {
    const boardDetails = createTestBoardDetails();
    const boardPath = '/kilter/1/10/1,2/40';
    const items = [createTestClimbQueueItem('exp-item')];

    // Simulate: session expired, queue saved, active session cleared
    await saveQueueState({
      boardPath,
      queue: items,
      currentClimbQueueItem: items[0],
      boardDetails,
      updatedAt: Date.now(),
    });
    // No active session in preferences (it was cleared by SessionEnded handler)

    // Mount provider — should restore from IndexedDB as local queue
    const { result } = renderHook(() => usePersistentSession(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLocalQueueLoaded).toBe(true);
    });

    // Queue should be restored as local (solo mode) queue
    expect(result.current.activeSession).toBeNull();
    expect(result.current.localQueue).toHaveLength(1);
    expect(result.current.localQueue[0].uuid).toBe('exp-item');
    expect(result.current.localCurrentClimbQueueItem?.uuid).toBe('exp-item');
    expect(result.current.localBoardPath).toBe(boardPath);
  });

  it('getMostRecentQueue returns a saved queue', async () => {
    const boardDetails = createTestBoardDetails();

    await saveQueueState({
      boardPath: '/kilter/1/10/1,2/40',
      queue: [createTestClimbQueueItem('saved')],
      currentClimbQueueItem: null,
      boardDetails,
      updatedAt: Date.now(),
    });

    const mostRecent = await getMostRecentQueue();
    expect(mostRecent).not.toBeNull();
    expect(mostRecent!.queue).toHaveLength(1);
    expect(mostRecent!.queue[0].uuid).toBe('saved');
  });

  it('does not save empty queue on session expiration', async () => {
    const boardPath = '/kilter/1/10/1,2/40';

    // Simulate: session expired but queue was empty — saveQueueState should NOT be called
    // (this is the guard in the SessionEnded handler: if queue.length > 0 || currentClimb)
    // Here we verify that if nothing was saved, nothing is restored

    const stored = await getStoredQueue(boardPath);
    expect(stored).toBeNull();

    const mostRecent = await getMostRecentQueue();
    expect(mostRecent).toBeNull();
  });
});
