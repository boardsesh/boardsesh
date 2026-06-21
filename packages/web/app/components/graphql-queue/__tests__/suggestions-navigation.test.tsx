import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Climb } from '@/app/lib/types';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '../../queue-control/types';
import { getPlaylistPeekQueueItemUuid } from '../../queue-control/playlist-suggestions';

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

// Mutable suggestedClimbs so each test seeds its own walk.
let mockSuggestedClimbs: Climb[] = [];
let mockClimbSearchResults: Climb[] | null = null;

vi.mock('../../queue-control/hooks/use-queue-data-fetching', () => ({
  useQueueDataFetching: () => ({
    climbSearchResults: mockClimbSearchResults,
    suggestedClimbs: mockSuggestedClimbs,
    totalSearchResultCount: 0,
    hasMoreResults: false,
    isFetchingClimbs: false,
    isFetchingNextPage: false,
    fetchMoreClimbs: vi.fn(),
    climbUuids: [],
  }),
}));

// Solo (no active party session). Always-live model: every participant walks
// the shared queue / search results; we just need the helper itself to walk
// correctly.
const mockPersistentSession = {
  activeSession: null,
  session: null,
  isConnecting: false,
  hasConnected: false,
  error: null,
  clientId: null,
  participantId: null,
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
  setCurrentClimb: vi.fn().mockResolvedValue(undefined),
  mirrorCurrentClimb: vi.fn().mockResolvedValue(undefined),
  setQueue: vi.fn().mockResolvedValue(undefined),
  replaceQueueItem: vi.fn().mockResolvedValue(undefined),
  reportWallDisconnect: vi.fn().mockResolvedValue(undefined),
  confirmClimbOnWall: vi.fn().mockResolvedValue(undefined),
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
  getClimbSessionCookie: () => null,
  setClimbSessionCookie: vi.fn(),
  clearClimbSessionCookie: vi.fn(),
}));

vi.mock('@/app/lib/session-history-db', () => ({ saveSessionToHistory: vi.fn() }));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: vi.fn(() => ({ request: vi.fn() })),
}));

vi.mock('../../session-summary/session-summary-dialog', () => ({ default: () => null }));

// Import AFTER mocks are wired
import { GraphQLQueueProvider, useQueueContext } from '../QueueContext';

