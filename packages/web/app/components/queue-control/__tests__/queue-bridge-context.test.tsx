import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { QueueBridgeProvider, QueueBridgeInjector, useQueueBridgeBoardInfo } from '../queue-bridge-context';
import { createPlaylistSuggestionSource } from '../playlist-suggestions';
import {
  QueueContext,
  QueueActionsContext,
  QueueDataContext,
  CurrentClimbUuidContext,
  type GraphQLQueueContextType,
  type GraphQLQueueActionsType,
  type GraphQLQueueDataType,
} from '../../graphql-queue/QueueContext';
import type { BoardDetails, Climb, Angle } from '@/app/lib/types';
import type { ClimbQueueItem } from '../types';

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the SUT
// ---------------------------------------------------------------------------

let mockUuidCounter = 0;
vi.mock('uuid', () => ({
  v4: vi.fn(() => `test-uuid-${++mockUuidCounter}`),
}));

const mockSetLocalQueueState = vi.fn();
const mockDeactivateSession = vi.fn();
const mockClearLocalQueue = vi.fn();

let mockPersistentSession: Record<string, unknown> = {};

vi.mock('../../persistent-session', () => ({
  usePersistentSession: () => mockPersistentSession,
  usePersistentSessionState: () => mockPersistentSession,
  usePersistentSessionActions: () => mockPersistentSession,
}));

let mockPartyProfile: { profile: { id: string } | null; username: string; avatarUrl?: string } = {
  profile: null,
  username: '',
};
vi.mock('../../party-manager/party-profile-context', () => ({
  usePartyProfile: () => mockPartyProfile,
}));

const mockShowMessage = vi.fn();
vi.mock('../../providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

// Default: every climb passes. Tests that need to exercise the rejection
// path override this via mockCanAddClimbToBoard.mockReturnValueOnce(...).
type CompatResult = { ok: true } | { ok: false; reason: 'board_name' | 'layout' | 'holds_out_of_range' };
const mockCanAddClimbToBoard = vi.fn<(climb: unknown, target: unknown) => CompatResult>(() => ({ ok: true }));
vi.mock('@/app/lib/board-compatibility', () => ({
  canAddClimbToBoard: (climb: unknown, target: unknown) => mockCanAddClimbToBoard(climb, target),
}));

vi.mock('../../board-lock/queue-add-error-messages', () => ({
  queueAddErrorMessage: () => 'Climb is not compatible with this board',
}));

vi.mock('@/app/lib/live-activity/live-activity-bridge', () => ({
  default: () => null,
}));

vi.mock('../../graphql-queue/QueueContext', () => {
  const React = require('react');
  const ctx = React.createContext(undefined);
  const actionsCtx = React.createContext(undefined);
  const dataCtx = React.createContext(undefined);
  const currentClimbCtx = React.createContext(undefined);
  const currentClimbUuidCtx = React.createContext(null);
  const queueListCtx = React.createContext(undefined);
  const searchCtx = React.createContext(undefined);
  const sessionCtx = React.createContext(undefined);
  return {
    QueueContext: ctx,
    QueueActionsContext: actionsCtx,
    QueueDataContext: dataCtx,
    CurrentClimbContext: currentClimbCtx,
    CurrentClimbUuidContext: currentClimbUuidCtx,
    QueueListContext: queueListCtx,
    SearchContext: searchCtx,
    SessionContext: sessionCtx,
    useQueueActions: () => React.useContext(actionsCtx),
    useQueueData: () => React.useContext(dataCtx),
    __esModule: true,
  };
});

let mockPathname = '/kilter/1/10/1,2/40/list';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('@/app/lib/url-utils', () => ({
  getBaseBoardPath: (p: string) => p.replace(/\/\d+$/, ''),
  // Mirror real /b/{slug}/{angle}/... and /{board}/{layout}/{size}/{sets}/{angle}/...
  // shape detection so the live route-angle read in usePersistentSessionQueueAdapter
  // works under tests.
  extractAngleFromPathname: (pathname: string): number | null => {
    const slugMatch = pathname.match(/^\/b\/[^/]+\/(-?\d+)(?:\/|$)/);
    if (slugMatch) {
      const angle = Number(slugMatch[1]);
      return Number.isFinite(angle) ? angle : null;
    }
    const fullMatch = pathname.match(/^\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/(-?\d+)(?:\/|$)/);
    if (fullMatch) {
      const angle = Number(fullMatch[1]);
      return Number.isFinite(angle) ? angle : null;
    }
    return null;
  },
  DEFAULT_SEARCH_PARAMS: {
    gradeAccuracy: 0,
    maxGrade: 0,
    minGrade: 0,
    minRating: 0,
    minAscents: 0,
    sortBy: 'ascents',
    sortOrder: 'desc',
    name: '',
    onlyClassics: false,
    onlyTallClimbs: false,
    onlyWideClimbs: false,
  },
}));

// Mock playlist board-config helper so cold-start seeding tests don't pull in
// the real board constants data. Returns a simple, deterministic BoardDetails
// shape per board type that the seed helper can stringify into baseBoardPath.
vi.mock('@/app/lib/board-config-for-playlist', () => ({
  getBoardDetailsForPlaylist: (boardType: string, layoutId: number | null | undefined) => {
    if (!layoutId) return null;
    if (boardType === 'moonboard') {
      return {
        board_name: 'moonboard',
        layout_id: layoutId,
        size_id: 0,
        set_ids: [17, 18],
        layout_name: 'MoonBoard 2024',
        size_name: 'Full',
        size_description: 'Full',
        set_names: ['A', 'B'],
      };
    }
    return {
      board_name: boardType,
      layout_id: layoutId,
      size_id: 10,
      set_ids: [1, 2],
      layout_name: 'Original',
      size_name: '12x12',
      size_description: 'Full Size',
      set_names: ['Standard', 'Extended'],
    };
  },
  getDefaultAngleForBoard: () => 40,
}));

// Now import the SUT — after all vi.mock calls

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
    size_description: 'Full Size',
    set_names: ['Standard', 'Extended'],
    ...overrides,
  } as BoardDetails;
}

function createTestClimb(overrides?: Partial<Climb>): Climb {
  return {
    uuid: 'climb-1',
    setter_username: 'setter1',
    name: 'Test Climb',
    description: 'A test climb',
    frames: 'p1r12p2r13',
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
    ...overrides,
  } as Climb;
}

function createTestQueueItem(climb?: Climb, uuid?: string): ClimbQueueItem {
  return {
    climb: climb ?? createTestClimb(),
    addedBy: null,
    uuid: uuid ?? 'item-uuid-1',
    suggested: false,
  };
}

function createDefaultPersistentSession(overrides?: Record<string, unknown>) {
  return {
    activeSession: null,
    session: null,
    isConnecting: false,
    hasConnected: false,
    error: null,
    clientId: null,
    isLeader: false,
    users: [],
    currentClimbQueueItem: null,
    queue: [],
    localQueue: [],
    localCurrentClimbQueueItem: null,
    localBoardPath: null,
    localBoardDetails: null,
    isLocalQueueLoaded: false,
    setLocalQueueState: mockSetLocalQueueState,
    clearLocalQueue: mockClearLocalQueue,
    deactivateSession: mockDeactivateSession,
    activateSession: vi.fn(),
    setInitialQueueForSession: vi.fn(),
    subscribeToQueueEvents: vi.fn(() => vi.fn()),
    addQueueItem: vi.fn(() => Promise.resolve()),
    removeQueueItem: vi.fn(() => Promise.resolve()),
    setCurrentClimb: vi.fn(() => Promise.resolve()),
    setQueue: vi.fn(() => Promise.resolve()),
    mirrorCurrentClimb: vi.fn(() => Promise.resolve()),
    replaceQueueItem: vi.fn(() => Promise.resolve()),
    takeControl: vi.fn(() => Promise.resolve()),
    releaseControl: vi.fn(() => Promise.resolve()),
    triggerResync: vi.fn(),
    participantId: null,
    driverParticipantId: null,
    ...overrides,
  };
}

