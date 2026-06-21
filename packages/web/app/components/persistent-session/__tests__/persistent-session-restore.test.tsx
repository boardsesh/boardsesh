import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getPreference, setPreference, removePreference } from '@/app/lib/user-preferences-db';
import type { BoardDetails } from '@/app/lib/types';
import { PersistentSessionProvider, usePersistentSession } from '../persistent-session-context';

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

// Mock the HTTP GraphQL client used by the auto-finished pre-flight. Default
// response is seeded in beforeEach so individual tests can override with
// mockResolvedValue / mockResolvedValueOnce without leaking across cases.
const { mockHttpRequest } = vi.hoisted(() => ({
  mockHttpRequest: vi.fn(),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: vi.fn(() => ({
    request: mockHttpRequest,
  })),
}));

function buildSessionSummary(overrides?: { sessionId?: string; endedAt?: string | null }) {
  return {
    sessionId: 'mocked',
    endedAt: null,
    startedAt: null,
    durationMinutes: 0,
    totalSends: 0,
    totalAttempts: 0,
    gradeDistribution: [],
    hardestClimb: null,
    participants: [],
    goal: null,
    ...overrides,
  };
}

// Mock auth token hook — mutable so tests can simulate the loading window.
const { mockWsAuth } = vi.hoisted(() => ({
  mockWsAuth: { token: 'test-token' as string | null, isLoading: false },
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => mockWsAuth,
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

const expectSession = (actual: unknown, expected: object) => {
  expect(actual).toMatchObject(expected);
};

function createWrapper() {
  // Fresh QueryClient per test so cached session-detail entries don't leak
  // across cases. PersistentSessionProvider's useEventProcessor calls
  // useQueryClient(), so the provider must be in scope.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <PersistentSessionProvider>{children}</PersistentSessionProvider>
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Default: pre-flight returns a still-active session, auth is loaded
  mockHttpRequest.mockReset();
  mockHttpRequest.mockResolvedValue({ sessionSummary: buildSessionSummary() });
  mockWsAuth.token = 'test-token';
  mockWsAuth.isLoading = false;

  // Reset the climb-session cookie so cookie state doesn't leak between tests.
  document.cookie = 'boardsesh-climb-session-id=; path=/; SameSite=Lax; max-age=0';

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
      parsedParams: {
        board_name: 'kilter' as const,
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
        angle: 40,
      },
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
    const { result } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

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
      parsedParams: {
        board_name: 'kilter' as const,
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
        angle: 40,
      },
    };

    await setPreference(ACTIVE_SESSION_KEY, sessionInfo);

    const { result } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLocalQueueLoaded).toBe(true);
    });

    // Party session should be active
    expectSession(result.current.activeSession, sessionInfo);
    // Local queue should be empty (no IndexedDB persistence)
    expect(result.current.localQueue).toEqual([]);
  });

  it('activateSession persists to IndexedDB', async () => {
    const { result } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLocalQueueLoaded).toBe(true);
    });

    const sessionInfo = {
      sessionId: 'new-session',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails: createTestBoardDetails(),
      parsedParams: {
        board_name: 'kilter' as const,
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
        angle: 40,
      },
    };

    act(() => {
      result.current.activateSession(sessionInfo);
    });

    // Wait for the async persistence to complete
    await waitFor(async () => {
      const stored = await getPreference(ACTIVE_SESSION_KEY);
      expectSession(stored, sessionInfo);
    });
  });

  it('surfaces the finished-session dialog when the backend has auto-ended the persisted session', async () => {
    const boardDetails = createTestBoardDetails();
    const sessionInfo = {
      sessionId: 'session-stale',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails,
      parsedParams: {
        board_name: 'kilter' as const,
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
        angle: 40,
      },
    };
    await setPreference(ACTIVE_SESSION_KEY, sessionInfo);

    const autoFinishedSummary = {
      sessionId: 'session-stale',
      endedAt: '2026-05-11T09:00:00.000Z',
      startedAt: '2026-05-11T07:30:00.000Z',
      durationMinutes: 90,
      totalSends: 3,
      totalAttempts: 7,
      gradeDistribution: [],
      hardestClimb: null,
      participants: [],
      goal: null,
    };
    mockHttpRequest.mockResolvedValueOnce({ sessionSummary: autoFinishedSummary });

    const { result } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.sessionSummaryAutoFinished).toBe(true);
    });

    expect(result.current.sessionSummary).toEqual(autoFinishedSummary);
    expect(result.current.sessionSummaryBoardType).toBe('kilter');
    expect(result.current.activeSession).toBeNull();

    await waitFor(async () => {
      const stored = await getPreference(ACTIVE_SESSION_KEY);
      expect(stored).toBeNull();
    });
  });

  it('falls through to normal activation when the auto-finished pre-flight rejects', async () => {
    const sessionInfo = {
      sessionId: 'session-network-flake',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails: createTestBoardDetails(),
      parsedParams: {
        board_name: 'kilter' as const,
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
        angle: 40,
      },
    };
    await setPreference(ACTIVE_SESSION_KEY, sessionInfo);
    mockHttpRequest.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

    await waitFor(() => {
      expectSession(result.current.activeSession, sessionInfo);
    });

    expect(result.current.sessionSummaryAutoFinished).toBe(false);
    expect(result.current.sessionSummary).toBeNull();

    const stored = await getPreference(ACTIVE_SESSION_KEY);
    expectSession(stored, sessionInfo);
  });

  it('waits for auth to load before running mount pre-flight', async () => {
    mockWsAuth.token = null;
    mockWsAuth.isLoading = true;
    mockHttpRequest.mockResolvedValue({
      sessionSummary: buildSessionSummary({ endedAt: '2026-05-04T12:00:00.000Z' }),
    });

    const sessionInfo = {
      sessionId: 'session-stale-on-load',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails: createTestBoardDetails(),
      parsedParams: {
        board_name: 'kilter' as const,
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
        angle: 40,
      },
    };
    await setPreference(ACTIVE_SESSION_KEY, sessionInfo);

    const { result, rerender } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

    // While auth is loading, neither activation nor pre-flight should fire.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current.activeSession).toBeNull();
    expect(result.current.sessionSummaryAutoFinished).toBe(false);
    expect(mockHttpRequest).not.toHaveBeenCalled();

    // Auth resolves — pre-flight fires, dialog opens.
    mockWsAuth.token = 'test-token';
    mockWsAuth.isLoading = false;
    rerender();

    await waitFor(() => {
      expect(result.current.sessionSummaryAutoFinished).toBe(true);
      expect(result.current.activeSession).toBeNull();
      expect(result.current.sessionSummary?.endedAt).toBe('2026-05-04T12:00:00.000Z');
    });

    const stored = await getPreference(ACTIVE_SESSION_KEY);
    expect(stored).toBeNull();
  });

  it('runs the auto-finished pre-flight exactly once across rapid re-renders after auth resolves', async () => {
    // Regression guard: previously the inline arrow passed as `setActiveSession`
    // to `useQueueStorage` was reborn each render. The restore effect listed
    // that callback in its deps, so rapid re-renders between `isAuthLoading`
    // flipping false and `hasRunPreflightRef` being set could fire multiple
    // concurrent `restoreState()` calls (one pre-flight per render).
    mockWsAuth.token = null;
    mockWsAuth.isLoading = true;
    mockHttpRequest.mockResolvedValue({ sessionSummary: buildSessionSummary() });

    const sessionInfo = {
      sessionId: 'session-race-guard',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails: createTestBoardDetails(),
      parsedParams: {
        board_name: 'kilter' as const,
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
        angle: 40,
      },
    };
    await setPreference(ACTIVE_SESSION_KEY, sessionInfo);

    const { result, rerender } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

    // Auth resolves; force several synchronous re-renders before the
    // pre-flight promise resolves to maximise the window in which a fresh
    // `setActiveSession` reference could re-fire the restore effect.
    mockWsAuth.token = 'test-token';
    mockWsAuth.isLoading = false;
    rerender();
    rerender();
    rerender();
    rerender();

    await waitFor(() => {
      expectSession(result.current.activeSession, sessionInfo);
    });

    expect(mockHttpRequest).toHaveBeenCalledTimes(1);
  });

  it('re-checks staleness on visibilitychange and surfaces the auto-finished dialog', async () => {
    const sessionInfo = {
      sessionId: 'session-stale-on-return',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails: createTestBoardDetails(),
      parsedParams: {
        board_name: 'kilter' as const,
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
        angle: 40,
      },
    };
    await setPreference(ACTIVE_SESSION_KEY, sessionInfo);

    const { result } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

    // First mount: pre-flight says still-active, session is restored.
    await waitFor(() => {
      expectSession(result.current.activeSession, sessionInfo);
    });
    expect(result.current.sessionSummaryAutoFinished).toBe(false);

    // Backend ends the session while the tab is in the background.
    mockHttpRequest.mockResolvedValue({
      sessionSummary: buildSessionSummary({ endedAt: '2026-05-04T12:00:00.000Z' }),
    });

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => {
      expect(result.current.activeSession).toBeNull();
      expect(result.current.sessionSummary?.endedAt).toBe('2026-05-04T12:00:00.000Z');
      expect(result.current.sessionSummaryAutoFinished).toBe(true);
      expect(result.current.sessionSummaryBoardType).toBe('kilter');
    });

    // IndexedDB should be cleared too.
    const stored = await getPreference(ACTIVE_SESSION_KEY);
    expect(stored).toBeNull();
  });

  it('deactivateSession clears from IndexedDB', async () => {
    // Pre-populate a persisted session
    const sessionInfo = {
      sessionId: 'to-deactivate',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails: createTestBoardDetails(),
      parsedParams: {
        board_name: 'kilter' as const,
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
        angle: 40,
      },
    };
    await setPreference(ACTIVE_SESSION_KEY, sessionInfo);

    const { result } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

    await waitFor(() => {
      expectSession(result.current.activeSession, sessionInfo);
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

// ---------------------------------------------------------------------------
// Tests: Stale IndexedDB session vs. fresh /join cookie
// ---------------------------------------------------------------------------

describe('Stale IndexedDB vs fresh /join cookie', () => {
  function setClimbCookie(sessionId: string) {
    document.cookie = `boardsesh-climb-session-id=${encodeURIComponent(sessionId)}; path=/; SameSite=Lax; max-age=86400`;
  }

  it('skips activation when the cookie has a different sessionId and leaves IndexedDB intact', async () => {
    const stale = {
      sessionId: 'session-A-old',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails: createTestBoardDetails(),
      parsedParams: {
        board_name: 'kilter' as const,
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
        angle: 40,
      },
    };
    await setPreference(ACTIVE_SESSION_KEY, stale);
    setClimbCookie('session-B-fresh');

    const { result } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLocalQueueLoaded).toBe(true);
    });

    expect(result.current.activeSession).toBeNull();

    // IndexedDB is preserved — BoardSessionBridge overwrites on a successful join, and an unvalidated cookie (e.g. legacy ?session= migration) can still fall back to the persisted entry.
    const stored = await getPreference(ACTIVE_SESSION_KEY);
    expectSession(stored, stale);

    expect(mockHttpRequest).not.toHaveBeenCalled();
  });

  it('restores normally when the cookie matches the persisted sessionId', async () => {
    const sessionInfo = {
      sessionId: 'session-match',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails: createTestBoardDetails(),
      parsedParams: {
        board_name: 'kilter' as const,
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
        angle: 40,
      },
    };
    await setPreference(ACTIVE_SESSION_KEY, sessionInfo);
    setClimbCookie('session-match');

    const { result } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

    await waitFor(() => {
      expectSession(result.current.activeSession, sessionInfo);
    });

    const stored = await getPreference(ACTIVE_SESSION_KEY);
    expectSession(stored, sessionInfo);
  });

  it('restores normally when no cookie is set (legacy reload path)', async () => {
    // No cookie — fresh page reload with no /join interaction. The persisted
    // session is the only signal we have, so it should be restored.
    const sessionInfo = {
      sessionId: 'session-no-cookie',
      boardPath: '/kilter/1/10/1,2/40/list',
      boardDetails: createTestBoardDetails(),
      parsedParams: {
        board_name: 'kilter' as const,
        layout_id: 1,
        size_id: 10,
        set_ids: [1, 2],
        angle: 40,
      },
    };
    await setPreference(ACTIVE_SESSION_KEY, sessionInfo);

    const { result } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

    await waitFor(() => {
      expectSession(result.current.activeSession, sessionInfo);
    });

    const stored = await getPreference(ACTIVE_SESSION_KEY);
    expectSession(stored, sessionInfo);
  });
});