function makeClimb(uuid: string, name: string): Climb {
  return {
    uuid,
    setter_username: 'setter',
    name,
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

describe('getNextClimbQueueItem main-branch climbSearchResults walk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSuggestedClimbs = [];
    mockClimbSearchResults = null;
  });

  it('advances to results[anchorIdx + 1] when the anchor sits mid-list', () => {
    const climbs = [
      makeClimb('search-0', 'A'),
      makeClimb('search-1', 'B'),
      makeClimb('search-2', 'C'),
      makeClimb('search-3', 'D'),
      makeClimb('search-4', 'E'),
    ];
    mockClimbSearchResults = climbs;
    mockSuggestedClimbs = climbs;

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const anchorAtIdx2: ClimbQueueItem = {
      uuid: 'anchor-queue-item',
      climb: climbs[2],
      suggested: false,
    };
    const next = result.current.getNextClimbQueueItem({ from: anchorAtIdx2 });
    expect(next).not.toBeNull();
    expect(next?.climb.uuid).toBe('search-3');
    expect(next?.suggested).toBe(true);
  });

  it('does not oscillate to results[0] on repeated calls with the same anchor', () => {
    const climbs = [makeClimb('search-0', 'A'), makeClimb('search-1', 'B'), makeClimb('search-2', 'C')];
    mockClimbSearchResults = climbs;
    mockSuggestedClimbs = climbs;

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const anchorAtIdx1: ClimbQueueItem = {
      uuid: 'anchor-queue-item',
      climb: climbs[1],
      suggested: false,
    };
    for (let i = 0; i < 3; i++) {
      const next = result.current.getNextClimbQueueItem({ from: anchorAtIdx1 });
      expect(next?.climb.uuid).toBe('search-2');
    }
  });

  it('returns null when the anchor is at the end of the search list and no suggestions remain', () => {
    // With no suggestion fallback available (empty suggestedClimbs), walking
    // off the end of the search list returns null.
    const climbs = [makeClimb('search-0', 'A'), makeClimb('search-1', 'B')];
    mockClimbSearchResults = climbs;
    mockSuggestedClimbs = [];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const anchorAtEnd: ClimbQueueItem = {
      uuid: 'anchor-queue-item',
      climb: climbs[1],
      suggested: false,
    };
    expect(result.current.getNextClimbQueueItem({ from: anchorAtEnd })).toBeNull();
  });

  it('falls back to the first unqueued suggestion when the anchor is at the end of the search list', () => {
    // Cross-search-session continuity: when the position walk hits the end of
    // climbSearchResults, surface the first unqueued suggestion instead of
    // dead-ending. The fallback skips the anchor itself.
    const climbs = [makeClimb('search-0', 'A'), makeClimb('search-1', 'B')];
    const extraSuggestion = makeClimb('suggested-extra', 'S');
    mockClimbSearchResults = climbs;
    mockSuggestedClimbs = [climbs[1], extraSuggestion];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const anchorAtEnd: ClimbQueueItem = {
      uuid: 'anchor-queue-item',
      climb: climbs[1],
      suggested: false,
    };
    const next = result.current.getNextClimbQueueItem({ from: anchorAtEnd });
    expect(next?.climb.uuid).toBe('suggested-extra');
    expect(next?.suggested).toBe(true);
  });

  it('falls back to the first unqueued suggestion when the anchor is not in climbSearchResults', () => {
    // Anchor was added from a previous search session and is no longer in the
    // current results. Position walk returns null; the fallback surfaces a
    // suggestion that isn't the anchor and isn't already queued.
    const searchList = [makeClimb('search-0', 'A'), makeClimb('search-1', 'B')];
    mockClimbSearchResults = searchList;
    mockSuggestedClimbs = searchList;

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const orphanAnchor: ClimbQueueItem = {
      uuid: 'orphan-anchor',
      climb: makeClimb('not-in-results', 'P'),
      suggested: false,
    };
    const next = result.current.getNextClimbQueueItem({ from: orphanAnchor });
    expect(next?.climb.uuid).toBe('search-0');
    expect(next?.suggested).toBe(true);
  });

  it('skips search results that are already in the queue', () => {
    const climbs = [
      makeClimb('search-0', 'A'),
      makeClimb('search-1', 'B'),
      makeClimb('search-2', 'C'),
      makeClimb('search-3', 'D'),
    ];
    mockClimbSearchResults = climbs;
    mockSuggestedClimbs = climbs;

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    // Seed the queue via setCurrentClimbQueueItem with suggested: true so the
    // reducer's DELTA_UPDATE_CURRENT_CLIMB path adds it to state.queue.
    const queuedItem: ClimbQueueItem = {
      uuid: 'queued-search-1',
      climb: climbs[1],
      suggested: true,
    };
    act(() => {
      result.current.setCurrentClimbQueueItem(queuedItem);
    });

    const anchorAtIdx0: ClimbQueueItem = {
      uuid: 'anchor-queue-item',
      climb: climbs[0],
      suggested: false,
    };
    const next = result.current.getNextClimbQueueItem({ from: anchorAtIdx0 });
    expect(next?.climb.uuid).toBe('search-2');
  });

  it('returns null when climbSearchResults is null or empty', () => {
    mockClimbSearchResults = null;
    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const anchor: ClimbQueueItem = {
      uuid: 'anchor-queue-item',
      climb: makeClimb('any', 'X'),
      suggested: false,
    };
    expect(result.current.getNextClimbQueueItem({ from: anchor })).toBeNull();

    mockClimbSearchResults = [];
    const { result: result2 } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });
    expect(result2.current.getNextClimbQueueItem({ from: anchor })).toBeNull();
  });

  // Regression guard: when the user has queued climbs (via the add-to-queue
  // button) but never activated one, currentClimbQueueItem is null. Without
  // an explicit queue[0] short-circuit the Queue bar's Next button would be
  // disabled even though the queue has a climb ready to start.
  it('returns queue[0] when there is no current climb and the queue has items', () => {
    const climbA = makeClimb('queued-0', 'A');
    const climbB = makeClimb('queued-1', 'B');
    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    act(() => {
      result.current.addToQueue(climbA);
      result.current.addToQueue(climbB);
    });

    const next = result.current.getNextClimbQueueItem();
    expect(next).not.toBeNull();
    expect(next?.climb.uuid).toBe('queued-0');
  });

  it('returns null when there is no current climb, the queue is empty, and no suggestions exist', () => {
    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });
    expect(result.current.getNextClimbQueueItem()).toBeNull();
  });

  // Regression guard: cold load with no current climb and no queue but
  // populated suggestions should still expose a Next. Without this fallback
  // the Queue bar's Next button was disabled in that state.
  it('falls back to suggestedClimbs[0] when there is no current climb and the queue is empty', () => {
    const suggestion = makeClimb('first-suggestion', 'S');
    mockSuggestedClimbs = [suggestion];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const next = result.current.getNextClimbQueueItem();
    expect(next?.climb.uuid).toBe('first-suggestion');
    expect(next?.suggested).toBe(true);
  });

  it('falls through to climbSearchResults when the anchor is the last queue item', () => {
    // The documented bug: with the anchor (current climb) sitting at the tail
    // of the queue, the next-climb walk has to continue past the queue into
    // climbSearchResults from the anchor's position in the search list.
    const searchClimbs = [makeClimb('search-0', 'A'), makeClimb('search-1', 'B'), makeClimb('search-2', 'C')];
    mockClimbSearchResults = searchClimbs;
    mockSuggestedClimbs = [];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    // Build queue [head, tail] with both climbs also present in search results.
    // setCurrentClimbQueueItem with suggested:true appends each item via the
    // reducer's DELTA_UPDATE_CURRENT_CLIMB path.
    const queueHead: ClimbQueueItem = { uuid: 'queue-head', climb: searchClimbs[0], suggested: true };
    const queueTail: ClimbQueueItem = { uuid: 'queue-tail', climb: searchClimbs[1], suggested: true };
    act(() => {
      result.current.setCurrentClimbQueueItem(queueHead);
      result.current.setCurrentClimbQueueItem(queueTail);
    });

    const next = result.current.getNextClimbQueueItem({ from: queueTail });
    expect(next?.climb.uuid).toBe('search-2');
    expect(next?.suggested).toBe(true);
  });

  it('skips already-queued search results when walking out of the queue tail', () => {
    // Queue = [climb-A, climb-B]. Search results = [climb-B, climb-A, climb-C].
    // Walk forward from anchorIdx=0 (climb-B's position) should skip climb-A
    // at index 1 (already queued) and return climb-C.
    const climbA = makeClimb('search-A', 'A');
    const climbB = makeClimb('search-B', 'B');
    const climbC = makeClimb('search-C', 'C');
    mockClimbSearchResults = [climbB, climbA, climbC];
    mockSuggestedClimbs = [];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const queueHead: ClimbQueueItem = { uuid: 'queue-A', climb: climbA, suggested: true };
    const queueTail: ClimbQueueItem = { uuid: 'queue-B', climb: climbB, suggested: true };
    act(() => {
      result.current.setCurrentClimbQueueItem(queueHead);
      result.current.setCurrentClimbQueueItem(queueTail);
    });

    const next = result.current.getNextClimbQueueItem({ from: queueTail });
    expect(next?.climb.uuid).toBe('search-C');
  });

  it('falls back to a suggestion when the queue-tail anchor is not in climbSearchResults', () => {
    // Queue was built from a previous search session; the anchor's climb is
    // no longer in the current results. Position walk dead-ends; fallback
    // surfaces the first unqueued suggestion.
    const queuedClimb = makeClimb('queued-only', 'Q');
    const fallbackClimb = makeClimb('fallback-suggestion', 'S');
    mockClimbSearchResults = [makeClimb('unrelated-X', 'X'), makeClimb('unrelated-Y', 'Y')];
    mockSuggestedClimbs = [fallbackClimb];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const queueTail: ClimbQueueItem = { uuid: 'queue-1', climb: queuedClimb, suggested: true };
    act(() => {
      result.current.setCurrentClimbQueueItem(queueTail);
    });

    const next = result.current.getNextClimbQueueItem({ from: queueTail });
    expect(next?.climb.uuid).toBe('fallback-suggestion');
    expect(next?.suggested).toBe(true);
  });

  it('returns null on a single-item search list when the anchor is that item and no suggestions exist', () => {
    const onlyClimb = makeClimb('only-search', 'A');
    mockClimbSearchResults = [onlyClimb];
    mockSuggestedClimbs = [];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const anchor: ClimbQueueItem = {
      uuid: 'anchor-queue-item',
      climb: onlyClimb,
      suggested: false,
    };
    expect(result.current.getNextClimbQueueItem({ from: anchor })).toBeNull();
  });
});