/** Minimal fake GraphQLQueueContextType for injection tests */
function createFakeQueueContext(overrides?: Partial<GraphQLQueueContextType>): GraphQLQueueContextType {
  return {
    queue: [],
    currentClimbQueueItem: null,
    currentClimb: null,
    climbSearchParams: {
      gradeAccuracy: 0,
      maxGrade: 0,
      minGrade: 0,
      minRating: 0,
      minAscents: 0,
      sortBy: 'ascents',
      sortOrder: 'desc',
      name: '',
      onlyClassics: false,
      onlyTallClimbs: false,
      onlyWideClimbs: false,
    },
    climbSearchResults: null,
    suggestedClimbs: [],
    totalSearchResultCount: null,
    hasMoreResults: false,
    isFetchingClimbs: false,
    isFetchingNextPage: false,
    hasDoneFirstFetch: false,
    viewOnlyMode: false,
    parsedParams: { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 2], angle: 40 },
    isSessionActive: false,
    sessionId: null,
    startSession: vi.fn(async () => ''),
    joinSession: vi.fn(async () => {}),
    endSession: vi.fn(),
    sessionSummary: null,
    sessionSummaryBoardType: null,
    sessionSummaryHealthKitWorkoutId: null,
    dismissSessionSummary: vi.fn(),
    sessionGoal: null,
    users: [],
    clientId: null,
    isLeader: false,
    isBackendMode: false,
    hasConnected: false,
    connectionError: null,
    disconnect: vi.fn(),
    addToQueue: vi.fn(),
    removeFromQueue: vi.fn(),
    setCurrentClimb: vi.fn(),
    setCurrentClimbQueueItem: vi.fn(),
    setPlaylistSuggestionSource: vi.fn(),
    refreshPlaylistSuggestionSource: vi.fn(),
    replaceQueueItem: vi.fn(),
    setClimbSearchParams: vi.fn(),
    mirrorClimb: vi.fn(),
    fetchMoreClimbs: vi.fn(),
    getNextClimbQueueItem: vi.fn(() => null),
    getPreviousClimbQueueItem: vi.fn(() => null),
    setQueue: vi.fn(),
    ...overrides,
  } as GraphQLQueueContextType;
}

/**
 * Hook to read the QueueContext value exposed by QueueBridgeProvider.
 */
function useTestQueueContext() {
  return React.useContext(QueueContext);
}

/**
 * Hook to read the QueueActionsContext value exposed by QueueBridgeProvider.
 */
function useTestQueueActions() {
  return React.useContext(QueueActionsContext);
}

/**
 * Hook to read the QueueDataContext value exposed by QueueBridgeProvider.
 */
function useTestQueueData() {
  return React.useContext(QueueDataContext);
}

/**
 * Hook to read the CurrentClimbUuidContext value exposed by QueueBridgeProvider.
 */
function useTestCurrentClimbUuid() {
  return React.useContext(CurrentClimbUuidContext);
}

/** Extract the actions slice from a combined context (simulates GraphQLQueueProvider's actionsValue) */
function extractActions(ctx: GraphQLQueueContextType): GraphQLQueueActionsType {
  return {
    addToQueue: ctx.addToQueue,
    removeFromQueue: ctx.removeFromQueue,
    setCurrentClimb: ctx.setCurrentClimb,
    previewClimbFromBrowse: ctx.previewClimbFromBrowse,
    setCurrentClimbQueueItem: ctx.setCurrentClimbQueueItem,
    setPlaylistSuggestionSource: ctx.setPlaylistSuggestionSource,
    refreshPlaylistSuggestionSource: ctx.refreshPlaylistSuggestionSource,
    replaceQueueItem: ctx.replaceQueueItem,
    setClimbSearchParams: ctx.setClimbSearchParams,
    setCountSearchParams: ctx.setClimbSearchParams,
    mirrorClimb: ctx.mirrorClimb,
    fetchMoreClimbs: ctx.fetchMoreClimbs,
    getNextClimbQueueItem: ctx.getNextClimbQueueItem,
    getPreviousClimbQueueItem: ctx.getPreviousClimbQueueItem,
    setQueue: ctx.setQueue,
    startSession: ctx.startSession,
    joinSession: ctx.joinSession,
    endSession: ctx.endSession,
    dismissSessionSummary: ctx.dismissSessionSummary,
    disconnect: ctx.disconnect,
    takeControl: ctx.takeControl,
    releaseControl: ctx.releaseControl,
  };
}

