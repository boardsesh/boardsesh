import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// --- Mocks must be before imports ---

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/kilter/1/1/1/40',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

const mockAddQueueItem = vi.fn().mockResolvedValue(undefined);
const mockRemoveQueueItem = vi.fn().mockResolvedValue(undefined);
const mockSetCurrentClimb = vi.fn().mockResolvedValue(undefined);
const mockSetQueue = vi.fn().mockResolvedValue(undefined);
const mockMirrorCurrentClimb = vi.fn().mockResolvedValue(undefined);

const mockPersistentSession = {
  activeSession: { sessionId: 'session-1', boardPath: '/kilter/1/1/1/40', boardDetails: {}, parsedParams: {} } as { sessionId: string; boardPath: string; boardDetails: unknown; parsedParams: unknown } | null,
  session: { clientId: 'client-1', isLeader: true, users: [], goal: null },
  isConnecting: false,
  hasConnected: true,
  error: null,
  clientId: 'client-1',
  isLeader: true,
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
  addQueueItem: mockAddQueueItem,
  removeQueueItem: mockRemoveQueueItem,
  setCurrentClimb: mockSetCurrentClimb,
  mirrorCurrentClimb: mockMirrorCurrentClimb,
  setQueue: mockSetQueue,
  offlineBufferRef: { current: [] as unknown[] },
  lastReceivedSequenceRef: { current: null as number | null },
  subscribeToQueueEvents: vi.fn(() => vi.fn()),
  subscribeToSessionEvents: vi.fn(() => vi.fn()),
  triggerResync: vi.fn(),
  endSessionWithSummary: vi.fn(),
  liveSessionStats: null,
  sessionSummary: null,
  dismissSessionSummary: vi.fn(),
};

let mockConnectionState = 'connected' as string;
vi.mock('../../connection-manager/websocket-connection-provider', () => ({
  useWebSocketConnection: () => ({
    state: mockConnectionState,
    name: 'session',
  }),
}));

vi.mock('../../party-manager/party-profile-context', () => ({
  usePartyProfile: () => ({
    profile: { id: 'user-1' },
    username: 'tester',
    avatarUrl: undefined,
  }),
}));

vi.mock('../../connection-manager/connection-settings-context', () => ({
  useConnectionSettings: () => ({
    backendUrl: 'wss://example.com/graphql',
  }),
}));

vi.mock('../../persistent-session', () => ({
  usePersistentSession: () => mockPersistentSession,
  usePersistentSessionState: () => mockPersistentSession,
  usePersistentSessionActions: () => mockPersistentSession,
  PersistentSessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../climb-actions/favorites-batch-context', () => ({
  FavoritesProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../climb-actions/playlists-batch-context', () => ({
  PlaylistsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/app/hooks/use-climb-actions-data', () => ({
  useClimbActionsData: () => ({
    favoritesProviderProps: {},
    playlistsProviderProps: {},
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'mock-token', isLoading: false }),
}));

let mockSessionCookie: string | null = 'session-1';
vi.mock('@/app/lib/climb-session-cookie', () => ({
  getClimbSessionCookie: () => mockSessionCookie,
  setClimbSessionCookie: vi.fn(),
  clearClimbSessionCookie: vi.fn(),
}));

vi.mock('@/app/lib/session-history-db', () => ({
  saveSessionToHistory: vi.fn(),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: vi.fn(() => ({ request: vi.fn() })),
}));

vi.mock('../session-summary/session-summary-dialog', () => ({
  default: () => null,
}));

// Import after all mocks
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GraphQLQueueProvider, useQueueContext } from '../QueueContext';
import type { Climb } from '@/app/lib/types';

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

const mockClimb2: Climb = {
  ...mockClimb,
  uuid: 'climb-2',
  name: 'Test Climb 2',
};

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
        <GraphQLQueueProvider {...defaultProps}>
          {children}
        </GraphQLQueueProvider>
      </QueryClientProvider>
    );
  };
}

