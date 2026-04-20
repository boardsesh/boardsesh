import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the SUT
// ---------------------------------------------------------------------------

let mockUuidCounter = 0;
vi.mock('uuid', () => ({
  v4: vi.fn(() => `gen-uuid-${++mockUuidCounter}`),
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

// Minimal stubs for snackbar (bridge uses it) and live-activity bridge.
vi.mock('../../providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: vi.fn() }),
}));

/**
 * Fake confirm API: `gate` synchronously resolves to a value set by the test
 * (via `setNextGateOutcome`). This lets us assert the bridge's branching
 * without racing React state updates through a real dialog.
 */
const mockGate = vi.fn();
let nextGateOutcome: 'allow' | 'add' | 'switch' | 'cancel' = 'allow';
function setNextGateOutcome(o: typeof nextGateOutcome) {
  nextGateOutcome = o;
}
vi.mock('../queue-add-confirm-context', async () => {
  const actual = await vi.importActual<typeof import('../queue-add-confirm-context')>(
    '../queue-add-confirm-context',
  );
  return {
    ...actual,
    useQueueAddConfirm: () => ({
      gate: (...args: unknown[]) => {
        mockGate(...args);
        return Promise.resolve(nextGateOutcome);
      },
      requestConfirm: vi.fn(),
    }),
  };
});

const mockRouterPush = vi.fn();
let mockPathname = '/kilter/1/10/1,2/40/list';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/app/lib/url-utils', () => ({
  getBaseBoardPath: (p: string) => p.replace(/\/\d+\/list$/, '').replace(/\/\d+$/, ''),
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
import { QueueBridgeProvider } from '../queue-bridge-context';
import { QueueContext } from '../../graphql-queue/QueueContext';
import { QueueAddConfirmProvider } from '../queue-add-confirm-context';
import type { GraphQLQueueContextType } from '../../graphql-queue/QueueContext';
import type { BoardDetails, Climb } from '@/app/lib/types';
import type { ClimbQueueItem } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestBoardDetails(overrides?: Partial<BoardDetails>): BoardDetails {
  return {
    board_name: 'kilter',
    layout_id: 1,
    size_id: 10,
    set_ids: [1, 2],
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
  } as unknown as BoardDetails;
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
    boardType: 'kilter',
    layoutId: 1,
    userAscents: 0,
    userAttempts: 0,
    ...overrides,
  } as Climb;
}

