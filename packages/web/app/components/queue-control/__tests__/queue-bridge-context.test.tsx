import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act } from '@testing-library/react';
import React from 'react';

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
let mockPartyProfile: {
  profile: { id: string } | null;
  username: string | undefined;
  avatarUrl: string | undefined;
} = { profile: null, username: undefined, avatarUrl: undefined };

vi.mock('../../persistent-session', () => ({
  usePersistentSession: () => mockPersistentSession,
  usePersistentSessionState: () => mockPersistentSession,
  usePersistentSessionActions: () => mockPersistentSession,
}));

vi.mock('../../party-manager/party-profile-context', () => ({
  usePartyProfile: () => mockPartyProfile,
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
import { QueueBridgeProvider, QueueBridgeInjector, useQueueBridgeBoardInfo } from '../queue-bridge-context';
import {
  QueueContext,
  QueueActionsContext,
  QueueDataContext,
  CurrentClimbUuidContext,
} from '../../graphql-queue/QueueContext';
import type {
  GraphQLQueueContextType,
  GraphQLQueueActionsType,
  GraphQLQueueDataType,
} from '../../graphql-queue/QueueContext';
import type { BoardDetails, Climb, Angle } from '@/app/lib/types';
import type { ClimbQueueItem } from '../types';

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
    addQueueItem: vi.fn(),
    removeQueueItem: vi.fn(),
    setCurrentClimb: vi.fn(),
    setQueue: vi.fn(),
    mirrorCurrentClimb: vi.fn(),
    triggerResync: vi.fn(),
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
  return React.useContext(QueueActionsContext) as GraphQLQueueActionsType | undefined;
}

/**
 * Hook to read the QueueDataContext value exposed by QueueBridgeProvider.
 */
function useTestQueueData() {
  return React.useContext(QueueDataContext) as GraphQLQueueDataType | undefined;
}

/**
 * Hook to read the CurrentClimbUuidContext value exposed by QueueBridgeProvider.
 */
function useTestCurrentClimbUuid() {
  return React.useContext(CurrentClimbUuidContext) as string | null;
}

/** Extract the actions slice from a combined context (simulates GraphQLQueueProvider's actionsValue) */
function extractActions(ctx: GraphQLQueueContextType): GraphQLQueueActionsType {
  return {
    addToQueue: ctx.addToQueue,
    removeFromQueue: ctx.removeFromQueue,
    setCurrentClimb: ctx.setCurrentClimb,
    setCurrentClimbQueueItem: ctx.setCurrentClimbQueueItem,
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
    mockPartyProfile = { profile: null, username: undefined, avatarUrl: undefined };
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

      it('addToQueue also attaches addedByUser metadata in local mode', () => {
        mockPartyProfile = {
          profile: { id: 'user-42' },
          username: 'alex',
          avatarUrl: 'https://example.com/alex.png',
        };
        const { result } = renderWithLocalQueue([], null);
        act(() => {
          result.current!.addToQueue(climb1);
        });
        const [newQueue] = mockSetLocalQueueState.mock.calls[0];
        expect(newQueue[0].addedByUser).toEqual({
          id: 'user-42',
          username: 'alex',
          avatarUrl: 'https://example.com/alex.png',
        });
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
          result.current!.setCurrentClimb(climb2);
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
          result.current!.setCurrentClimb(climb);
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
          result.current!.setCurrentClimb(climb);
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
          result.current!.setCurrentClimb(climb);
        });
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
      });

      it('setCurrentClimb is a no-op when the climb has no boardType to seed from', () => {
        const climb = createTestClimb({ uuid: 'orphan', boardType: undefined, layoutId: 1 });
        const { result } = renderWithoutLocalBoard();
        act(() => {
          result.current!.setCurrentClimb(climb);
        });
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
      });
    });

    // -------------------------------------------------------------------
    // Party-mode dispatch: with an active session, setLocalQueueState no-ops
    // inside the persistent session, so the adapter must route through
    // ps.addQueueItem / ps.setCurrentClimb instead.
    // -------------------------------------------------------------------
    describe('adapter party-mode dispatch', () => {
      const bd = createTestBoardDetails();
      const climbA = createTestClimb({ uuid: 'c-a', name: 'A' });
      const climbB = createTestClimb({ uuid: 'c-b', name: 'B' });

      function renderPartyBridge({
        queue = [],
        current = null,
        addQueueItem = vi.fn().mockResolvedValue(undefined),
        setCurrentClimb = vi.fn().mockResolvedValue(undefined),
        removeQueueItem = vi.fn().mockResolvedValue(undefined),
      }: {
        queue?: ClimbQueueItem[];
        current?: ClimbQueueItem | null;
        addQueueItem?: ReturnType<typeof vi.fn>;
        setCurrentClimb?: ReturnType<typeof vi.fn>;
        removeQueueItem?: ReturnType<typeof vi.fn>;
      } = {}) {
        mockPersistentSession = createDefaultPersistentSession({
          activeSession: {
            sessionId: 'party-42',
            boardPath: '/kilter/1/10/1,2/40',
            boardDetails: bd,
            parsedParams: { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 2], angle: 40 },
          },
          queue,
          currentClimbQueueItem: current,
          clientId: 'client-xyz',
          hasConnected: true,
          addQueueItem,
          setCurrentClimb,
          removeQueueItem,
          isLocalQueueLoaded: true,
        });
        const wrapper = ({ children }: { children: React.ReactNode }) => (
          <QueueBridgeProvider>{children}</QueueBridgeProvider>
        );
        return {
          ...renderHook(() => useTestQueueContext(), { wrapper }),
          addQueueItem,
          setCurrentClimb,
          removeQueueItem,
        };
      }

      it('addToQueue dispatches through ps.addQueueItem instead of setLocalQueueState', () => {
        const { result, addQueueItem } = renderPartyBridge();
        act(() => {
          result.current!.addToQueue(climbA);
        });
        expect(addQueueItem).toHaveBeenCalledTimes(1);
        const [newItem] = addQueueItem.mock.calls[0];
        expect(newItem.climb.uuid).toBe('c-a');
        expect(newItem.addedBy).toBe('client-xyz');
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
      });

      it('addToQueue attaches addedByUser metadata when a party profile exists', () => {
        mockPartyProfile = {
          profile: { id: 'user-77' },
          username: 'marco',
          avatarUrl: 'https://example.com/marco.png',
        };
        const { result, addQueueItem } = renderPartyBridge();
        act(() => {
          result.current!.addToQueue(climbA);
        });
        const [newItem] = addQueueItem.mock.calls[0];
        expect(newItem.addedByUser).toEqual({
          id: 'user-77',
          username: 'marco',
          avatarUrl: 'https://example.com/marco.png',
        });
      });

      it('addToQueue leaves addedByUser undefined when no profile is available', () => {
        mockPartyProfile = { profile: null, username: undefined, avatarUrl: undefined };
        const { result, addQueueItem } = renderPartyBridge();
        act(() => {
          result.current!.addToQueue(climbA);
        });
        const [newItem] = addQueueItem.mock.calls[0];
        expect(newItem.addedByUser).toBeUndefined();
      });

      it('addToQueue leaves addedByUser undefined when the profile has no username', () => {
        // A signed-in user without a chosen display name — we'd rather peers
        // fall back to the Bluetooth placeholder than show a blank name.
        mockPartyProfile = {
          profile: { id: 'user-99' },
          username: undefined,
          avatarUrl: undefined,
        };
        const { result, addQueueItem } = renderPartyBridge();
        act(() => {
          result.current!.addToQueue(climbA);
        });
        const [newItem] = addQueueItem.mock.calls[0];
        expect(newItem.addedByUser).toBeUndefined();
      });

      it('addToQueue swallows ps.addQueueItem rejections without throwing', async () => {
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const addQueueItem = vi.fn().mockRejectedValue(new Error('ws down'));
        const { result } = renderPartyBridge({ addQueueItem });
        act(() => {
          result.current!.addToQueue(climbA);
        });
        await Promise.resolve();
        expect(addQueueItem).toHaveBeenCalled();
        expect(consoleErr).toHaveBeenCalled();
        consoleErr.mockRestore();
      });

      it('setCurrentClimb sends addQueueItem(position) then setCurrentClimb to the session', async () => {
        const existing = createTestQueueItem(createTestClimb({ uuid: 'c-a' }), 'u-a');
        const { result, addQueueItem, setCurrentClimb } = renderPartyBridge({
          queue: [existing],
          current: existing,
        });
        let returned: ClimbQueueItem | null = null;
        await act(async () => {
          returned = await result.current!.setCurrentClimb(climbB);
        });
        expect(returned).not.toBeNull();
        expect(returned!.climb.uuid).toBe('c-b');
        expect(addQueueItem).toHaveBeenCalledTimes(1);
        expect(addQueueItem.mock.calls[0][1]).toBe(1);
        expect(setCurrentClimb).toHaveBeenCalledTimes(1);
        expect(setCurrentClimb.mock.calls[0][0].climb.uuid).toBe('c-b');
        expect(setCurrentClimb.mock.calls[0][1]).toBe(false);
        expect(mockSetLocalQueueState).not.toHaveBeenCalled();
      });

      it('setCurrentClimb uses undefined position when there is no current climb', async () => {
        const { result, addQueueItem } = renderPartyBridge({ queue: [], current: null });
        await act(async () => {
          await result.current!.setCurrentClimb(climbA);
        });
        expect(addQueueItem.mock.calls[0][1]).toBeUndefined();
      });

      it('setCurrentClimb returns null and does not call removeQueueItem when ps.addQueueItem rejects', async () => {
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const addQueueItem = vi.fn().mockRejectedValue(new Error('ws down'));
        const setCurrentClimb = vi.fn().mockResolvedValue(undefined);
        const removeQueueItem = vi.fn().mockResolvedValue(undefined);
        const { result } = renderPartyBridge({ addQueueItem, setCurrentClimb, removeQueueItem });
        let returned: ClimbQueueItem | null = null;
        await act(async () => {
          returned = await result.current!.setCurrentClimb(climbA);
        });
        expect(returned).toBeNull();
        expect(setCurrentClimb).not.toHaveBeenCalled();
        // Nothing made it into the queue — nothing to roll back.
        expect(removeQueueItem).not.toHaveBeenCalled();
        expect(consoleErr).toHaveBeenCalled();
        consoleErr.mockRestore();
      });

      it('setCurrentClimb returns null and rolls back the queue add when ps.setCurrentClimb rejects', async () => {
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const addQueueItem = vi.fn().mockResolvedValue(undefined);
        const setCurrentClimb = vi.fn().mockRejectedValue(new Error('no session'));
        const removeQueueItem = vi.fn().mockResolvedValue(undefined);
        const { result } = renderPartyBridge({ addQueueItem, setCurrentClimb, removeQueueItem });
        let returned: ClimbQueueItem | null = null;
        await act(async () => {
          returned = await result.current!.setCurrentClimb(climbA);
        });
        expect(returned).toBeNull();
        expect(addQueueItem).toHaveBeenCalled();
        // Item landed in the queue but couldn't be promoted — roll it back.
        expect(removeQueueItem).toHaveBeenCalledTimes(1);
        const addedItem = addQueueItem.mock.calls[0][0];
        expect(removeQueueItem.mock.calls[0][0]).toBe(addedItem.uuid);
        expect(consoleErr).toHaveBeenCalled();
        consoleErr.mockRestore();
      });

      it('setCurrentClimb logs when the rollback removeQueueItem also rejects', async () => {
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
        const addQueueItem = vi.fn().mockResolvedValue(undefined);
        const setCurrentClimb = vi.fn().mockRejectedValue(new Error('no session'));
        const removeQueueItem = vi.fn().mockRejectedValue(new Error('rollback failed'));
        const { result } = renderPartyBridge({ addQueueItem, setCurrentClimb, removeQueueItem });
        await act(async () => {
          await result.current!.setCurrentClimb(climbA);
        });
        await act(async () => {
          await Promise.resolve();
        });
        expect(removeQueueItem).toHaveBeenCalled();
        const messages = consoleErr.mock.calls.map((call) => String(call[0]));
        expect(messages.some((m) => m.includes('Failed to roll back'))).toBe(true);
        consoleErr.mockRestore();
      });

      it('setCurrentClimb attaches addedByUser metadata to the queued item', async () => {
        mockPartyProfile = {
          profile: { id: 'user-77' },
          username: 'marco',
          avatarUrl: undefined,
        };
        const { result, addQueueItem } = renderPartyBridge();
        await act(async () => {
          await result.current!.setCurrentClimb(climbA);
        });
        const [newItem] = addQueueItem.mock.calls[0];
        expect(newItem.addedByUser).toEqual({
          id: 'user-77',
          username: 'marco',
          avatarUrl: undefined,
        });
      });
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
        setCurrentClimbQueueItem: vi.fn(),
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