describe('QueueContext offline mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionState = 'connected';
    mockPersistentSession.hasConnected = true;
  });

  describe('when online in party mode', () => {
    it('addToQueue calls persistentSession.addQueueItem', () => {
      const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

      act(() => {
        result.current.addToQueue(mockClimb);
      });

      expect(mockAddQueueItem).toHaveBeenCalledTimes(1);
    });

    it('removeFromQueue calls persistentSession.removeQueueItem', () => {
      const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

      // First add an item so we can remove it
      act(() => {
        result.current.addToQueue(mockClimb);
      });

      const queueItem = result.current.queue[0];

      act(() => {
        result.current.removeFromQueue(queueItem);
      });

      expect(mockRemoveQueueItem).toHaveBeenCalledWith(queueItem.uuid);
    });

    it('isDisconnected is false', () => {
      const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });
      expect(result.current.isDisconnected).toBe(false);
    });
  });

  describe('when offline in party mode', () => {
    beforeEach(() => {
      mockConnectionState = 'reconnecting';
    });

    it('isDisconnected is true', () => {
      const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });
      expect(result.current.isDisconnected).toBe(true);
    });

    it('addToQueue applies locally but does NOT call persistentSession.addQueueItem', () => {
      const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

      act(() => {
        result.current.addToQueue(mockClimb);
      });

      // Item should be in queue locally
      expect(result.current.queue.length).toBeGreaterThanOrEqual(1);
      expect(result.current.queue.some(item => item.climb.uuid === mockClimb.uuid)).toBe(true);

      // Should NOT have called the server
      expect(mockAddQueueItem).not.toHaveBeenCalled();
    });

    it('removeFromQueue applies locally but does NOT call persistentSession.removeQueueItem', () => {
      // Start online, add item, then go offline and remove
      mockConnectionState = 'connected';
      const { result, rerender } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

      act(() => {
        result.current.addToQueue(mockClimb);
      });

      const queueItem = result.current.queue[0];
      mockAddQueueItem.mockClear();

      // Go offline
      mockConnectionState = 'reconnecting';
      rerender();

      act(() => {
        result.current.removeFromQueue(queueItem);
      });

      expect(mockRemoveQueueItem).not.toHaveBeenCalled();
    });

    it('setQueue (reorder) applies locally but does NOT call persistentSession.setQueue', () => {
      // Start fully offline - the queue will already have items from setup
      const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

      act(() => {
        result.current.setQueue([]);
      });

      expect(mockSetQueue).not.toHaveBeenCalled();
    });

    it('mirrorClimb applies locally but does NOT call persistentSession.mirrorCurrentClimb', () => {
      const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

      // Set a current climb - this is offline so it won't call server
      act(() => {
        result.current.setCurrentClimbQueueItem({
          uuid: 'item-1',
          climb: mockClimb,
          addedBy: 'client-1',
          suggested: false,
        });
      });

      act(() => {
        result.current.mirrorClimb();
      });

      expect(mockMirrorCurrentClimb).not.toHaveBeenCalled();
    });
  });

  describe('when offline in solo mode (no session)', () => {
    beforeEach(() => {
      mockConnectionState = 'idle';
      mockSessionCookie = null;
      mockPersistentSession.activeSession = null;
      mockPersistentSession.hasConnected = false;
    });

    afterEach(() => {
      mockSessionCookie = 'session-1';
      mockPersistentSession.activeSession = {
        sessionId: 'session-1',
        boardPath: '/kilter/1/1/1/40',
        boardDetails: {} as never,
        parsedParams: {} as never,
      };
      mockPersistentSession.hasConnected = true;
    });

    it('addToQueue applies locally without calling persistentSession', () => {
      const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

      act(() => {
        result.current.addToQueue(mockClimb);
      });

      expect(result.current.queue.some(item => item.climb.uuid === mockClimb.uuid)).toBe(true);
      expect(mockAddQueueItem).not.toHaveBeenCalled();
    });
  });
});