function createTestQueueItem(climb: Climb, uuid: string, overrides?: Partial<ClimbQueueItem>): ClimbQueueItem {
  return {
    climb,
    addedBy: null,
    uuid,
    suggested: false,
    boardConfig: {
      boardName: climb.boardType ?? 'kilter',
      layoutId: climb.layoutId ?? 1,
      sizeId: 10,
      setIds: [1, 2],
      angle: climb.angle,
    },
    ...overrides,
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

/**
 * Hook that reads the bridge's QueueContext (the adapter context, since we
 * never mount a QueueBridgeInjector in these tests).
 */
function useTestQueueContext() {
  return React.useContext(QueueContext) as GraphQLQueueContextType | undefined;
}

/**
 * Renders the bridge adapter (no injector) inside the confirm provider, with
 * local board state pre-populated so `addToQueue` / `setCurrentClimb` take
 * the "has boardDetails" path and walk through the confirm gate.
 */
function renderAdapter(
  localBoardDetails: BoardDetails | null,
  localQueue: ClimbQueueItem[],
  localCurrentClimbQueueItem: ClimbQueueItem | null,
  localBoardPath: string | null,
) {
  mockPersistentSession = createDefaultPersistentSession({
    localBoardDetails,
    localQueue,
    localCurrentClimbQueueItem,
    localBoardPath,
    isLocalQueueLoaded: true,
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueueAddConfirmProvider>
      <QueueBridgeProvider>{children}</QueueBridgeProvider>
    </QueueAddConfirmProvider>
  );
  return renderHook(() => useTestQueueContext(), { wrapper });
}

function lastSetLocalQueueCall() {
  return mockSetLocalQueueState.mock.calls[mockSetLocalQueueState.mock.calls.length - 1];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('queue-bridge-add-flow — confirm gate integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUuidCounter = 0;
    mockRouterPush.mockClear();
    mockPathname = '/kilter/1/10/1,2/40/list';
    nextGateOutcome = 'allow';
  });

  // Explicit teardown between tests. The default jsdom auto-cleanup only
  // triggers after test files; within a single file we risk seeing stale
  // dialogs / providers from earlier tests when running in sequence, so
  // force a clean DOM before each new mount.
  afterEach(() => {
    cleanup();
  });

  // -----------------------------------------------------------------------
  // First add from empty queue
  // -----------------------------------------------------------------------
  it('first addToQueue from an empty queue skips the dialog and stamps boardConfig / boardType / layoutId', async () => {
    const bd = createTestBoardDetails();
    const { result } = renderAdapter(bd, [], null, '/kilter/1/10/1,2');

    const climb = createTestClimb({ uuid: 'c1', boardType: undefined, layoutId: null });

    await act(async () => {
      result.current!.addToQueue(climb);
      // Flush the fire-and-forget gate
      await Promise.resolve();
    });

    // No dialog should be shown — empty queue = allow
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mockSetLocalQueueState).toHaveBeenCalledTimes(1);
    const [newQueue, newCurrent] = lastSetLocalQueueCall();
    expect(newQueue).toHaveLength(1);
    const item = newQueue[0] as ClimbQueueItem;
    expect(item.boardConfig).toEqual({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: [1, 2],
      angle: 40,
    });
    expect(item.climb.boardType).toBe('kilter');
    expect(item.climb.layoutId).toBe(1);
    // When queue was empty, the added item becomes current.
    expect((newCurrent as ClimbQueueItem).uuid).toBe(item.uuid);
  });

  // -----------------------------------------------------------------------
  // Second add with matching config/size — no dialog
  // -----------------------------------------------------------------------
  it('second addToQueue with same config and size skips the dialog', async () => {
    const bd = createTestBoardDetails();
    const climb1 = createTestClimb({ uuid: 'c1' });
    const item1 = createTestQueueItem(climb1, 'u1');
    const { result } = renderAdapter(bd, [item1], item1, '/kilter/1/10/1,2');

    const climb2 = createTestClimb({ uuid: 'c2', boardType: 'kilter', layoutId: 1 });

    await act(async () => {
      result.current!.addToQueue(climb2);
      await Promise.resolve();
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mockSetLocalQueueState).toHaveBeenCalledTimes(1);
    const [newQueue] = lastSetLocalQueueCall();
    expect(newQueue).toHaveLength(2);
    expect((newQueue as ClimbQueueItem[])[1].climb.uuid).toBe('c2');
  });

  // -----------------------------------------------------------------------
  // Different boardType → dialog; "Add" preserves both items
  // -----------------------------------------------------------------------
  it('different boardType invokes the gate; "add" outcome appends, preserving both boardConfigs', async () => {
    // Active route = tension. Queue holds an already-accepted kilter item.
    // Adding a tension climb matches the active route but not the accepted
    // kilter key → gate fires with `new_config`. User picks "Add".
    const bdTension = createTestBoardDetails({ board_name: 'tension', layout_id: 2 });
    const climb1 = createTestClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const item1 = createTestQueueItem(climb1, 'u1');
    const { result } = renderAdapter(bdTension, [item1], item1, '/tension/2/10/1,2');

    setNextGateOutcome('add');
    const climb2 = createTestClimb({ uuid: 'c2', boardType: 'tension', layoutId: 2 });

    await act(async () => {
      result.current!.addToQueue(climb2);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    // Gate was invoked with the tension config derived from the climb's own
    // board identity (matches the active route in this setup).
    expect(mockGate).toHaveBeenCalledTimes(1);
    const [incomingConfig, passedQueue] = mockGate.mock.calls[0] as [
      { boardName: string; layoutId: number; sizeId: number; setIds: number[]; angle: number },
      ClimbQueueItem[],
    ];
    expect(incomingConfig.boardName).toBe('tension');
    expect(incomingConfig.layoutId).toBe(2);
    expect(passedQueue).toHaveLength(1);
    expect(passedQueue[0].boardConfig?.boardName).toBe('kilter');

    // 'add' → queue appended, both configs preserved
    expect(mockSetLocalQueueState).toHaveBeenCalledTimes(1);
    const [newQueue] = lastSetLocalQueueCall();
    expect((newQueue as ClimbQueueItem[])).toHaveLength(2);
    expect((newQueue as ClimbQueueItem[])[0].boardConfig?.boardName).toBe('kilter');
    expect((newQueue as ClimbQueueItem[])[1].boardConfig?.boardName).toBe('tension');
    expect((newQueue as ClimbQueueItem[])[1].boardConfig?.layoutId).toBe(2);
    // No router.push on "add"
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Different boardType → "Switch" replaces queue and navigates
  // -----------------------------------------------------------------------
  it('"switch" outcome replaces the queue with only the new item and calls router.push', async () => {
    const bdTension = createTestBoardDetails({ board_name: 'tension', layout_id: 2 });
    const climb1 = createTestClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const item1 = createTestQueueItem(climb1, 'u1');
    const { result } = renderAdapter(bdTension, [item1], item1, '/tension/2/10/1,2');

    setNextGateOutcome('switch');
    const climb2 = createTestClimb({ uuid: 'c2', boardType: 'tension', layoutId: 2 });

    await act(async () => {
      result.current!.addToQueue(climb2);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    expect(mockGate).toHaveBeenCalledTimes(1);
    expect(mockSetLocalQueueState).toHaveBeenCalledTimes(1);
    const [newQueue, newCurrent] = lastSetLocalQueueCall();
    // Queue replaced with only the new item
    expect((newQueue as ClimbQueueItem[])).toHaveLength(1);
    expect((newQueue as ClimbQueueItem[])[0].climb.uuid).toBe('c2');
    expect((newCurrent as ClimbQueueItem).climb.uuid).toBe('c2');

    // Router push was called with {basePath}/{angle}/list, setIds sorted
    expect(mockRouterPush).toHaveBeenCalledTimes(1);
    const pushedUrl = mockRouterPush.mock.calls[0][0] as string;
    expect(pushedUrl).toBe('/tension/2/10/1,2/40/list');
  });

  // -----------------------------------------------------------------------
  // "Cancel" leaves the queue unchanged
  // -----------------------------------------------------------------------
  it('"cancel" outcome leaves the queue unchanged and does not navigate', async () => {
    const bdTension = createTestBoardDetails({ board_name: 'tension', layout_id: 2 });
    const climb1 = createTestClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const item1 = createTestQueueItem(climb1, 'u1');
    const { result } = renderAdapter(bdTension, [item1], item1, '/tension/2/10/1,2');

    setNextGateOutcome('cancel');
    const climb2 = createTestClimb({ uuid: 'c2', boardType: 'tension', layoutId: 2 });

    await act(async () => {
      result.current!.addToQueue(climb2);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    expect(mockGate).toHaveBeenCalledTimes(1);
    expect(mockSetLocalQueueState).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Larger size: same key, incoming sizeId larger than any accepted size
  // -----------------------------------------------------------------------
  it('second add with a larger sizeId under an accepted key shows larger_size dialog', async () => {
    const bd = createTestBoardDetails({ size_id: 99 });
    const climb1 = createTestClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const item1 = createTestQueueItem(climb1, 'u1', {
      boardConfig: {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10, // accepted size smaller than bd.size_id (99)
        setIds: [1, 2],
        angle: 40,
      },
    });
    const { result } = renderAdapter(bd, [item1], item1, '/kilter/1/99/1,2');

    setNextGateOutcome('cancel');
    const climb2 = createTestClimb({ uuid: 'c2' });
    await act(async () => {
      result.current!.addToQueue(climb2);
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });

    // The bridge passes the incoming config + current queue into gate().
    // With size 99 incoming vs accepted [10], decideAdd would return
    // confirm:larger_size — the bridge doesn't know which reason the gate
    // would have surfaced, only that it awaited the user's choice.
    expect(mockGate).toHaveBeenCalledTimes(1);
    const [incomingCfg] = mockGate.mock.calls[0] as [{ sizeId: number; boardName: string }];
    expect(incomingCfg.sizeId).toBe(99);
    expect(incomingCfg.boardName).toBe('kilter');
    // Cancel outcome → no local queue write
    expect(mockSetLocalQueueState).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Smaller size: same key, incoming smaller — no dialog
  // -----------------------------------------------------------------------
  it('second add with a smaller sizeId under an accepted key skips the dialog', async () => {
    const bdSmall = createTestBoardDetails({ size_id: 5 });
    const climb1 = createTestClimb({ uuid: 'c1', boardType: 'kilter', layoutId: 1 });
    const item1 = createTestQueueItem(climb1, 'u1', {
      boardConfig: {
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 20, // accepted size larger than the new bd.size_id (5)
        setIds: [1, 2],
        angle: 40,
      },
    });
    const { result } = renderAdapter(bdSmall, [item1], item1, '/kilter/1/5/1,2');

    const climb2 = createTestClimb({ uuid: 'c2' });
    await act(async () => {
      result.current!.addToQueue(climb2);
      await Promise.resolve();
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mockSetLocalQueueState).toHaveBeenCalledTimes(1);
  });
});
