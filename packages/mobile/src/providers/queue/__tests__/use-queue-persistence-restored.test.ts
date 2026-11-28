// @vitest-environment jsdom
//
// Plan item 5: the `restored` signal the queue provider hands LastPickWatcher
// (QueueRestoredContext). It must turn true in the very render that lands the
// restored climb, or the watcher would read the restore's change of current as
// the climber's and drop a pick made from a notification or a link while the
// saved queue was loading. Driven through the real reducer and the real
// persistence hook, with only storage faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useReducer, useRef } from 'react';
import { initialState, queueReducer, type ClimbQueueItem, type QueueState } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';
import { QUANTUM_BOARD_FLAG } from '@boardsesh/board-config/capabilities';
import { isBoardConfigVisible, type BoardVisibilityConfig } from '@boardsesh/board-config/visibility';
import type { LocalQueueSnapshot } from '../../../lib/queue-snapshot-store';

const storage = vi.hoisted(() => ({
  sessionId: null as string | null,
  readFailure: null as Error | null,
  clearSession: vi.fn(),
  sessionStatus: vi.fn(),
  setSession: vi.fn(),
  setSnapshot: vi.fn(async () => undefined),
  snapshot: null as LocalQueueSnapshot | null,
  /** When set, the snapshot read waits for the test to release it. */
  gate: null as Promise<void> | null,
}));
vi.mock('../../../lib/queue-snapshot-store', () => ({
  getStoredQueueSnapshot: vi.fn(async () => {
    if (storage.gate) await storage.gate;
    return storage.snapshot;
  }),
  setStoredQueueSnapshot: storage.setSnapshot,
  getQueueSnapshotGeneration: () => 0,
}));
vi.mock('../../../lib/session-store', () => ({
  getStoredSessionId: vi.fn(async () => {
    if (storage.readFailure) throw storage.readFailure;
    return storage.sessionId;
  }),
  clearStoredSessionId: storage.clearSession,
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: storage.sessionStatus }) }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));

import { resetQueueSnapshotRestoredReportForTests, useQueuePersistence } from '../use-queue-persistence';

function makeItem(uuid: string): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: `climb-${uuid}`,
      name: `Climb ${uuid}`,
      frames: 'p1r12',
      angle: 40,
      setter_username: 'setter',
      ascensionist_count: 0,
      difficulty: 'V3',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.3',
      benchmark_difficulty: null,
    },
  };
}

function savedQueue(current: ClimbQueueItem | null): LocalQueueSnapshot {
  return {
    queue: current ? [current, makeItem('up-next')] : [makeItem('up-next')],
    currentClimbQueueItem: current,
    playlistSuggestionSource: null,
    savedAt: '2026-11-01T08:00:00.000Z',
    ownerUserId: null,
  };
}

type Seen = { current: string | null; restored: boolean };

/** The provider's wiring for the restore, recording what every render saw. */
function useRestoreHarness(
  seen: Seen[],
  boardPolicy?: Pick<
    Parameters<typeof useQueuePersistence>[0],
    'activeBoardRolloutBlocked' | 'getSessionRestoreBoard' | 'isBoardAvailable'
  >,
) {
  const [state, dispatch] = useReducer(queueReducer, {}, initialState);
  const stateRef = useRef<QueueState>(state);
  stateRef.current = state;
  const sessionIdRef = useRef<string | null>(null);
  const { restored, sessionAuthorityReady, beginClearingSavedSession } = useQueuePersistence({
    authenticatedUserId: 'viewer',
    identityReady: true,
    dispatch,
    sessionIdRef,
    setSessionId: storage.setSession,
    stateRef,
    sessionId: null,
    queue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
    playlistSuggestionSource: null,
    setPlaylistSuggestionSourceState: vi.fn(),
    activeBoardSettled: true,
    ...boardPolicy,
  });
  seen.push({ current: state.currentClimbQueueItem?.uuid ?? null, restored });
  return { state, restored, sessionAuthorityReady, beginClearingSavedSession, dispatch };
}

