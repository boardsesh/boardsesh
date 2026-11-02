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
import type { LocalQueueSnapshot } from '../../../lib/queue-snapshot-store';

const storage = vi.hoisted(() => ({
  snapshot: null as LocalQueueSnapshot | null,
  /** When set, the snapshot read waits for the test to release it. */
  gate: null as Promise<void> | null,
}));
vi.mock('../../../lib/queue-snapshot-store', () => ({
  getStoredQueueSnapshot: vi.fn(async () => {
    if (storage.gate) await storage.gate;
    return storage.snapshot;
  }),
  setStoredQueueSnapshot: vi.fn(async () => undefined),
  getQueueSnapshotGeneration: () => 0,
}));
vi.mock('../../../lib/session-store', () => ({
  getStoredSessionId: vi.fn(async () => null),
  clearStoredSessionId: vi.fn(),
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
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
function useRestoreHarness(seen: Seen[]) {
  const [state, dispatch] = useReducer(queueReducer, {}, initialState);
  const stateRef = useRef<QueueState>(state);
  stateRef.current = state;
  const sessionIdRef = useRef<string | null>(null);
  const { restored } = useQueuePersistence({
    authenticatedUserId: 'viewer',
    identityReady: true,
    dispatch,
    sessionIdRef,
    setSessionId: vi.fn(),
    stateRef,
    sessionId: null,
    queue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
    playlistSuggestionSource: null,
    setPlaylistSuggestionSourceState: vi.fn(),
    activeBoardSettled: true,
  });
  seen.push({ current: state.currentClimbQueueItem?.uuid ?? null, restored });
  return { state, restored, dispatch };
}

beforeEach(() => {
  storage.snapshot = null;
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

  it('stays false in screenshot mode, where nothing restores', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    storage.snapshot = savedQueue(makeItem('queue-restored'));
    const { result } = renderHook(() => useRestoreHarness([]));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.restored).toBe(false);
    expect(result.current.state.currentClimbQueueItem).toBeNull();
  });
});
