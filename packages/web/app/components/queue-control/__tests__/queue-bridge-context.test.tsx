import { describe, it, expect, vi, beforeEach } from 'vitest';
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
const mockLoadStoredQueue = vi.fn().mockResolvedValue(null);

let mockPersistentSession: Record<string, unknown> = {};

vi.mock('../../persistent-session', () => ({
  usePersistentSession: () => mockPersistentSession,
  usePersistentSessionState: () => mockPersistentSession,
  usePersistentSessionActions: () => mockPersistentSession,
}));

vi.mock('../../graphql-queue/QueueContext', () => {
  const React = require('react');
  const ctx = React.createContext(undefined);
  const actionsCtx = React.createContext(undefined);
  const dataCtx = React.createContext(undefined);
  return {
    QueueContext: ctx,
    QueueActionsContext: actionsCtx,
    QueueDataContext: dataCtx,
    __esModule: true,
  };
});

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

// Now import the SUT — after all vi.mock calls
import {
  QueueBridgeProvider,
  QueueBridgeInjector,
  useQueueBridgeBoardInfo,
} from '../queue-bridge-context';
import { QueueContext, QueueActionsContext, QueueDataContext } from '../../graphql-queue/QueueContext';
import type { GraphQLQueueContextType } from '../../graphql-queue/QueueContext';
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
    loadStoredQueue: mockLoadStoredQueue,
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

/** Hook to read the split QueueActionsContext */
function useTestQueueActions() {
  return React.useContext(QueueActionsContext);
}

/** Hook to read the split QueueDataContext */
function useTestQueueData() {
  return React.useContext(QueueDataContext);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('queue-bridge-context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUuidCounter = 0;
    mockPersistentSession = createDefaultPersistentSession();
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
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueueBridgeProvider>
          {/* Hook (children) reads bridge's QueueContext = effectiveContext */}
          {children}
          {/* Inner provider simulates GraphQLQueueProvider on board route */}
          <QueueContext.Provider value={boardRouteCtx}>
            <QueueBridgeInjector boardDetails={bd} angle={angle} />
          </QueueContext.Provider>
        </QueueBridgeProvider>
      );

      return renderHook(
        () => ({
          boardInfo: useQueueBridgeBoardInfo(),
          queueCtx: useTestQueueContext(),
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
      const { result: result2 } = renderHook(() => useQueueBridgeBoardInfo(), { wrapper: wrapper2 });
      expect(result2.current.hasActiveQueue).toBe(false);
    });

    it('updates context when queueContext changes', () => {
      const fakeCtx1 = createFakeQueueContext({ queue: [] });
      const fakeCtx2 = createFakeQueueContext({ queue: [createTestQueueItem()] });

      // Use a mutable variable so we can change the value without remounting
      let boardRouteCtx: GraphQLQueueContextType | undefined = fakeCtx1;

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueueBridgeProvider>
          {children}
          <QueueContext.Provider value={boardRouteCtx}>
            <QueueBridgeInjector boardDetails={bd} angle={angle} />
          </QueueContext.Provider>
        </QueueBridgeProvider>
      );

      const { result, rerender } = renderHook(
        () => ({
          boardInfo: useQueueBridgeBoardInfo(),
          queueCtx: useTestQueueContext(),
        }),
        { wrapper },
      );

      expect(result.current.queueCtx).toBe(fakeCtx1);

      // Change the board route context and rerender (same wrapper, so provider state persists)
      boardRouteCtx = fakeCtx2;
      rerender();

      // The injector's useEffect should have called updateContext
      expect(result.current.queueCtx).toBe(fakeCtx2);
    });

    it('provides disconnect through useQueueActions when injected', () => {
      const mockDisconnect = vi.fn();
      const fakeCtx = createFakeQueueContext({ disconnect: mockDisconnect });
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueueBridgeProvider>
          {children}
          <QueueContext.Provider value={fakeCtx}>
            <QueueBridgeInjector boardDetails={bd} angle={angle} />
          </QueueContext.Provider>
        </QueueBridgeProvider>
      );

      const { result } = renderHook(
        () => ({
          actions: useTestQueueActions(),
          data: useTestQueueData(),
        }),
        { wrapper },
      );

      expect(result.current.actions).toBeDefined();
      expect(result.current.actions!.disconnect).toBe(mockDisconnect);
      // disconnect should not be in data
      expect((result.current.data as unknown as Record<string, unknown>)?.disconnect).toBeUndefined();
    });

    it('provides disconnect through useQueueActions in adapter mode', () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueueBridgeProvider>{children}</QueueBridgeProvider>
      );

      const { result } = renderHook(
        () => ({
          actions: useTestQueueActions(),
        }),
        { wrapper },
      );

      expect(result.current.actions).toBeDefined();
      expect(result.current.actions!.disconnect).toBe(mockDeactivateSession);
    });

    it('handles initially-null queueContext via deferred injection', () => {
      // Use a mutable variable so we can change the value without remounting
      let boardRouteCtx: GraphQLQueueContextType | undefined = undefined;

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueueBridgeProvider>
          {children}
          <QueueContext.Provider value={boardRouteCtx}>
            <QueueBridgeInjector boardDetails={bd} angle={angle} />
          </QueueContext.Provider>
        </QueueBridgeProvider>
      );

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
  });
});
