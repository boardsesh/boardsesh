import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { getPreference, setPreference, removePreference } from '@/app/lib/user-preferences-db';
import type { BoardDetails } from '@/app/lib/types';

// ---------------------------------------------------------------------------
// Mock heavy dependencies that PersistentSessionProvider relies on
// ---------------------------------------------------------------------------

// Mock the WebSocket/GraphQL layer — we don't want real connections in tests
vi.mock('../../graphql-queue/graphql-client', () => ({
  createGraphQLClient: vi.fn(() => ({
    dispose: vi.fn(),
  })),
  execute: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
}));

// Mock auth token hook
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isLoading: false }),
}));

// Mock party profile
vi.mock('../../party-manager/party-profile-context', () => ({
  usePartyProfile: () => ({
    profile: { id: 'test-user' },
    username: 'tester',
    avatarUrl: null,
  }),
  PartyProfileProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

// Mock hash utility
vi.mock('@/app/utils/hash', () => ({
  computeQueueStateHash: () => 'mock-hash',
}));

// Import AFTER mocks are set up
import { PersistentSessionProvider, usePersistentSession } from '../persistent-session-context';

// ---------------------------------------------------------------------------
// Constants matching the source
// ---------------------------------------------------------------------------
const ACTIVE_SESSION_KEY = 'activeSession';
const PREFS_DB_NAME = 'boardsesh-user-preferences';
const PREFS_STORE_NAME = 'preferences';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestBoardDetails(overrides?: Partial<BoardDetails>): BoardDetails {
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
    ...overrides,
  } as BoardDetails;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <PersistentSessionProvider>{children}</PersistentSessionProvider>;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Clear preferences DB
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests: Session persistence via user-preferences-db
// ---------------------------------------------------------------------------

describe('Active session persistence', () => {
  it('stores and retrieves ActiveSessionInfo via user-preferences-db', async () => {
    const sessionInfo = {
      sessionId: 'session-123',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails: createTestBoardDetails(),
      parsedParams: { board_name: 'kilter' as const, layout_id: 1, size_id: 10, set_ids: [1, 2], angle: 40 },
    };

    await setPreference(ACTIVE_SESSION_KEY, sessionInfo);
    const result = await getPreference(ACTIVE_SESSION_KEY);

    expect(result).toEqual(sessionInfo);
  });

  it('returns null after clearing', async () => {
    await setPreference(ACTIVE_SESSION_KEY, { sessionId: 'test' });
    await removePreference(ACTIVE_SESSION_KEY);

    const result = await getPreference(ACTIVE_SESSION_KEY);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: PersistentSessionProvider mount restore behavior
// ---------------------------------------------------------------------------

describe('PersistentSessionProvider auto-restore on mount', () => {
  it('sets isLocalQueueLoaded=true when no stored data exists', async () => {
    const { result } = renderHook(() => usePersistentSession(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLocalQueueLoaded).toBe(true);
    });

    expect(result.current.localQueue).toEqual([]);
    expect(result.current.localBoardDetails).toBeNull();
    expect(result.current.activeSession).toBeNull();
  });

  it('restores persisted party session on mount', async () => {
    const boardDetails = createTestBoardDetails();
    const sessionInfo = {
      sessionId: 'session-abc',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails,
      parsedParams: { board_name: 'kilter' as const, layout_id: 1, size_id: 10, set_ids: [1, 2], angle: 40 },
    };

    await setPreference(ACTIVE_SESSION_KEY, sessionInfo);

    const { result } = renderHook(() => usePersistentSession(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLocalQueueLoaded).toBe(true);
    });

    // Party session should be active
    expect(result.current.activeSession).toEqual(sessionInfo);
    // Local queue should be empty (no IndexedDB persistence)
    expect(result.current.localQueue).toEqual([]);
  });

  it('activateSession persists to IndexedDB', async () => {
    const { result } = renderHook(() => usePersistentSession(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLocalQueueLoaded).toBe(true);
    });

    const sessionInfo = {
      sessionId: 'new-session',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails: createTestBoardDetails(),
      parsedParams: { board_name: 'kilter' as const, layout_id: 1, size_id: 10, set_ids: [1, 2], angle: 40 },
    };

    act(() => {
      result.current.activateSession(sessionInfo);
    });

    // Wait for the async persistence to complete
    await waitFor(async () => {
      const stored = await getPreference(ACTIVE_SESSION_KEY);
      expect(stored).toEqual(sessionInfo);
    });
  });

  it('deactivateSession clears from IndexedDB', async () => {
    // Pre-populate a persisted session
    const sessionInfo = {
      sessionId: 'to-deactivate',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails: createTestBoardDetails(),
      parsedParams: { board_name: 'kilter' as const, layout_id: 1, size_id: 10, set_ids: [1, 2], angle: 40 },
    };
    await setPreference(ACTIVE_SESSION_KEY, sessionInfo);

    const { result } = renderHook(() => usePersistentSession(), { wrapper });

    await waitFor(() => {
      expect(result.current.activeSession).toEqual(sessionInfo);
    });

    act(() => {
      result.current.deactivateSession();
    });

    expect(result.current.activeSession).toBeNull();

    // Verify IndexedDB was cleared
    await waitFor(async () => {
      const stored = await getPreference(ACTIVE_SESSION_KEY);
      expect(stored).toBeNull();
    });
  });
});