describe('getPreviousClimbQueueItem main-branch climbSearchResults walk', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSuggestedClimbs = [];
    mockClimbSearchResults = null;
  });

  it('walks back to results[anchorIdx - 1] when the anchor sits mid-list', () => {
    const climbs = [
      makeClimb('search-0', 'A'),
      makeClimb('search-1', 'B'),
      makeClimb('search-2', 'C'),
      makeClimb('search-3', 'D'),
    ];
    mockClimbSearchResults = climbs;
    mockSuggestedClimbs = climbs;

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const anchorAtIdx2: ClimbQueueItem = {
      uuid: 'anchor-queue-item',
      climb: climbs[2],
      suggested: false,
    };
    const prev = result.current.getPreviousClimbQueueItem({ from: anchorAtIdx2 });
    expect(prev).not.toBeNull();
    expect(prev?.climb.uuid).toBe('search-1');
    expect(prev?.suggested).toBe(true);
  });

  it('returns null when the anchor is the first item in climbSearchResults and no suggestions remain', () => {
    const climbs = [makeClimb('search-0', 'A'), makeClimb('search-1', 'B')];
    mockClimbSearchResults = climbs;
    mockSuggestedClimbs = [];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const anchorAtStart: ClimbQueueItem = {
      uuid: 'anchor-queue-item',
      climb: climbs[0],
      suggested: false,
    };
    expect(result.current.getPreviousClimbQueueItem({ from: anchorAtStart })).toBeNull();
  });

  it('returns null when the anchor is not in climbSearchResults (no suggestion fallback)', () => {
    // Backward navigation is history-oriented: walking off the queue + search
    // walk means we have nothing in history to step back to. Don't fall
    // through to suggestedClimbs — that's discovery (the forward direction).
    const searchList = [makeClimb('search-0', 'A'), makeClimb('search-1', 'B')];
    mockClimbSearchResults = searchList;
    mockSuggestedClimbs = searchList;

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const orphanAnchor: ClimbQueueItem = {
      uuid: 'orphan-anchor',
      climb: makeClimb('not-in-results', 'P'),
      suggested: false,
    };
    expect(result.current.getPreviousClimbQueueItem({ from: orphanAnchor })).toBeNull();
  });

  it('returns null when there is no current climb and suggestions are populated', () => {
    // Regression guard: backward had no null-anchor short-circuit and would
    // silently surface suggestedClimbs[0] (the same forward-looking discovery
    // climb as Next). "Previous" with no active climb has no semantic answer.
    const suggestion = makeClimb('first-suggestion', 'S');
    mockSuggestedClimbs = [suggestion];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    expect(result.current.getPreviousClimbQueueItem()).toBeNull();
  });

  it('falls through to climbSearchResults when the anchor is the queue head', () => {
    // Symmetric bug path: anchor at the head of the queue should walk
    // backward into climbSearchResults from the anchor's position.
    const searchClimbs = [makeClimb('search-prior', 'A'), makeClimb('search-head', 'B'), makeClimb('search-tail', 'C')];
    mockClimbSearchResults = searchClimbs;
    mockSuggestedClimbs = [];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const queueHead: ClimbQueueItem = { uuid: 'queue-head', climb: searchClimbs[1], suggested: true };
    act(() => {
      result.current.setCurrentClimbQueueItem(queueHead);
    });

    const prev = result.current.getPreviousClimbQueueItem({ from: queueHead });
    expect(prev?.climb.uuid).toBe('search-prior');
    expect(prev?.suggested).toBe(true);
  });

  it('skips already-queued search results when walking backward', () => {
    // Mirror of the forward skip-queued test: from a non-queued anchor at
    // search idx 2, walking backward should skip the queued climb at idx 1
    // and return the climb at idx 0.
    const climbs = [makeClimb('search-0', 'A'), makeClimb('search-1', 'B'), makeClimb('search-2', 'C')];
    mockClimbSearchResults = climbs;
    mockSuggestedClimbs = [];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const queuedMiddle: ClimbQueueItem = { uuid: 'queued-middle', climb: climbs[1], suggested: true };
    act(() => {
      result.current.setCurrentClimbQueueItem(queuedMiddle);
    });

    // Anchor isn't in the queue (queueItemIndex === -1), so the backward
    // getter falls through to the search-results walk from anchorIdx=2.
    const anchor: ClimbQueueItem = {
      uuid: 'anchor-queue-item',
      climb: climbs[2],
      suggested: false,
    };
    const prev = result.current.getPreviousClimbQueueItem({ from: anchor });
    expect(prev?.climb.uuid).toBe('search-0');
  });

  it('returns null on a single-item search list when the anchor is that item and no suggestions exist', () => {
    const onlyClimb = makeClimb('only-search', 'A');
    mockClimbSearchResults = [onlyClimb];
    mockSuggestedClimbs = [];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const anchor: ClimbQueueItem = {
      uuid: 'anchor-queue-item',
      climb: onlyClimb,
      suggested: false,
    };
    expect(result.current.getPreviousClimbQueueItem({ from: anchor })).toBeNull();
  });
});

