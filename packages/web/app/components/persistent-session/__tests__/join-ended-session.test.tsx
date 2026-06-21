import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getPreference, setPreference } from '@/app/lib/user-preferences-db';
import type { BoardDetails } from '@/app/lib/types';
import { PersistentSessionProvider, usePersistentSession } from '../persistent-session-context';
import { execute, GraphQLOperationError } from '../../graphql-queue/graphql-client';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the WebSocket/GraphQL layer. `execute` is driven per-test to simulate
// the server refusing an ended-session join. `GraphQLOperationError` is the
// REAL class (the source branches on `instanceof`), pulled from the pure shared
// package so importing it doesn't drag in browser globals.
vi.mock('../../graphql-queue/graphql-client', async () => {
  const shared = await vi.importActual<typeof import('@boardsesh/graphql-client')>('@boardsesh/graphql-client');
  return {
    createGraphQLClient: vi.fn(() => ({ dispose: vi.fn() })),
    execute: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    GraphQLOperationError: shared.GraphQLOperationError,
  };
});

// The real DEFAULT_BACKEND_URL is null in jsdom, which short-circuits the
// connect() effect before it can fire JOIN_SESSION. Override it so the join
// path actually runs in this test.
vi.mock('../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../types')>();
  return { ...actual, DEFAULT_BACKEND_URL: 'ws://localhost:9999/graphql' };
});

// HTTP client used by the mount staleness pre-flight. Default seeded in
// beforeEach to report a still-active session so restore proceeds to connect().
const { mockHttpRequest } = vi.hoisted(() => ({ mockHttpRequest: vi.fn() }));
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: vi.fn(() => ({ request: mockHttpRequest })),
}));

const { mockWsAuth } = vi.hoisted(() => ({
  mockWsAuth: { token: 'test-token' as string | null, isLoading: false },
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => mockWsAuth,
}));

vi.mock('../../party-manager/party-profile-context', () => ({
  usePartyProfile: () => ({ profile: { id: 'test-user' }, username: 'tester', avatarUrl: null }),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVE_SESSION_KEY = 'activeSession';
const PREFS_DB_NAME = 'boardsesh-user-preferences';
const PREFS_STORE_NAME = 'preferences';

function buildSessionSummary(sessionId: string) {
  return {
    sessionId,
    endedAt: null,
    startedAt: null,
    durationMinutes: 0,
    totalSends: 0,
    totalAttempts: 0,
    gradeDistribution: [],
    hardestClimb: null,
    participants: [],
    goal: null,
  };
}

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

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <PersistentSessionProvider>{children}</PersistentSessionProvider>
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  mockHttpRequest.mockReset();
  mockWsAuth.token = 'test-token';
  mockWsAuth.isLoading = false;

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
// Test
// ---------------------------------------------------------------------------

describe('JOIN_SESSION SESSION_ENDED handling (#2696)', () => {
  it('drops the stored session when the server reports the session has ended', async () => {
    const sessionId = 'session-server-ended';
    const sessionInfo = {
      sessionId,
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

    // Pre-flight says still-active, so the provider restores it and opens a WS
    // connection (which fires JOIN_SESSION).
    mockHttpRequest.mockResolvedValue({ sessionSummary: buildSessionSummary(sessionId) });

    // The backend refuses the join: the session was server-ended (#2696).
    vi.mocked(execute).mockRejectedValue(
      new GraphQLOperationError([{ message: 'This session has ended', extensions: { code: 'SESSION_ENDED' } }]),
    );

    const { result } = renderHook(() => usePersistentSession(), { wrapper: createWrapper() });

    // JOIN_SESSION was attempted...
    await waitFor(() => {
      expect(execute).toHaveBeenCalled();
    });

    // ...and the SESSION_ENDED response dropped the stored session instead of
    // resurrecting it.
    await waitFor(() => {
      expect(result.current.activeSession).toBeNull();
    });
    const stored = await getPreference(ACTIVE_SESSION_KEY);
    expect(stored).toBeNull();
  });
});
