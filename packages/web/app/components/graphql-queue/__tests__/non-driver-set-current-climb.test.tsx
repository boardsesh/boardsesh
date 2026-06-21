import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Climb } from '@/app/lib/types';
import type { ClimbQueueItem } from '../../queue-control/types';

// Always-live model: the bar's prev/next button is reachable by every session
// participant. The bar calls `setCurrentClimbQueueItem`, which routes to
// `persistentSession.setCurrentClimb`. Backend `setCurrentClimb` is unrestricted
// (no isLeader / driver gate). Test guards against a future regression where the
// client path would start gating the mutation on a role.

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
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

const mockPersistentSessionSetCurrentClimb = vi.fn().mockResolvedValue(undefined);

// Party session active. Local user is `participant-1`. Always-live: no driver
// role; any participant can advance the wall climb.
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
    isLeader: false,
    users: [],
    goal: null,
  },
  isConnecting: false,
  hasConnected: true,
  error: null,
  clientId: 'client-1',
  participantId: 'participant-1',
  isLeader: false,
  users: [],
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
  setCurrentClimb: mockPersistentSessionSetCurrentClimb,
  mirrorCurrentClimb: vi.fn().mockResolvedValue(undefined),
  setQueue: vi.fn().mockResolvedValue(undefined),
  replaceQueueItem: vi.fn().mockResolvedValue(undefined),
  confirmClimbOnWall: vi.fn().mockResolvedValue(undefined),
  reportWallDisconnect: vi.fn().mockResolvedValue(undefined),
  setSessionBoardSerial: vi.fn().mockResolvedValue(undefined),
  offlineBufferRef: { current: [] as unknown[] },
  lastReceivedSequenceRef: { current: null as number | null },
  subscribeToQueueEvents: vi.fn(() => vi.fn()),
  subscribeToSessionEvents: vi.fn(() => vi.fn()),
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
  usePartyProfile: () => ({ profile: { id: 'user-1' }, username: 'tester', avatarUrl: undefined }),
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

function makeClimb(uuid: string): Climb {
  return {
    uuid,
    setter_username: 'setter',
    name: `Climb ${uuid}`,
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
}

const defaultProps = {
  parsedParams: {
    board_name: 'kilter',
    layout_id: '1',
    size_id: '1',
    set_ids: ['1'],
    angle: '40',
  } as never,
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
  } as never,
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

describe('Any-participant setCurrentClimbQueueItem (bar prev/next)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes through persistentSession.setCurrentClimb for any session participant', () => {
    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    // Sanity: this client is in a party session.
    expect(result.current.isPersistentSessionActive).toBe(true);
    expect(result.current.participantId).toBe('participant-1');

    const targetItem: ClimbQueueItem = {
      uuid: 'queue-item-1',
      climb: makeClimb('target-climb'),
      suggested: false,
    };

    act(() => {
      result.current.setCurrentClimbQueueItem(targetItem);
    });

    // The mutation fires for any participant (always-live, no driver gate). If
    // a regression re-added a role gate to setCurrentClimbQueueItem, this would
    // fail. Backend `setCurrentClimb` resolver doesn't gate either, so the wire
    // call goes through end-to-end.
    expect(mockPersistentSessionSetCurrentClimb).toHaveBeenCalledTimes(1);
    const [calledItem, shouldAddToQueue, correlationId] = mockPersistentSessionSetCurrentClimb.mock.calls[0];
    expect(calledItem.uuid).toBe(targetItem.uuid);
    expect(calledItem.climb.uuid).toBe(targetItem.climb.uuid);
    expect(shouldAddToQueue).toBe(false); // suggested: false on the input
    expect(correlationId).toMatch(/^client-1-\d+$/);
  });
});