describe('navigation with playlistSuggestionSource active', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSuggestedClimbs = [];
    mockClimbSearchResults = null;
  });

  it('getNextClimbQueueItem returns suggestedClimbs[0] with a playlist peek uuid', () => {
    // In playlist mode, suggestedClimbs is derived from the source's climbs
    // (after the activatedClimb). When the queue is exhausted the next-up is
    // the first item in that derived feed, with its uuid rewritten to the
    // peek-uuid form so the drawer treats it as a preview-only step.
    const activatedClimb = makeClimb('activated', 'A');
    const nextClimb = makeClimb('playlist-next', 'B');
    const trailingClimb = makeClimb('playlist-trailing', 'C');
    const source: PlaylistSuggestionSource = {
      playlistUuid: 'pl-1',
      activatedClimbUuid: activatedClimb.uuid,
      boardKey: 'kilter/1/1/1/40',
      climbs: [activatedClimb, nextClimb, trailingClimb],
    };

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const activatedQueueItem: ClimbQueueItem = { uuid: 'q-activated', climb: activatedClimb, suggested: false };
    act(() => {
      result.current.setPlaylistSuggestionSource(source);
      result.current.setCurrentClimbQueueItem(activatedQueueItem);
    });

    const next = result.current.getNextClimbQueueItem({ from: activatedQueueItem });
    expect(next?.climb.uuid).toBe('playlist-next');
    expect(next?.uuid).toBe(getPlaylistPeekQueueItemUuid('playlist-next'));
    expect(next?.suggested).toBe(true);
  });

  it('getPreviousClimbQueueItem returns null in playlist mode at the queue head', () => {
    // Playlists are consumed forward only — there is no "previous playlist
    // climb" once the activated climb is current. The backward getter must
    // not fall through to climbSearchResults in playlist mode.
    const activatedClimb = makeClimb('activated', 'A');
    const source: PlaylistSuggestionSource = {
      playlistUuid: 'pl-1',
      activatedClimbUuid: activatedClimb.uuid,
      boardKey: 'kilter/1/1/1/40',
      climbs: [activatedClimb, makeClimb('playlist-next', 'B')],
    };
    // Seed search results that would otherwise produce a backward neighbour —
    // playlist mode should ignore them.
    mockClimbSearchResults = [makeClimb('search-prior', 'X'), activatedClimb];

    const { result } = renderHook(() => useQueueContext(), { wrapper: createWrapper() });

    const activatedQueueItem: ClimbQueueItem = { uuid: 'q-activated', climb: activatedClimb, suggested: false };
    act(() => {
      result.current.setPlaylistSuggestionSource(source);
      result.current.setCurrentClimbQueueItem(activatedQueueItem);
    });

    expect(result.current.getPreviousClimbQueueItem({ from: activatedQueueItem })).toBeNull();
  });
});
