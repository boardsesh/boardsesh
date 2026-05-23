import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionEvent } from '@boardsesh/shared-schema';
import type { BoardDetails, ParsedBoardRouteParameters } from '@/app/lib/types';

// --- Mocks must come before importing GraphQLQueueProvider ---

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/kilter/1/1/1/40',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('../../queue-control/hooks/use-queue-data-fetching', () => ({
  useQueueDataFetching: () => ({
    climbSearchResults: null,
    suggestedClimbs: [],
    totalSearchResultCount: 0,
    hasMoreResults: false,
    isFetchingClimbs: false,
    isFetchingNextPage: false,
    fetchMoreClimbs: vi.fn(),
    climbUuids: [],
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    // Echo the key + placeholders so assertions can match without loading the
    // real catalog. Keeps the test independent of copy churn.
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      let out = key;
      for (const [k, v] of Object.entries(options)) {
        out = `${out}|${k}=${String(v)}`;
      }
      return out;
    },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

const sessionEventSubscribers = new Set<(event: SessionEvent) => void>();
function emitSessionEvent(event: SessionEvent) {
  sessionEventSubscribers.forEach((cb) => cb(event));
}

const mockPersistentSession = {
  activeSession: {
    sessionId: 'session-1',
    boardPath: '/kilter/1/1/1/40',
    boardDetails: {},
    parsedParams: {},
  } as {
    sessionId: string;
    boardPath: string;
    boardDetails: unknown;
    parsedParams: unknown;
  } | null,
  session: {
    clientId: 'client-1',
    participantId: 'participant-1',
    isLeader: true,
    users: [
      { id: 'participant-1', username: 'Alice', isLeader: true },
      { id: 'participant-2', username: 'Bob', isLeader: false },
      { id: 'participant-3', username: 'Carol', isLeader: false },
    ],
    goal: null,
  },
  isConnecting: false,
  hasConnected: true,
  error: null,
  clientId: 'client-1',
  participantId: 'participant-1',
  isLeader: true,
  driverParticipantId: null as string | null,
  users: [
    { id: 'participant-1', username: 'Alice', isLeader: true, connectionState: 'connected' },
    { id: 'participant-2', username: 'Bob', isLeader: false, connectionState: 'connected' },
    { id: 'participant-3', username: 'Carol', isLeader: false, connectionState: 'connected' },
  ],
  currentClimbQueueItem: null,
  queue: [],
  localQueue: [],
  localCurrentClimbQueueItem: null,
  localBoardPath: null,
  localBoardDetails: null,
  isLocalQueueLoaded: true,
  setLocalQueueState: vi.fn(),
  clearLocalQueue: vi.fn(),
  activateSession: vi.fn(),
  deactivateSession: vi.fn(),
  setInitialQueueForSession: vi.fn(),
  addQueueItem: vi.fn().mockResolvedValue(undefined),
  removeQueueItem: vi.fn().mockResolvedValue(undefined),
  setCurrentClimb: vi.fn().mockResolvedValue(undefined),
  mirrorCurrentClimb: vi.fn().mockResolvedValue(undefined),
  setQueue: vi.fn().mockResolvedValue(undefined),
  replaceQueueItem: vi.fn().mockResolvedValue(undefined),
  takeControl: vi.fn().mockResolvedValue(undefined),
  releaseControl: vi.fn().mockResolvedValue(undefined),
  confirmClimbOnWall: vi.fn().mockResolvedValue(undefined),
  setSessionBoardSerial: vi.fn().mockResolvedValue(undefined),
  offlineBufferRef: { current: [] as unknown[] },
  lastReceivedSequenceRef: { current: null as number | null },
  subscribeToQueueEvents: vi.fn(() => vi.fn()),
  subscribeToSessionEvents: vi.fn((cb: (event: SessionEvent) => void) => {
    sessionEventSubscribers.add(cb);
    return () => sessionEventSubscribers.delete(cb);
  }),
  triggerResync: vi.fn(),
  endSessionWithSummary: vi.fn(),
  sessionSummary: null,
  sessionSummaryBoardType: null,
  sessionSummaryHealthKitWorkoutId: null,
  sessionSummaryAutoFinished: false,
  setAutoFinishedSummary: vi.fn(),
  dismissSessionSummary: vi.fn(),
};

vi.mock('../../connection-manager/websocket-connection-provider', () => ({
  useWebSocketConnection: () => ({ state: 'connected', name: 'session' }),
}));

vi.mock('../../party-manager/party-profile-context', () => ({
  usePartyProfile: () => ({ profile: { id: 'user-1' }, username: 'Alice', avatarUrl: undefined }),
}));

vi.mock('../../connection-manager/connection-settings-context', () => ({
  useConnectionSettings: () => ({ backendUrl: 'wss://example.com/graphql' }),
}));

vi.mock('../../persistent-session', () => ({
  usePersistentSession: () => mockPersistentSession,
  usePersistentSessionState: () => mockPersistentSession,
  usePersistentSessionActions: () => mockPersistentSession,
  PersistentSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../climb-actions/favorites-batch-context', () => ({
  FavoritesProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('../../climb-actions/playlists-batch-context', () => ({
  PlaylistsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/app/hooks/use-climb-actions-data', () => ({
  useClimbActionsData: () => ({ favoritesProviderProps: {}, playlistsProviderProps: {} }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'mock-token', isLoading: false }),
}));

vi.mock('@/app/lib/climb-session-cookie', () => ({
  getClimbSessionCookie: () => 'session-1',
  setClimbSessionCookie: vi.fn(),
  clearClimbSessionCookie: vi.fn(),
}));

vi.mock('@/app/lib/session-history-db', () => ({ saveSessionToHistory: vi.fn() }));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: vi.fn(() => ({ request: vi.fn() })),
}));