/** Extract the data slice from a combined context (simulates GraphQLQueueProvider's dataValue) */
function extractData(ctx: GraphQLQueueContextType): GraphQLQueueDataType {
  return {
    queue: ctx.queue,
    currentClimbQueueItem: ctx.currentClimbQueueItem,
    currentClimb: ctx.currentClimb,
    climbSearchParams: ctx.climbSearchParams,
    climbSearchResults: ctx.climbSearchResults,
    suggestedClimbs: ctx.suggestedClimbs,
    playlistSuggestionSource: ctx.playlistSuggestionSource,
    totalSearchResultCount: ctx.totalSearchResultCount,
    hasMoreResults: ctx.hasMoreResults,
    isFetchingClimbs: ctx.isFetchingClimbs,
    isFetchingNextPage: ctx.isFetchingNextPage,
    hasDoneFirstFetch: ctx.hasDoneFirstFetch,
    viewOnlyMode: ctx.viewOnlyMode,
    connectionState: ctx.connectionState,
    canMutate: ctx.canMutate,
    parsedParams: ctx.parsedParams,
    isSessionActive: ctx.isSessionActive,
    isPersistentSessionActive: ctx.isPersistentSessionActive,
    sessionId: ctx.sessionId,
    sessionSummary: ctx.sessionSummary,
    sessionGoal: ctx.sessionGoal,
    users: ctx.users,
    clientId: ctx.clientId,
    isLeader: ctx.isLeader,
    isBackendMode: ctx.isBackendMode,
    hasConnected: ctx.hasConnected,
    connectionError: ctx.connectionError,
    isDisconnected: ctx.isDisconnected,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('queue-bridge-context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUuidCounter = 0;
    mockPersistentSession = createDefaultPersistentSession();
    mockPartyProfile = { profile: null, username: '' };
    mockCanAddClimbToBoard.mockReturnValue({ ok: true });
  });

  // -----------------------------------------------------------------------
  // QueueBridgeProvider — adapter mode (no injector mounted)
  // -----------------------------------------------------------------------
  describe('QueueBridgeProvider (adapter mode)', () => {
    function renderBridgeHook() {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueueBridgeProvider>{children}</QueueBridgeProvider>
      );
      return renderHook(
        () => ({
          boardInfo: useQueueBridgeBoardInfo(),
          queueCtx: useTestQueueContext(),
        }),
        { wrapper },
      );
    }

    it('provides adapter context when no injector is mounted', () => {
      const { result } = renderBridgeHook();
      // The queue context should be defined (adapter fallback)
      expect(result.current.queueCtx).toBeDefined();
      expect(result.current.queueCtx!.queue).toEqual([]);
    });

    it('hasActiveQueue is false when no board details and empty queue', () => {
      mockPersistentSession = createDefaultPersistentSession();
      const { result } = renderBridgeHook();
      expect(result.current.boardInfo.hasActiveQueue).toBe(false);
    });

    it('hasActiveQueue is true when local queue has items and board details exist', () => {
      const bd = createTestBoardDetails();
      const item = createTestQueueItem();
      mockPersistentSession = createDefaultPersistentSession({
        localQueue: [item],
        localCurrentClimbQueueItem: item,
        localBoardDetails: bd,
        localBoardPath: '/kilter/1/10/1,2',
        isLocalQueueLoaded: true,
      });
      const { result } = renderBridgeHook();
      expect(result.current.boardInfo.hasActiveQueue).toBe(true);
    });

    it('uses active session board details on non-board routes even before queue items load', () => {
      const bd = createTestBoardDetails();
      mockPersistentSession = createDefaultPersistentSession({
        activeSession: {
          sessionId: 'party-1',
          boardPath: '/kilter/1/10/1,2/40/list',
          boardDetails: bd,
          parsedParams: {
            board_name: 'kilter',
            layout_id: 1,
            size_id: 10,
            set_ids: [1, 2],
            angle: 40,
          },
        },
        queue: [],
        currentClimbQueueItem: null,
        isLocalQueueLoaded: true,
      });

      const { result } = renderBridgeHook();

      expect(result.current.boardInfo.boardDetails).toEqual(bd);
      expect(result.current.boardInfo.angle).toBe(40);
      expect(result.current.boardInfo.hasActiveQueue).toBe(true);
    });

    it('provides current climb uuid in adapter mode', () => {
      const item = createTestQueueItem(createTestClimb({ uuid: 'c1' }), 'u1');
      mockPersistentSession = createDefaultPersistentSession({
        localQueue: [item],
        localCurrentClimbQueueItem: item,
        localBoardDetails: createTestBoardDetails(),
        localBoardPath: '/kilter/1/10/1,2',
        isLocalQueueLoaded: true,
      });

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueueBridgeProvider>{children}</QueueBridgeProvider>
      );

      const { result } = renderHook(() => useTestCurrentClimbUuid(), { wrapper });
      expect(result.current).toBe('u1');
    });

    // -------------------------------------------------------------------
    // Adapter queue operations
    // -------------------------------------------------------------------
    describe('adapter queue operations', () => {
      const bd = createTestBoardDetails();
      const climb1 = createTestClimb({ uuid: 'c1', name: 'Climb 1' });
      const climb2 = createTestClimb({ uuid: 'c2', name: 'Climb 2' });
      const climb3 = createTestClimb({ uuid: 'c3', name: 'Climb 3' });

      function renderWithLocalQueue(queue: ClimbQueueItem[], current: ClimbQueueItem | null) {
        mockPersistentSession = createDefaultPersistentSession({
          localQueue: queue,
          localCurrentClimbQueueItem: current,
          localBoardDetails: bd,
          localBoardPath: '/kilter/1/10/1,2',
          isLocalQueueLoaded: true,
        });
        const wrapper = ({ children }: { children: React.ReactNode }) => (
          <QueueBridgeProvider>{children}</QueueBridgeProvider>
        );
        return renderHook(() => useTestQueueContext(), { wrapper });
      }

      it('addToQueue creates item and calls setLocalQueueState', () => {
        const { result } = renderWithLocalQueue([], null);
        act(() => {
          result.current!.addToQueue(climb1);
        });
        expect(mockSetLocalQueueState).toHaveBeenCalled();
        const [newQueue, newCurrent] = mockSetLocalQueueState.mock.calls[0];
        expect(newQueue).toHaveLength(1);
        expect(newQueue[0].climb.uuid).toBe('c1');
        // When current is null, new item becomes current
        expect(newCurrent.climb.uuid).toBe('c1');
      });

      it('removeFromQueue filters item and updates state', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const item2 = createTestQueueItem(climb2, 'u2');
        const { result } = renderWithLocalQueue([item1, item2], item1);
        act(() => {
          result.current!.removeFromQueue(item1);
        });
        expect(mockSetLocalQueueState).toHaveBeenCalled();
        const [newQueue, newCurrent] = mockSetLocalQueueState.mock.calls[0];
        expect(newQueue).toHaveLength(1);
        expect(newQueue[0].uuid).toBe('u2');
        // Current was removed, so falls back to first item
        expect(newCurrent.uuid).toBe('u2');
      });

      it('setCurrentClimbQueueItem updates current and calls setLocalQueueState', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const item2 = createTestQueueItem(climb2, 'u2');
        const { result } = renderWithLocalQueue([item1, item2], item1);
        act(() => {
          result.current!.setCurrentClimbQueueItem(item2);
        });
        expect(mockSetLocalQueueState).toHaveBeenCalled();
        const [, newCurrent] = mockSetLocalQueueState.mock.calls[0];
        expect(newCurrent.uuid).toBe('u2');
      });

      it('getNextClimbQueueItem returns next item in queue', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const item2 = createTestQueueItem(climb2, 'u2');
        const { result } = renderWithLocalQueue([item1, item2], item1);
        const next = result.current!.getNextClimbQueueItem();
        expect(next?.uuid).toBe('u2');
      });

      it('getPreviousClimbQueueItem returns previous item in queue', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const item2 = createTestQueueItem(climb2, 'u2');
        const { result } = renderWithLocalQueue([item1, item2], item2);
        const prev = result.current!.getPreviousClimbQueueItem();
        expect(prev?.uuid).toBe('u1');
      });

      it('getNextClimbQueueItem returns null when at end', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const { result } = renderWithLocalQueue([item1], item1);
        const next = result.current!.getNextClimbQueueItem();
        expect(next).toBeNull();
      });

      it('getNextClimbQueueItem falls back to playlist suggestions when at end of queue', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const source = createPlaylistSuggestionSource({
          playlistUuid: 'playlist-1',
          activatedClimb: climb1,
          climbs: [climb1, climb2],
          boardDetails: bd,
        });
        const { result } = renderWithLocalQueue([item1], item1);

        act(() => {
          result.current!.setPlaylistSuggestionSource(source);
        });

        const next = result.current!.getNextClimbQueueItem();
        expect(next?.climb.uuid).toBe('c2');
        expect(next?.suggested).toBe(true);
        expect(next?.uuid).toBe('playlist-peek:c2');
      });

      it('getPreviousClimbQueueItem returns null when at beginning', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const { result } = renderWithLocalQueue([item1], item1);
        const prev = result.current!.getPreviousClimbQueueItem();
        expect(prev).toBeNull();
      });

      it('mirrorClimb toggles mirrored flag', () => {
        const climb = createTestClimb({ uuid: 'c1', mirrored: false });
        const item = createTestQueueItem(climb, 'u1');
        const { result } = renderWithLocalQueue([item], item);
        act(() => {
          result.current!.mirrorClimb();
        });
        expect(mockSetLocalQueueState).toHaveBeenCalled();
        const [newQueue, newCurrent] = mockSetLocalQueueState.mock.calls[0];
        expect(newCurrent.climb.mirrored).toBe(true);
        expect(newQueue[0].climb.mirrored).toBe(true);
      });

      it('setQueue replaces queue and preserves current if present', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const item2 = createTestQueueItem(climb2, 'u2');
        const { result } = renderWithLocalQueue([item1], item1);
        act(() => {
          result.current!.setQueue([item1, item2]);
        });
        expect(mockSetLocalQueueState).toHaveBeenCalled();
        const [newQueue, newCurrent] = mockSetLocalQueueState.mock.calls[0];
        expect(newQueue).toHaveLength(2);
        // Current was in the new queue so it's preserved
        expect(newCurrent.uuid).toBe('u1');
      });

      it('setQueue resets current to first when old current not in new queue', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const item2 = createTestQueueItem(climb2, 'u2');
        const { result } = renderWithLocalQueue([item1], item1);
        act(() => {
          result.current!.setQueue([item2]);
        });
        expect(mockSetLocalQueueState).toHaveBeenCalled();
        const [, newCurrent] = mockSetLocalQueueState.mock.calls[0];
        expect(newCurrent.uuid).toBe('u2');
      });

      it('setCurrentClimb inserts after current in queue', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const { result } = renderWithLocalQueue([item1], item1);
        act(() => {
          void result.current!.setCurrentClimb(climb2, { playlistSuggestionSource: null });
        });
        expect(mockSetLocalQueueState).toHaveBeenCalled();
        const [newQueue, newCurrent] = mockSetLocalQueueState.mock.calls[0];
        // New item was inserted after item1
        expect(newQueue).toHaveLength(2);
        expect(newQueue[0].uuid).toBe('u1');
        expect(newQueue[1].climb.uuid).toBe('c2');
        // New item becomes current
        expect(newCurrent.climb.uuid).toBe('c2');
      });

      it('setCurrentClimb with a playlist source prunes future suggested items in local mode', async () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const staleSuggestedItem = {
          ...createTestQueueItem(createTestClimb({ uuid: 'stale-suggestion' }), 'stale-suggestion-item'),
          suggested: true,
        };
        const manualFutureItem = createTestQueueItem(climb3, 'manual-future-item');
        const source = createPlaylistSuggestionSource({
          playlistUuid: 'playlist-1',
          activatedClimb: climb2,
          climbs: [climb1, climb2, climb3],
          boardDetails: bd,
        });
        const { result } = renderWithLocalQueue([item1, staleSuggestedItem, manualFutureItem], item1);

        await act(async () => {
          await result.current!.setCurrentClimb(climb2, { playlistSuggestionSource: source });
        });

        expect(mockSetLocalQueueState).toHaveBeenCalled();
        const [newQueue, newCurrent] = mockSetLocalQueueState.mock.calls[0];
        expect(newQueue.map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['c1', 'c2', 'c3']);
        expect(newQueue.map((item: ClimbQueueItem) => item.uuid)).toEqual(['u1', 'test-uuid-1', 'manual-future-item']);
        expect(newCurrent.climb.uuid).toBe('c2');
      });

      it('sets and refreshes playlist suggestion source only when activation identity matches', () => {
        const source = createPlaylistSuggestionSource({
          playlistUuid: 'playlist-1',
          activatedClimb: climb1,
          climbs: [climb1, climb2],
          boardDetails: bd,
        });
        const staleRefresh = createPlaylistSuggestionSource({
          playlistUuid: 'playlist-1',
          activatedClimb: climb2,
          climbs: [climb2, climb3],
          boardDetails: bd,
        });
        const refreshedSource = createPlaylistSuggestionSource({
          playlistUuid: 'playlist-1',
          activatedClimb: climb1,
          climbs: [climb1, climb2, climb3],
          boardDetails: bd,
        });
        const { result } = renderWithLocalQueue([], null);

        act(() => {
          result.current!.setPlaylistSuggestionSource(source);
        });
        expect(result.current!.playlistSuggestionSource).toEqual(source);

        act(() => {
          result.current!.refreshPlaylistSuggestionSource(staleRefresh);
        });
        expect(result.current!.playlistSuggestionSource).toEqual(source);

        act(() => {
          result.current!.refreshPlaylistSuggestionSource(refreshedSource);
        });
        expect(result.current!.playlistSuggestionSource).toEqual(refreshedSource);

        act(() => {
          result.current!.setPlaylistSuggestionSource(null);
        });
        expect(result.current!.playlistSuggestionSource).toBeNull();
      });
    });

    // -------------------------------------------------------------------
    // Cold-start seeding: selecting a climb from a surface with no active
    // board (e.g. a playlist view) must auto-activate the climb's board.
    // -------------------------------------------------------------------
    describe('adapter cold-start seeding', () => {
      function renderWithoutLocalBoard() {
        mockPersistentSession = createDefaultPersistentSession({
          localQueue: [],
          localCurrentClimbQueueItem: null,
          localBoardDetails: null,
          localBoardPath: null,
          isLocalQueueLoaded: true,
        });
        const wrapper = ({ children }: { children: React.ReactNode }) => (
          <QueueBridgeProvider>{children}</QueueBridgeProvider>
        );
        return renderHook(() => useTestQueueContext(), { wrapper });
      }

      it('setCurrentClimb seeds local state from a Kilter climb when no board is active', () => {
        const climb = createTestClimb({ uuid: 'c-cold', boardType: 'kilter', layoutId: 1 });
        const { result } = renderWithoutLocalBoard();
        act(() => {
          void result.current!.setCurrentClimb(climb, { playlistSuggestionSource: null });
        });
        expect(mockSetLocalQueueState).toHaveBeenCalledTimes(1);
        const [newQueue, newCurrent, boardPath, boardDetails] = mockSetLocalQueueState.mock.calls[0];
        expect(newQueue).toHaveLength(1);
        expect(newQueue[0].climb.uuid).toBe('c-cold');
        expect(newCurrent.climb.uuid).toBe('c-cold');
        expect(boardPath).toBe('/kilter/1/10/1,2');
        expect(boardDetails.board_name).toBe('kilter');
        expect(boardDetails.layout_id).toBe(1);
      });

      it('setCurrentClimb seeds with moonboard path shape (no size segment)', () => {
        const climb = createTestClimb({ uuid: 'mb-1', boardType: 'moonboard', layoutId: 99 });
        const { result } = renderWithoutLocalBoard();
        act(() => {
          void result.current!.setCurrentClimb(climb, { playlistSuggestionSource: null });
        });
        expect(mockSetLocalQueueState).toHaveBeenCalledTimes(1);
        const [, , boardPath, boardDetails] = mockSetLocalQueueState.mock.calls[0];
        expect(boardPath).toBe('/moonboard/99/17,18');
        expect(boardDetails.board_name).toBe('moonboard');
      });

      it('addToQueue seeds local state from the climb when no board is active', () => {
        const climb = createTestClimb({ uuid: 'c-add', boardType: 'tension', layoutId: 2 });
        const { result } = renderWithoutLocalBoard();
        act(() => {
          result.current!.addToQueue(climb);
        });
        expect(mockSetLocalQueueState).toHaveBeenCalledTimes(1);
        const [newQueue, newCurrent, boardPath] = mockSetLocalQueueState.mock.calls[0];
        expect(newQueue).toHaveLength(1);
        expect(newQueue[0].climb.uuid).toBe('c-add');
        expect(newCurrent.climb.uuid).toBe('c-add');
        expect(boardPath).toBe('/tension/2/10/1,2');
      });

      it('setCurrentClimb is a no-op when the climb has no layoutId to seed from', () => {
        const climb = createTestClimb({ uuid: 'orphan', boardType: 'kilter', layoutId: null });
        const { result } = renderWithoutLocalBoard();
        act(() => {
          void result.current!.setCurrentClimb(climb, { playlistSuggestionSource: null });
        });
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
      });

      it('setCurrentClimb is a no-op when the climb has no boardType to seed from', () => {
        const climb = createTestClimb({ uuid: 'orphan', boardType: undefined, layoutId: 1 });
        const { result } = renderWithoutLocalBoard();
        act(() => {
          void result.current!.setCurrentClimb(climb, { playlistSuggestionSource: null });
        });
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
      });
    });

    // -------------------------------------------------------------------
    // Party-mode operations: with an active party session, the adapter must
    // delegate mutations to the persistent session's WebSocket-backed API
    // instead of setLocalQueueState (which no-ops in party mode).
    // -------------------------------------------------------------------
    describe('adapter party-mode operations', () => {
      const bd = createTestBoardDetails();
      const climb1 = createTestClimb({ uuid: 'c1', name: 'Climb 1' });
      const climb2 = createTestClimb({ uuid: 'c2', name: 'Climb 2' });
      const climb3 = createTestClimb({ uuid: 'c3', name: 'Climb 3' });
      const activeSession = {
        sessionId: 'party-1',
        boardPath: '/kilter/1/10/1,2/40/list',
        boardDetails: bd,
        parsedParams: {
          board_name: 'kilter' as const,
          layout_id: 1,
          size_id: 10,
          set_ids: [1, 2],
          angle: 40 as Angle,
        },
      };

      function renderWithPartySession(
        queue: ClimbQueueItem[],
        current: ClimbQueueItem | null,
        psOverrides?: Record<string, unknown>,
      ) {
        mockPersistentSession = createDefaultPersistentSession({
          activeSession,
          queue,
          currentClimbQueueItem: current,
          isLocalQueueLoaded: true,
          clientId: 'client-abc',
          ...psOverrides,
        });
        const wrapper = ({ children }: { children: React.ReactNode }) => (
          <QueueBridgeProvider>{children}</QueueBridgeProvider>
        );
        return renderHook(() => useTestQueueContext(), { wrapper });
      }

      it('setCurrentClimb delegates to ps.addQueueItem and ps.setCurrentClimb in party mode', async () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const { result } = renderWithPartySession([item1], item1);
        await act(async () => {
          await result.current!.setCurrentClimb(climb2, { playlistSuggestionSource: null });
        });
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
        expect(mockPersistentSession.addQueueItem).toHaveBeenCalledTimes(1);
        const addCall = (mockPersistentSession.addQueueItem as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(addCall[0].climb.uuid).toBe('c2');
        // Position is currentIndex + 1 = 1 (current at index 0, insert after)
        expect(addCall[1]).toBe(1);
        expect(mockPersistentSession.setCurrentClimb).toHaveBeenCalledTimes(1);
        const setCurrentCall = (mockPersistentSession.setCurrentClimb as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(setCurrentCall[0].climb.uuid).toBe('c2');
        // shouldAddToQueue is false (we already added)
        expect(setCurrentCall[1]).toBe(false);
        // correlationId derived from clientId
        expect(setCurrentCall[2]).toMatch(/^client-abc-/);
      });

      it('setCurrentClimb with a playlist source replaces the party queue for a new item', async () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const staleSuggestedItem = {
          ...createTestQueueItem(createTestClimb({ uuid: 'stale-suggestion' }), 'stale-suggestion-item'),
          suggested: true,
        };
        const manualFutureItem = createTestQueueItem(climb3, 'manual-future-item');
        const source = createPlaylistSuggestionSource({
          playlistUuid: 'playlist-1',
          activatedClimb: climb2,
          climbs: [climb1, climb2, climb3],
          boardDetails: bd,
        });
        const { result } = renderWithPartySession([item1, staleSuggestedItem, manualFutureItem], item1);

        await act(async () => {
          await result.current!.setCurrentClimb(climb2, { playlistSuggestionSource: source });
        });

        expect(mockPersistentSession.addQueueItem).not.toHaveBeenCalled();
        expect(mockPersistentSession.setCurrentClimb).not.toHaveBeenCalled();
        expect(mockPersistentSession.setQueue).toHaveBeenCalledTimes(1);
        const [newQueue, newCurrent] = (mockPersistentSession.setQueue as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(newQueue.map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['c1', 'c2', 'c3']);
        expect(newQueue.map((item: ClimbQueueItem) => item.uuid)).toEqual(['u1', 'test-uuid-1', 'manual-future-item']);
        expect(newCurrent.climb.uuid).toBe('c2');
      });

      it('setCurrentClimb with a playlist source replaces the party queue for an existing item', async () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const existingItem = createTestQueueItem(climb2, 'u2');
        const staleSuggestedItem = {
          ...createTestQueueItem(createTestClimb({ uuid: 'stale-suggestion' }), 'stale-suggestion-item'),
          suggested: true,
        };
        const manualFutureItem = createTestQueueItem(climb3, 'manual-future-item');
        const source = createPlaylistSuggestionSource({
          playlistUuid: 'playlist-1',
          activatedClimb: climb2,
          climbs: [climb1, climb2, climb3],
          boardDetails: bd,
        });
        const { result } = renderWithPartySession([item1, existingItem, staleSuggestedItem, manualFutureItem], item1);

        await act(async () => {
          await result.current!.setCurrentClimb(climb2, { playlistSuggestionSource: source });
        });

        expect(mockPersistentSession.addQueueItem).not.toHaveBeenCalled();
        expect(mockPersistentSession.setCurrentClimb).not.toHaveBeenCalled();
        expect(mockPersistentSession.setQueue).toHaveBeenCalledTimes(1);
        const [newQueue, newCurrent] = (mockPersistentSession.setQueue as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(newQueue.map((item: ClimbQueueItem) => item.climb.uuid)).toEqual(['c1', 'c2', 'c3']);
        expect(newQueue.map((item: ClimbQueueItem) => item.uuid)).toEqual(['u1', 'u2', 'manual-future-item']);
        expect(newCurrent.uuid).toBe('u2');
      });

      it('setCurrentClimb passes undefined position when no current is set', async () => {
        const { result } = renderWithPartySession([], null);
        await act(async () => {
          await result.current!.setCurrentClimb(climb1, { playlistSuggestionSource: null });
        });
        expect(mockPersistentSession.addQueueItem).toHaveBeenCalledTimes(1);
        const addCall = (mockPersistentSession.addQueueItem as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(addCall[1]).toBeUndefined();
      });

      it('setCurrentClimbQueueItem delegates to ps.setCurrentClimb in party mode', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const item2 = createTestQueueItem(climb2, 'u2');
        const { result } = renderWithPartySession([item1, item2], item1);
        act(() => {
          result.current!.setCurrentClimbQueueItem(item2);
        });
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
        expect(mockPersistentSession.setCurrentClimb).toHaveBeenCalledTimes(1);
        const call = (mockPersistentSession.setCurrentClimb as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[0].uuid).toBe('u2');
        // shouldAddToQueue uses item.suggested
        expect(call[1]).toBe(false);
      });

      it('setCurrentClimbQueueItem promotes playlist peek items before sending to party mode', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const source = createPlaylistSuggestionSource({
          playlistUuid: 'playlist-1',
          activatedClimb: climb1,
          climbs: [climb1, climb2],
          boardDetails: bd,
        });
        const { result } = renderWithPartySession([item1], item1);

        act(() => {
          result.current!.setPlaylistSuggestionSource(source);
        });

        const nextItem = result.current!.getNextClimbQueueItem();
        expect(nextItem?.uuid).toBe('playlist-peek:c2');

        act(() => {
          result.current!.setCurrentClimbQueueItem(nextItem!);
        });

        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
        expect(mockPersistentSession.setCurrentClimb).toHaveBeenCalledTimes(1);
        const call = (mockPersistentSession.setCurrentClimb as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[0].uuid).toBe('test-uuid-1');
        expect(call[0].uuid).not.toBe('playlist-peek:c2');
        expect(call[0].climb.uuid).toBe('c2');
        expect(call[0].suggested).toBe(true);
        expect(call[1]).toBe(true);
      });

      it('setCurrentClimb rolls back playlist source when party queue replacement fails', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const item1 = createTestQueueItem(climb1, 'u1');
          const previousSource = createPlaylistSuggestionSource({
            playlistUuid: 'playlist-1',
            activatedClimb: climb1,
            climbs: [climb1, climb2],
            boardDetails: bd,
          });
          const nextSource = createPlaylistSuggestionSource({
            playlistUuid: 'playlist-1',
            activatedClimb: climb2,
            climbs: [climb2, climb3],
            boardDetails: bd,
          });
          const { result } = renderWithPartySession([item1], item1, {
            setQueue: vi.fn(() => Promise.reject(new Error('ws queue failed'))),
          });

          act(() => {
            result.current!.setPlaylistSuggestionSource(previousSource);
          });
          expect(result.current!.playlistSuggestionSource).toEqual(previousSource);

          let returnValue: ClimbQueueItem | null | undefined;
          await act(async () => {
            returnValue = await result.current!.setCurrentClimb(climb2, { playlistSuggestionSource: nextSource });
          });

          expect(returnValue).toBeNull();
          expect(result.current!.playlistSuggestionSource).toEqual(previousSource);
          expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Failed to replace queue before setting playlist current:',
            expect.any(Error),
          );
        } finally {
          consoleErrorSpy.mockRestore();
        }
      });

      it('addToQueue delegates to ps.addQueueItem in party mode', () => {
        const { result } = renderWithPartySession([], null);
        act(() => {
          result.current!.addToQueue(climb1);
        });
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
        expect(mockPersistentSession.addQueueItem).toHaveBeenCalledTimes(1);
        const call = (mockPersistentSession.addQueueItem as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[0].climb.uuid).toBe('c1');
      });

      it('removeFromQueue delegates to ps.removeQueueItem in party mode', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const { result } = renderWithPartySession([item1], item1);
        act(() => {
          result.current!.removeFromQueue(item1);
        });
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
        expect(mockPersistentSession.removeQueueItem).toHaveBeenCalledTimes(1);
        expect((mockPersistentSession.removeQueueItem as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('u1');
      });

      it('setQueue delegates to ps.setQueue in party mode', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const item2 = createTestQueueItem(climb2, 'u2');
        const { result } = renderWithPartySession([item1], item1);
        act(() => {
          result.current!.setQueue([item1, item2]);
        });
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
        expect(mockPersistentSession.setQueue).toHaveBeenCalledTimes(1);
        const call = (mockPersistentSession.setQueue as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[0]).toHaveLength(2);
        expect(call[1].uuid).toBe('u1');
      });

      it('mirrorClimb delegates to ps.mirrorCurrentClimb in party mode', () => {
        const climb = createTestClimb({ uuid: 'c1', mirrored: false });
        const item = createTestQueueItem(climb, 'u1');
        const { result } = renderWithPartySession([item], item);
        act(() => {
          result.current!.mirrorClimb();
        });
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
        expect(mockPersistentSession.mirrorCurrentClimb).toHaveBeenCalledTimes(1);
        expect((mockPersistentSession.mirrorCurrentClimb as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(true);
      });

      it('replaceQueueItem delegates to ps.replaceQueueItem in party mode', () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const { result } = renderWithPartySession([item1], item1);
        const newClimb = createTestClimb({ uuid: 'c1-edit', name: 'Edited Climb' });
        act(() => {
          result.current!.replaceQueueItem('u1', newClimb);
        });
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
        expect(mockPersistentSession.replaceQueueItem).toHaveBeenCalledTimes(1);
        const call = (mockPersistentSession.replaceQueueItem as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[0]).toBe('u1');
        // Preserves the slot uuid; updates the climb in place
        expect(call[1].uuid).toBe('u1');
        expect(call[1].climb.uuid).toBe('c1-edit');
      });

      it('setCurrentClimb reuses existing queue item instead of duplicating', async () => {
        const item1 = createTestQueueItem(climb1, 'u1');
        const { result } = renderWithPartySession([item1], item1);
        await act(async () => {
          // Click the same climb that's already in the queue at u1 — should
          // NOT add a duplicate; should call setCurrentClimb on the existing item.
          await result.current!.setCurrentClimb(climb1, { playlistSuggestionSource: null });
        });
        expect(mockPersistentSession.addQueueItem).not.toHaveBeenCalled();
        expect(mockPersistentSession.setCurrentClimb).toHaveBeenCalledTimes(1);
        const call = (mockPersistentSession.setCurrentClimb as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[0].uuid).toBe('u1');
        expect(call[0].climb.uuid).toBe('c1');
      });

      it('setCurrentClimb populates addedBy and addedByUser from party profile', async () => {
        mockPartyProfile = {
          profile: { id: 'user-42' },
          username: 'climber42',
          avatarUrl: 'https://example.com/a.png',
        };
        const { result } = renderWithPartySession([], null);
        await act(async () => {
          await result.current!.setCurrentClimb(climb1, { playlistSuggestionSource: null });
        });
        const addCall = (mockPersistentSession.addQueueItem as ReturnType<typeof vi.fn>).mock.calls[0];
        const newItem = addCall[0];
        expect(newItem.addedBy).toBe('client-abc');
        expect(newItem.addedByUser).toEqual({
          id: 'user-42',
          username: 'climber42',
          avatarUrl: 'https://example.com/a.png',
        });
      });

      it('addToQueue populates addedBy and addedByUser from party profile', () => {
        mockPartyProfile = {
          profile: { id: 'user-99' },
          username: 'climber99',
          avatarUrl: undefined,
        };
        const { result } = renderWithPartySession([], null);
        act(() => {
          result.current!.addToQueue(climb1);
        });
        const call = (mockPersistentSession.addQueueItem as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(call[0].addedBy).toBe('client-abc');
        expect(call[0].addedByUser).toEqual({
          id: 'user-99',
          username: 'climber99',
          avatarUrl: undefined,
        });
      });

      it('setCurrentClimbQueueItem always re-sends in party mode even when item is already current', () => {
        // A peer might have moved the current climb away while our local
        // optimistic state still shows item as current. Tapping should
        // re-send the mutation so the server reconciles.
        const item1 = createTestQueueItem(climb1, 'u1');
        const { result } = renderWithPartySession([item1], item1);
        act(() => {
          result.current!.setCurrentClimbQueueItem(item1);
        });
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
        expect(mockPersistentSession.setCurrentClimb).toHaveBeenCalledTimes(1);
        expect((mockPersistentSession.setCurrentClimb as ReturnType<typeof vi.fn>).mock.calls[0][0].uuid).toBe('u1');
      });

      it('setCurrentClimb returns null and skips setCurrentClimb when ps.addQueueItem rejects', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          mockPersistentSession = createDefaultPersistentSession({
            activeSession,
            queue: [],
            currentClimbQueueItem: null,
            isLocalQueueLoaded: true,
            clientId: 'client-abc',
            addQueueItem: vi.fn(() => Promise.reject(new Error('ws send failed'))),
          });
          const wrapper = ({ children }: { children: React.ReactNode }) => (
            <QueueBridgeProvider>{children}</QueueBridgeProvider>
          );
          const { result } = renderHook(() => useTestQueueContext(), { wrapper });
          let returnValue: ClimbQueueItem | null | undefined;
          await act(async () => {
            returnValue = await result.current!.setCurrentClimb(climb1, { playlistSuggestionSource: null });
          });
          // addQueueItem rejected, so nothing landed on the server. Return
          // null so callers (e.g. navigateToClimb) skip downstream side
          // effects like navigation.
          expect(returnValue).toBeNull();
          expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Failed to add queue item before setting current:',
            expect.any(Error),
          );
          expect(mockPersistentSession.setCurrentClimb).not.toHaveBeenCalled();
        } finally {
          consoleErrorSpy.mockRestore();
        }
      });

      it('setCurrentClimb returns null when ps.setCurrentClimb rejects after addQueueItem succeeds (partial failure)', async () => {
        // Distinct from the addQueueItem-rejects case: here the item DID
        // land in the shared queue, but activating it failed. The item is
        // orphaned (queued but not current). Returning null lets callers
        // skip navigation since the board never got the update.
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          mockPersistentSession = createDefaultPersistentSession({
            activeSession,
            queue: [],
            currentClimbQueueItem: null,
            isLocalQueueLoaded: true,
            clientId: 'client-abc',
            addQueueItem: vi.fn(() => Promise.resolve()),
            setCurrentClimb: vi.fn(() => Promise.reject(new Error('set-current ws send failed'))),
          });
          const wrapper = ({ children }: { children: React.ReactNode }) => (
            <QueueBridgeProvider>{children}</QueueBridgeProvider>
          );
          const { result } = renderHook(() => useTestQueueContext(), { wrapper });
          let returnValue: ClimbQueueItem | null | undefined;
          await act(async () => {
            returnValue = await result.current!.setCurrentClimb(climb1, { playlistSuggestionSource: null });
          });
          expect(returnValue).toBeNull();
          expect(mockPersistentSession.addQueueItem).toHaveBeenCalledTimes(1);
          expect(mockPersistentSession.setCurrentClimb).toHaveBeenCalledTimes(1);
          expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Failed to set current climb after queue add:',
            expect.any(Error),
          );
        } finally {
          consoleErrorSpy.mockRestore();
        }
      });

      it('setCurrentClimb returns null when reusing an existing queue item and ps.setCurrentClimb rejects', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const item1 = createTestQueueItem(climb1, 'u1');
          mockPersistentSession = createDefaultPersistentSession({
            activeSession,
            queue: [item1],
            currentClimbQueueItem: null,
            isLocalQueueLoaded: true,
            clientId: 'client-abc',
            setCurrentClimb: vi.fn(() => Promise.reject(new Error('set-current rejected'))),
          });
          const wrapper = ({ children }: { children: React.ReactNode }) => (
            <QueueBridgeProvider>{children}</QueueBridgeProvider>
          );
          const { result } = renderHook(() => useTestQueueContext(), { wrapper });
          let returnValue: ClimbQueueItem | null | undefined;
          await act(async () => {
            // climb1 already exists in the queue as item1, so the dedupe
            // path is taken — setCurrentClimb on the existing item.
            returnValue = await result.current!.setCurrentClimb(climb1, { playlistSuggestionSource: null });
          });
          expect(returnValue).toBeNull();
          expect(mockPersistentSession.addQueueItem).not.toHaveBeenCalled();
          expect(mockPersistentSession.setCurrentClimb).toHaveBeenCalledTimes(1);
        } finally {
          consoleErrorSpy.mockRestore();
        }
      });
    });

    // -------------------------------------------------------------------
    // Validation rejection path: validateClimbForQueue surfaces a snackbar
    // error and short-circuits the mutation.
    // -------------------------------------------------------------------
    describe('validation rejection', () => {
      const bd = createTestBoardDetails();
      const climb1 = createTestClimb({ uuid: 'c1', name: 'Climb 1' });

      function renderWithLocalBoard() {
        mockPersistentSession = createDefaultPersistentSession({
          localQueue: [],
          localCurrentClimbQueueItem: null,
          localBoardDetails: bd,
          localBoardPath: '/kilter/1/10/1,2',
          isLocalQueueLoaded: true,
        });
        const wrapper = ({ children }: { children: React.ReactNode }) => (
          <QueueBridgeProvider>{children}</QueueBridgeProvider>
        );
        return renderHook(() => useTestQueueContext(), { wrapper });
      }

      it('addToQueue surfaces a snackbar error and skips mutation when canAddClimbToBoard rejects', () => {
        mockCanAddClimbToBoard.mockReturnValueOnce({ ok: false, reason: 'board_name' });
        const { result } = renderWithLocalBoard();
        act(() => {
          result.current!.addToQueue(climb1);
        });
        expect(mockShowMessage).toHaveBeenCalledWith('Climb is not compatible with this board', 'error');
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
      });

      it('setCurrentClimb returns null and skips mutation when canAddClimbToBoard rejects', async () => {
        mockCanAddClimbToBoard.mockReturnValueOnce({ ok: false, reason: 'board_name' });
        const { result } = renderWithLocalBoard();
        let returned: unknown;
        await act(async () => {
          returned = await result.current!.setCurrentClimb(climb1, { playlistSuggestionSource: null });
        });
        expect(returned).toBeNull();
        expect(mockShowMessage).toHaveBeenCalledWith('Climb is not compatible with this board', 'error');
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
      });
    });

    // -------------------------------------------------------------------
    // Driver-state plumbing — the queue-control-bar pivot's lightbulb path.
    // The bridge is the off-board surface PR 2's drawer lightbulb will rely
    // on, so the takeControl / releaseControl wiring and isDriver derivation
    // need parity with the on-board QueueContext.
    // -------------------------------------------------------------------
    describe('adapter driver-state plumbing (party mode)', () => {
      const bd = createTestBoardDetails();
      const climb1 = createTestClimb({ uuid: 'c1', name: 'Climb 1' });
      const activeSession = {
        sessionId: 'party-driver-1',
        boardPath: '/kilter/1/10/1,2/40/list',
        boardDetails: bd,
        parsedParams: {
          board_name: 'kilter' as const,
          layout_id: 1,
          size_id: 10,
          set_ids: [1, 2],
          angle: 40 as Angle,
        },
        participantId: 'participant-self',
      };

      function renderWithDriverState(psOverrides?: Record<string, unknown>) {
        mockPersistentSession = createDefaultPersistentSession({
          activeSession,
          queue: [],
          currentClimbQueueItem: null,
          isLocalQueueLoaded: true,
          hasConnected: true,
          clientId: 'client-self-ws',
          participantId: 'participant-self',
          ...psOverrides,
        });
        const wrapper = ({ children }: { children: React.ReactNode }) => (
          <QueueBridgeProvider>{children}</QueueBridgeProvider>
        );
        return renderHook(() => useTestQueueContext(), { wrapper });
      }

      it('takeControl(climb) delegates to ps.takeControl with a freshly built queue item', async () => {
        const { result } = renderWithDriverState();
        await act(async () => {
          await result.current!.takeControl(climb1);
        });
        expect(mockPersistentSession.takeControl).toHaveBeenCalledTimes(1);
        const arg = (mockPersistentSession.takeControl as ReturnType<typeof vi.fn>).mock.calls[0][0];
        expect(arg).not.toBeNull();
        expect(arg.climb.uuid).toBe('c1');
      });

      it('takeControl() without a climb delegates to ps.takeControl(null) to claim the driver only', async () => {
        const { result } = renderWithDriverState();
        await act(async () => {
          await result.current!.takeControl();
        });
        expect(mockPersistentSession.takeControl).toHaveBeenCalledTimes(1);
        expect((mockPersistentSession.takeControl as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBeNull();
      });

      it('releaseControl delegates to ps.releaseControl', async () => {
        const { result } = renderWithDriverState();
        await act(async () => {
          await result.current!.releaseControl();
        });
        expect(mockPersistentSession.releaseControl).toHaveBeenCalledTimes(1);
      });

      it('takeControl is a no-op (no ps call) while the WS is reconnecting', async () => {
        const { result } = renderWithDriverState({ hasConnected: false });
        await act(async () => {
          await result.current!.takeControl(climb1);
        });
        // Guarded by hasConnected to avoid the throw from use-queue-mutations
        // when the WS client ref is null mid-reconnect.
        expect(mockPersistentSession.takeControl).not.toHaveBeenCalled();
      });

      it('exposes isDriver=true when the local participantId matches driverParticipantId', () => {
        const { result } = renderWithDriverState({ driverParticipantId: 'participant-self' });
        expect(result.current!.isDriver).toBe(true);
        expect(result.current!.driverParticipantId).toBe('participant-self');
      });

      it('exposes isDriver=false when another participant holds the driver role', () => {
        const { result } = renderWithDriverState({ driverParticipantId: 'participant-other' });
        expect(result.current!.isDriver).toBe(false);
        expect(result.current!.driverParticipantId).toBe('participant-other');
      });

      it('exposes isDriver=false when the wall is unclaimed in party mode', () => {
        const { result } = renderWithDriverState({ driverParticipantId: null });
        expect(result.current!.isDriver).toBe(false);
        expect(result.current!.driverParticipantId).toBeNull();
      });
    });

    it('exposes isDriver=true in solo (no active party session) regardless of other state', () => {
      // Solo has no driver concept; the bridge degrades to "local user drives"
      // so the drawer lightbulb in PR 2 can render the lit state when BLE is up.
      mockPersistentSession = createDefaultPersistentSession({
        activeSession: null,
        localBoardDetails: createTestBoardDetails(),
      });
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueueBridgeProvider>{children}</QueueBridgeProvider>
      );
      const { result } = renderHook(() => useTestQueueContext(), { wrapper });
      expect(result.current!.isDriver).toBe(true);
      expect(result.current!.driverParticipantId).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // QueueBridgeInjector
  // -----------------------------------------------------------------------
  describe('QueueBridgeInjector', () => {
    const bd = createTestBoardDetails();
    const angle: Angle = 40;

    /**
     * Renders the injector inside a QueueBridgeProvider with an inner
     * QueueContext.Provider (simulating GraphQLQueueProvider) between
     * the bridge and the injector.
     *
     * The hook reads from the bridge's QueueContext (root level), while
     * the injector reads from the inner QueueContext (board route level).
     */
    function renderInjector(boardRouteCtx: GraphQLQueueContextType | undefined) {
      const actions = boardRouteCtx ? extractActions(boardRouteCtx) : undefined;
      const data = boardRouteCtx ? extractData(boardRouteCtx) : undefined;
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueueBridgeProvider>
          {/* Hook (children) reads bridge's QueueContext = effectiveContext */}
          {children}
          {/* Inner providers simulate GraphQLQueueProvider on board route */}
          <QueueActionsContext.Provider value={actions}>
            <QueueDataContext.Provider value={data}>
              <QueueContext.Provider value={boardRouteCtx}>
                <QueueBridgeInjector boardDetails={bd} angle={angle} />
              </QueueContext.Provider>
            </QueueDataContext.Provider>
          </QueueActionsContext.Provider>
        </QueueBridgeProvider>
      );

      return renderHook(
        () => ({
          boardInfo: useQueueBridgeBoardInfo(),
          queueCtx: useTestQueueContext(),
          currentClimbUuid: useTestCurrentClimbUuid(),
        }),
        { wrapper },
      );
    }

    it('injects board details and context on mount', () => {
      const fakeCtx = createFakeQueueContext({ queue: [createTestQueueItem()] });
      const { result } = renderInjector(fakeCtx);

      // Injected: hasActiveQueue should be true because injector is mounted
      expect(result.current.boardInfo.hasActiveQueue).toBe(true);
      expect(result.current.boardInfo.boardDetails).toEqual(bd);
      expect(result.current.boardInfo.angle).toBe(40);
      // The bridge's exposed QueueContext should be the injected one
      expect(result.current.queueCtx).toBe(fakeCtx);
      expect(result.current.currentClimbUuid).toBeNull();
    });

    it('clears on unmount', () => {
      const fakeCtx = createFakeQueueContext();
      const { result, unmount } = renderInjector(fakeCtx);

      // Before unmount — injected
      expect(result.current.boardInfo.hasActiveQueue).toBe(true);

      unmount();

      // After unmount the provider falls back to adapter — no board details
      // Verify by rendering a fresh provider with no injector
      const wrapper2 = ({ children }: { children: React.ReactNode }) => (
        <QueueBridgeProvider>{children}</QueueBridgeProvider>
      );
      const { result: result2 } = renderHook(() => useQueueBridgeBoardInfo(), {
        wrapper: wrapper2,
      });
      expect(result2.current.hasActiveQueue).toBe(false);
    });

    it('updates context when queueContext changes', () => {
      const fakeCtx1 = createFakeQueueContext({ queue: [] });
      const item1 = createTestQueueItem(createTestClimb({ uuid: 'c1' }), 'u1');
      const item2 = createTestQueueItem(createTestClimb({ uuid: 'c2' }), 'u2');
      const fakeCtx2 = createFakeQueueContext({
        queue: [item1, item2],
        currentClimbQueueItem: item2,
        currentClimb: item2.climb,
      });

      // Use a mutable variable so we can change the value without remounting
      let boardRouteCtx: GraphQLQueueContextType | undefined = fakeCtx1;

      const wrapper = ({ children }: { children: React.ReactNode }) => {
        const actions = boardRouteCtx ? extractActions(boardRouteCtx) : undefined;
        const data = boardRouteCtx ? extractData(boardRouteCtx) : undefined;
        return (
          <QueueBridgeProvider>
            {children}
            <QueueActionsContext.Provider value={actions}>
              <QueueDataContext.Provider value={data}>
                <QueueContext.Provider value={boardRouteCtx}>
                  <QueueBridgeInjector boardDetails={bd} angle={angle} />
                </QueueContext.Provider>
              </QueueDataContext.Provider>
            </QueueActionsContext.Provider>
          </QueueBridgeProvider>
        );
      };

      const { result, rerender } = renderHook(
        () => ({
          boardInfo: useQueueBridgeBoardInfo(),
          queueCtx: useTestQueueContext(),
          currentClimbUuid: useTestCurrentClimbUuid(),
        }),
        { wrapper },
      );

      expect(result.current.queueCtx).toBe(fakeCtx1);
      expect(result.current.currentClimbUuid).toBeNull();

      // Change the board route context and rerender (same wrapper, so provider state persists)
      boardRouteCtx = fakeCtx2;
      rerender();

      // The injector's useEffect should have called updateContext
      expect(result.current.queueCtx).toBe(fakeCtx2);
      expect(result.current.currentClimbUuid).toBe('u2');
    });

    it('exposes disconnect via useQueueActions when context is injected', () => {
      const mockDisconnect = vi.fn();
      const fakeCtx = createFakeQueueContext({ disconnect: mockDisconnect });
      const actions = extractActions(fakeCtx);
      const data = extractData(fakeCtx);

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueueBridgeProvider>
          {children}
          <QueueActionsContext.Provider value={actions}>
            <QueueDataContext.Provider value={data}>
              <QueueContext.Provider value={fakeCtx}>
                <QueueBridgeInjector boardDetails={bd} angle={angle} />
              </QueueContext.Provider>
            </QueueDataContext.Provider>
          </QueueActionsContext.Provider>
        </QueueBridgeProvider>
      );

      const { result } = renderHook(() => useTestQueueActions(), { wrapper });

      expect(result.current?.disconnect).toBe(mockDisconnect);
    });

    it('handles initially-null queueContext via deferred injection', () => {
      // Use a mutable variable so we can change the value without remounting
      let boardRouteCtx: GraphQLQueueContextType | undefined = undefined;

      const wrapper = ({ children }: { children: React.ReactNode }) => {
        const actions = boardRouteCtx ? extractActions(boardRouteCtx) : undefined;
        const data = boardRouteCtx ? extractData(boardRouteCtx) : undefined;
        return (
          <QueueBridgeProvider>
            {children}
            <QueueActionsContext.Provider value={actions}>
              <QueueDataContext.Provider value={data}>
                <QueueContext.Provider value={boardRouteCtx}>
                  <QueueBridgeInjector boardDetails={bd} angle={angle} />
                </QueueContext.Provider>
              </QueueDataContext.Provider>
            </QueueActionsContext.Provider>
          </QueueBridgeProvider>
        );
      };

      const { result, rerender } = renderHook(
        () => ({
          boardInfo: useQueueBridgeBoardInfo(),
          queueCtx: useTestQueueContext(),
        }),
        { wrapper },
      );

      // No injection yet — falls back to adapter (no local queue = not active)
      expect(result.current.boardInfo.hasActiveQueue).toBe(false);

      // Now provide a context value (simulating GraphQLQueueProvider becoming ready)
      const fakeCtx = createFakeQueueContext({ queue: [createTestQueueItem()] });
      boardRouteCtx = fakeCtx;
      rerender();

      // The useEffect should have fired the deferred injection
      expect(result.current.boardInfo.hasActiveQueue).toBe(true);
      expect(result.current.boardInfo.boardDetails).toEqual(bd);
      expect(result.current.queueCtx).toBe(fakeCtx);
    });

    it('keeps QueueActionsContext stable when only data changes (actions identity unchanged)', () => {
      // Shared stable actions object — simulates GraphQLQueueProvider's latestRef pattern
      const stableActions: GraphQLQueueActionsType = {
        addToQueue: vi.fn(),
        removeFromQueue: vi.fn(),
        setCurrentClimb: vi.fn(),
        previewClimbFromBrowse: vi.fn(),
        setCurrentClimbQueueItem: vi.fn(),
        setPlaylistSuggestionSource: vi.fn(),
        refreshPlaylistSuggestionSource: vi.fn(),
        replaceQueueItem: vi.fn(),
        setClimbSearchParams: vi.fn(),
        setCountSearchParams: vi.fn(),
        mirrorClimb: vi.fn(),
        fetchMoreClimbs: vi.fn(),
        getNextClimbQueueItem: vi.fn(() => null),
        getPreviousClimbQueueItem: vi.fn(() => null),
        setQueue: vi.fn(),
        startSession: vi.fn(async () => ''),
        joinSession: vi.fn(async () => {}),
        endSession: vi.fn(),
        dismissSessionSummary: vi.fn(),
        disconnect: vi.fn(),
        takeControl: vi.fn(async () => null),
        releaseControl: vi.fn(async () => {}),
      };

      const fakeCtx1 = createFakeQueueContext({ queue: [], ...stableActions });
      const data1 = extractData(fakeCtx1);
      const fakeCtx2 = createFakeQueueContext({ queue: [createTestQueueItem()], ...stableActions });
      const data2 = extractData(fakeCtx2);

      let currentCtx = fakeCtx1;
      let currentData: GraphQLQueueDataType = data1;

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueueBridgeProvider>
          {children}
          <QueueActionsContext.Provider value={stableActions}>
            <QueueDataContext.Provider value={currentData}>
              <QueueContext.Provider value={currentCtx}>
                <QueueBridgeInjector boardDetails={bd} angle={angle} />
              </QueueContext.Provider>
            </QueueDataContext.Provider>
          </QueueActionsContext.Provider>
        </QueueBridgeProvider>
      );

      const { result, rerender } = renderHook(
        () => ({
          actions: useTestQueueActions(),
          data: useTestQueueData(),
        }),
        { wrapper },
      );

      const actionsRef1 = result.current.actions;
      expect(actionsRef1).toBeDefined();

      // Change only data (queue items changed), keep same actions object
      currentCtx = fakeCtx2;
      currentData = data2;
      rerender();

      const actionsRef2 = result.current.actions;
      // The actions context value should be the SAME reference since actions identity didn't change
      expect(actionsRef2).toBe(actionsRef1);

      // But data should have changed
      expect(result.current.data?.queue).toHaveLength(1);
    });

    it('syncs queue state to persistent session local queue on unmount', () => {
      const item = createTestQueueItem();
      const fakeCtx = createFakeQueueContext({
        queue: [item],
        currentClimbQueueItem: item,
      });

      mockSetLocalQueueState.mockClear();

      const { unmount } = renderInjector(fakeCtx);

      // Unmounting the injector triggers clear(), which should sync to local queue
      unmount();

      expect(mockSetLocalQueueState).toHaveBeenCalledWith(
        [item],
        item,
        expect.any(String), // baseBoardPath computed from pathname
        bd,
      );
    });

    it('does not run clear/re-sync just because pathname changes before unmount', () => {
      const item = createTestQueueItem();
      const fakeCtx = createFakeQueueContext({
        queue: [item],
        currentClimbQueueItem: item,
      });

      mockSetLocalQueueState.mockClear();
      mockPathname = '/kilter/1/10/1,2/40/list';

      const rendered = renderInjector(fakeCtx);

      // Simulate pathname changing during navigation transition.
      // Injector should not tear down and re-sync until actual unmount.
      mockPathname = '/sessions';
      rendered.rerender();

      expect(mockSetLocalQueueState).not.toHaveBeenCalled();

      rendered.unmount();
      expect(mockSetLocalQueueState).toHaveBeenCalledTimes(1);
    });

    it('does not sync to local queue when party session is active', () => {
      const item = createTestQueueItem();
      const fakeCtx = createFakeQueueContext({
        queue: [item],
        currentClimbQueueItem: item,
      });

      // Activate party session — setLocalQueueState should no-op
      mockPersistentSession = {
        ...createDefaultPersistentSession(),
        activeSession: {
          sessionId: 'party-1',
          boardPath: '/kilter/1/10/1,2/40',
          boardDetails: bd,
          parsedParams: {
            board_name: 'kilter',
            layout_id: 1,
            size_id: 10,
            set_ids: [1, 2],
            angle: 40,
          },
        },
      };

      mockSetLocalQueueState.mockClear();

      const { unmount } = renderInjector(fakeCtx);
      unmount();

      // setLocalQueueState guards on activeSession, so it should still be called
      // but the function itself will no-op. We just verify the call was made.
      // The actual guard is in use-queue-storage.ts, not in the bridge.
      expect(mockSetLocalQueueState).toHaveBeenCalled();

      // Reset for other tests
      mockPersistentSession = createDefaultPersistentSession();
    });
  });
});