beforeEach(() => {
  storage.snapshot = null;
  storage.sessionId = null;
  storage.readFailure = null;
  storage.clearSession.mockClear();
  storage.setSession.mockClear();
  storage.setSnapshot.mockClear();
  storage.sessionStatus
    .mockReset()
    .mockResolvedValue({ sessionStatus: 'active', sessionRestoreBoardPath: 'kilter/1/10/1/40' });
  storage.gate = null;
  resetQueueSnapshotRestoredReportForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('useQueuePersistence: restored', () => {
  it('turns true in the same render that lands the restored climb', async () => {
    storage.snapshot = savedQueue(makeItem('queue-restored'));
    const seen: Seen[] = [];
    const { result } = renderHook(() => useRestoreHarness(seen));
    expect(result.current.restored).toBe(false);
    await waitFor(() => expect(result.current.state.currentClimbQueueItem?.uuid).toBe('queue-restored'));
    expect(result.current.restored).toBe(true);
    expect(seen[0]).toEqual({ current: null, restored: false });
    // No render ever showed the restored climb as a change the climber made.
    expect(seen.filter((entry) => entry.current === 'queue-restored' && !entry.restored)).toEqual([]);
  });

  it('turns true with nothing saved, leaving the queue empty', async () => {
    const { result } = renderHook(() => useRestoreHarness([]));
    await waitFor(() => expect(result.current.restored).toBe(true));
    expect(result.current.state.currentClimbQueueItem).toBeNull();
  });

  it('turns true without touching a current that landed first', async () => {
    let release = () => {};
    storage.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    storage.snapshot = savedQueue(makeItem('queue-restored'));
    const { result } = renderHook(() => useRestoreHarness([]));
    act(() => {
      result.current.dispatch({
        type: 'UPDATE_QUEUE',
        payload: { queue: [makeItem('queue-put-up')], currentClimbQueueItem: makeItem('queue-put-up') },
      });
    });
    expect(result.current.restored).toBe(false);
    await act(async () => release());
    await waitFor(() => expect(result.current.restored).toBe(true));
    expect(result.current.state.currentClimbQueueItem?.uuid).toBe('queue-put-up');
  });

  it('restores the real queue regardless of retired capture flags', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    storage.snapshot = savedQueue(makeItem('queue-restored'));
    const { result } = renderHook(() => useRestoreHarness([]));
    await waitFor(() => expect(result.current.restored).toBe(true));
    expect(result.current.state.currentClimbQueueItem?.uuid).toBe('queue-restored');
  });
});

it('blocks cold Quantum session restore without erasing the session or solo snapshot', async () => {
  storage.sessionId = 'quantum-crew';
  storage.snapshot = savedQueue(makeItem('private-solo-queue'));
  const getSessionRestoreBoard = async () =>
    ({
      boardType: 'quantum',
      layoutId: 9104,
      sizeId: 9204,
      setIds: '1',
    }) as UserBoard;
  const disabled = (board: BoardVisibilityConfig) => isBoardConfigVisible(board);
  const enabled = (board: BoardVisibilityConfig) => isBoardConfigVisible(board, { [QUANTUM_BOARD_FLAG]: true });
  const { result, rerender } = renderHook(
    ({ isBoardAvailable }) => useRestoreHarness([], { getSessionRestoreBoard, isBoardAvailable }),
    { initialProps: { isBoardAvailable: disabled } },
  );

  await waitFor(() => expect(result.current.restored).toBe(true));
  expect(storage.sessionStatus).not.toHaveBeenCalled();
  expect(storage.setSession).not.toHaveBeenCalled();
  expect(storage.clearSession).not.toHaveBeenCalled();
  expect(storage.setSnapshot).not.toHaveBeenCalled();

  rerender({ isBoardAvailable: enabled });
  await waitFor(() => expect(storage.setSession).toHaveBeenCalledWith('quantum-crew'));
  expect(storage.clearSession).not.toHaveBeenCalled();
});

it('does not restore a Quantum crew when the separately selected board is Kilter', async () => {
  storage.sessionId = 'quantum-crew';
  storage.sessionStatus.mockResolvedValue({
    sessionStatus: 'active',
    sessionRestoreBoardPath: 'quantum/9104/9204/1/35',
  });
  const getSessionRestoreBoard = async () =>
    ({
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1',
    }) as UserBoard;
  const { result } = renderHook(() => useRestoreHarness([], { getSessionRestoreBoard }));

  await waitFor(() => expect(result.current.restored).toBe(true));

  expect(storage.sessionStatus).toHaveBeenCalledTimes(1);
  expect(storage.setSession).not.toHaveBeenCalled();
  expect(storage.clearSession).not.toHaveBeenCalled();
  expect(storage.setSnapshot).not.toHaveBeenCalled();
});

it('lets a returning passenger browse offline without establishing solo wall authority', async () => {
  storage.sessionId = 'quantum-crew';
  storage.snapshot = savedQueue(makeItem('my-offline-climb'));
  storage.sessionStatus.mockRejectedValue(new Error('Offline'));
  const { result } = renderHook(() => useRestoreHarness([]));

  await waitFor(() => expect(result.current.state.currentClimbQueueItem?.uuid).toBe('my-offline-climb'));
  expect(result.current.restored).toBe(true);
  expect(result.current.sessionAuthorityReady).toBe(false);
  expect(storage.clearSession).not.toHaveBeenCalled();

  act(() => {
    const finishClearing = result.current.beginClearingSavedSession();
    finishClearing();
  });
  expect(result.current.sessionAuthorityReady).toBe(true);
});

it('establishes solo wall authority when no crew was saved, including offline', async () => {
  storage.sessionStatus.mockRejectedValue(new Error('Offline'));
  const { result } = renderHook(() => useRestoreHarness([]));
  expect(result.current.sessionAuthorityReady).toBe(false);
  await waitFor(() => expect(result.current.sessionAuthorityReady).toBe(true));
  expect(storage.sessionStatus).not.toHaveBeenCalled();
});

it('preserves solo browsing without establishing wall authority when secure storage cannot be read', async () => {
  storage.readFailure = new Error('Secure storage unavailable');
  storage.snapshot = savedQueue(makeItem('my-offline-climb'));
  const { result } = renderHook(() => useRestoreHarness([]));
  await waitFor(() => expect(result.current.restored).toBe(true));
  expect(result.current.sessionAuthorityReady).toBe(false);
  expect(result.current.state.currentClimbQueueItem?.uuid).toBe('my-offline-climb');
});