vi.mock('../../session-summary/session-summary-dialog', () => ({ default: () => null }));

// Import AFTER mocks
import { GraphQLQueueProvider, useQueueContext } from '../QueueContext';

const defaultProps = {
  parsedParams: {
    board_name: 'kilter',
    layout_id: '1',
    size_id: '1',
    set_ids: ['1'],
    angle: '40',
  } as unknown as ParsedBoardRouteParameters,
  boardDetails: {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 1,
    set_ids: '1',
    images_to_holds: {},
    layout_name: 'Original',
    size_name: '12x12',
    size_description: 'Standard',
    set_names: ['Base'],
    edge_left: 0,
    edge_right: 0,
    edge_bottom: 0,
    edge_top: 0,
  } as unknown as BoardDetails,
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <GraphQLQueueProvider {...defaultProps}>{children}</GraphQLQueueProvider>
      </QueryClientProvider>
    );
  };
}

describe('driver hand-off toast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionEventSubscribers.clear();
    mockPersistentSession.driverParticipantId = null;
    mockPersistentSession.participantId = 'participant-1';
    mockShowMessage.mockClear();
  });

  it('fires firstDriver copy when someone else takes the wall and there was no previous driver', () => {
    renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    act(() => {
      emitSessionEvent({
        __typename: 'DriverChanged',
        driverParticipantId: 'participant-2',
        previousDriverParticipantId: null,
      });
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      expect.stringContaining('driverToast.firstDriver|newDriver=Bob'),
      'info',
    );
  });

  it('fires tookFromYou copy when someone else takes the wall away from the local user', () => {
    renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    act(() => {
      emitSessionEvent({
        __typename: 'DriverChanged',
        driverParticipantId: 'participant-2',
        previousDriverParticipantId: 'participant-1',
      });
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      expect.stringContaining('driverToast.tookFromYou|newDriver=Bob'),
      'info',
    );
  });

  it('fires tookFromOther copy when the local user is uninvolved in the hand-off', () => {
    renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    act(() => {
      emitSessionEvent({
        __typename: 'DriverChanged',
        driverParticipantId: 'participant-2',
        previousDriverParticipantId: 'participant-3',
      });
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      expect.stringContaining('driverToast.tookFromOther|newDriver=Bob|previousDriver=Carol'),
      'info',
    );
  });

  it('suppresses the toast when the local user is the new driver', () => {
    renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    act(() => {
      emitSessionEvent({
        __typename: 'DriverChanged',
        driverParticipantId: 'participant-1',
        previousDriverParticipantId: 'participant-2',
      });
    });

    expect(mockShowMessage).not.toHaveBeenCalled();
  });

  it('suppresses the toast when control is released without a successor', () => {
    renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    act(() => {
      emitSessionEvent({
        __typename: 'DriverChanged',
        driverParticipantId: null,
        previousDriverParticipantId: 'participant-2',
      });
    });

    expect(mockShowMessage).not.toHaveBeenCalled();
  });

  it('substitutes "Someone" for an unresolved previous driver instead of suppressing the toast', () => {
    renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    // previousDriverParticipantId references a user who has already left the
    // session — `users.find()` returns undefined. The toast still fires with
    // the unknownDriver fallback rather than dropping attribution silently.
    act(() => {
      emitSessionEvent({
        __typename: 'DriverChanged',
        driverParticipantId: 'participant-2',
        previousDriverParticipantId: 'participant-ghost',
      });
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      expect.stringContaining('driverToast.tookFromOther|newDriver=Bob|previousDriver=driverToast.unknownDriver'),
      'info',
    );
  });

  it('uses firstDriver copy when BOTH peers are unresolved, avoiding "Someone took the wall from Someone."', () => {
    renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    // Pathological case: neither the new nor the previous driver has
    // propagated into the users list. Two anonymous slots in tookFromOther
    // reads degenerate — fall back to the simpler firstDriver phrasing.
    act(() => {
      emitSessionEvent({
        __typename: 'DriverChanged',
        driverParticipantId: 'participant-ghost-new',
        previousDriverParticipantId: 'participant-ghost-old',
      });
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      expect.stringContaining('driverToast.firstDriver|newDriver=driverToast.unknownDriver'),
      'info',
    );
    expect(mockShowMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('driverToast.tookFromOther'),
      expect.anything(),
    );
  });

  it('still fires tookFromYou when the new driver has not propagated into the users list yet', () => {
    renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    // The new driver's id arrives before they show up in `users` (distributed-
    // state propagation reordering). The local user just lost the wall — they
    // must still get the toast, with "Someone" substituted for the unresolved
    // peer name. See PR #2249 review.
    act(() => {
      emitSessionEvent({
        __typename: 'DriverChanged',
        driverParticipantId: 'participant-ghost',
        previousDriverParticipantId: 'participant-1',
      });
    });

    expect(mockShowMessage).toHaveBeenCalledWith(
      expect.stringContaining('driverToast.tookFromYou|newDriver=driverToast.unknownDriver'),
      'info',
    );
  });
});
