// @vitest-environment jsdom
//
// #4979 (docs/current-climb-outside-queue.md, sections 6 and 9): the clock the
// Bluetooth auto-sender's stale-climb hold reads. Solo it lives in the queue
// snapshot as `lastCurrentChangeAt`, which the save effect writes unchanged
// while `savedAt` moves on every write; in a session every FullSync reseeds it
// from the room's `currentChangedAt`. Driven through the real reducer, the real
// clock hook and the real persistence hook, with only storage and "now" faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useReducer, useRef } from 'react';
import { initialState, queueReducer, type ClimbQueueItem, type QueueState } from '@boardsesh/queue';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { LocalQueueSnapshot } from '../../../lib/queue-snapshot-store';
import { isStaleCurrentClimb, STALE_CURRENT_HOLD_MS } from '../../../lib/ble/stale-current-hold';

const time = vi.hoisted(() => ({ now: Date.parse('2026-10-20T08:00:00.000Z') }));
vi.mock('../../../lib/clock', () => ({ nowMs: () => time.now, nowDate: () => new Date(time.now) }));

const storage = vi.hoisted(() => ({ snapshot: null as LocalQueueSnapshot | null, writes: 0 }));
vi.mock('../../../lib/queue-snapshot-store', () => ({
  getStoredQueueSnapshot: vi.fn(async () => storage.snapshot),
  // Mirrors the real store: whatever the caller hands over, plus a fresh
  // `savedAt` stamped at write time.
  setStoredQueueSnapshot: vi.fn(async (snapshot: Omit<LocalQueueSnapshot, 'savedAt'>) => {
    storage.writes += 1;
    storage.snapshot = { ...snapshot, ownerUserId: null, savedAt: new Date(time.now).toISOString() };
  }),
  getQueueSnapshotGeneration: () => 0,
}));
vi.mock('../../../lib/session-store', () => ({
  getStoredSessionId: vi.fn(async () => null),
  clearStoredSessionId: vi.fn(),
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));

import {
  resetQueueSnapshotRestoredReportForTests,
  SOLO_QUEUE_SAVE_DEBOUNCE_MS,
  useQueuePersistence,
} from '../use-queue-persistence';
import { useCurrentChangeClock } from '../use-current-change-clock';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeItem(uuid: string, climbUuid = `climb-${uuid}`, angle = 40): ClimbQueueItem {
  return {
    uuid,
    climb: {
      uuid: climbUuid,
      name: `Climb ${uuid}`,
      frames: 'p1r12',
      angle,
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

/** The provider's wiring for these three pieces, without the rest of it. */
function useSoloQueueHarness() {
  const [state, reducerDispatch] = useReducer(queueReducer, {}, initialState);
  const {
    clock: lastCurrentChange,
    seedCurrentChange,
    dispatch,
  } = useCurrentChangeClock(state.currentClimbQueueItem?.uuid ?? null, reducerDispatch);
  const stateRef = useRef<QueueState>(state);
  stateRef.current = state;
  const sessionIdRef = useRef<string | null>(null);
  useQueuePersistence({
    authenticatedUserId: 'viewer',
    identityReady: true,
    dispatch,
    sessionIdRef,
    setSessionId: vi.fn(),
    stateRef,
    sessionId: null,
    queue: state.queue,
    currentClimbQueueItem: state.currentClimbQueueItem,
    historyCount: state.historyCount,
    lastCurrentChange,
    seedCurrentChange,
    playlistSuggestionSource: null,
    setPlaylistSuggestionSourceState: vi.fn(),
    activeBoardSettled: true,
  });
  return { state, lastCurrentChange, dispatch };
}

/** The session side: the reducer and the clock, fed FullSyncs and deltas. */
function useSessionQueueHarness() {
  const [state, reducerDispatch] = useReducer(queueReducer, {}, initialState);
  const { clock: lastCurrentChange, dispatch } = useCurrentChangeClock(
    state.currentClimbQueueItem?.uuid ?? null,
    reducerDispatch,
  );
  return { state, lastCurrentChange, dispatch };
}

function snapshotWithCurrent(
  current: ClimbQueueItem,
  fields: { lastCurrentChangeAt?: string; savedAt: string; queue?: ClimbQueueItem[] },
): LocalQueueSnapshot {
  return {
    queue: fields.queue ?? [makeItem('history-1'), current, makeItem('up-next-1')],
    currentClimbQueueItem: current,
    playlistSuggestionSource: null,
    ...(fields.lastCurrentChangeAt ? { lastCurrentChangeAt: fields.lastCurrentChangeAt } : {}),
    savedAt: fields.savedAt,
    ownerUserId: null,
  };
}

async function launch() {
  const rendered = renderHook(() => useSoloQueueHarness());
  await waitFor(() => expect(rendered.result.current.state.currentClimbQueueItem).not.toBeNull());
  return rendered;
}

async function outlastSaveDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SOLO_QUEUE_SAVE_DEBOUNCE_MS + 50));
  });
}

beforeEach(() => {
  time.now = Date.parse('2026-10-20T08:00:00.000Z');
  storage.snapshot = null;
  storage.writes = 0;
  analytics.track.mockClear();
  resetQueueSnapshotRestoredReportForTests();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('solo: the snapshot carries the hold clock', () => {
  it('holds a climb whose lastCurrentChangeAt is 5 h old, and lights one set 1 h ago', async () => {
    const current = makeItem('current');
    storage.snapshot = snapshotWithCurrent(current, {
      lastCurrentChangeAt: new Date(time.now - 5 * HOUR).toISOString(),
      savedAt: new Date(time.now - 10 * 60 * 1000).toISOString(),
    });
    const held = await launch();
    expect(held.result.current.lastCurrentChange).toEqual({
      queueItemUuid: 'current',
      changedAt: time.now - 5 * HOUR,
    });
    expect(isStaleCurrentClimb(held.result.current.lastCurrentChange, 'current', time.now)).toBe(true);
    held.unmount();

    resetQueueSnapshotRestoredReportForTests();
    storage.snapshot = snapshotWithCurrent(current, {
      lastCurrentChangeAt: new Date(time.now - HOUR).toISOString(),
      savedAt: new Date(time.now - HOUR).toISOString(),
    });
    const lit = await launch();
    expect(isStaleCurrentClimb(lit.result.current.lastCurrentChange, 'current', time.now)).toBe(false);
    lit.unmount();
  });

  it('still holds after three relaunches over five days with no queue change', async () => {
    const current = makeItem('current');
    const setAt = time.now;
    storage.snapshot = snapshotWithCurrent(current, {
      lastCurrentChangeAt: new Date(setAt).toISOString(),
      savedAt: new Date(setAt).toISOString(),
    });
    for (const dayOffset of [1, 3, 5]) {
      time.now = setAt + dayOffset * DAY;
      resetQueueSnapshotRestoredReportForTests();
      const writesBefore = storage.writes;
      const rendered = await launch();
      // The restore's UPDATE_QUEUE gives `queue` a new identity, so the save
      // effect writes again: `savedAt` moves, the clock does not.
      await outlastSaveDebounce();
      expect(storage.writes).toBeGreaterThan(writesBefore);
      expect(storage.snapshot?.savedAt).toBe(new Date(time.now).toISOString());
      expect(storage.snapshot?.lastCurrentChangeAt).toBe(new Date(setAt).toISOString());
      expect(isStaleCurrentClimb(rendered.result.current.lastCurrentChange, 'current', time.now)).toBe(true);
      rendered.unmount();
    }
  });

  it('seeds an older snapshot without the field from savedAt, once', async () => {
    const current = makeItem('current');
    const savedAt = time.now - 6 * HOUR;
    storage.snapshot = snapshotWithCurrent(current, { savedAt: new Date(savedAt).toISOString() });
    const rendered = await launch();
    expect(rendered.result.current.lastCurrentChange.changedAt).toBe(savedAt);
    expect(isStaleCurrentClimb(rendered.result.current.lastCurrentChange, 'current', time.now)).toBe(true);
    await outlastSaveDebounce();
    // The next save writes the field, so `savedAt` is never read for it again.
    expect(storage.snapshot?.lastCurrentChangeAt).toBe(new Date(savedAt).toISOString());
    expect(analytics.track).toHaveBeenCalledWith(
      SHARED_EVENTS.QueueSnapshotRestored,
      expect.objectContaining({ lastCurrentChangeSource: 'savedAt', lastCurrentChangeAgeHours: 6 }),
    );
    rendered.unmount();
  });

  it('keeps holding after an Up next add 10 min ago, a regrade and a hydrate-style rebuild', async () => {
    const current = makeItem('current');
    storage.snapshot = snapshotWithCurrent(current, {
      lastCurrentChangeAt: new Date(time.now - 5 * HOUR).toISOString(),
      savedAt: new Date(time.now - 5 * HOUR).toISOString(),
    });
    const rendered = await launch();
    act(() => {
      rendered.result.current.dispatch({ type: 'DELTA_ADD_QUEUE_ITEM', payload: { item: makeItem('tonight') } });
    });
    time.now += 10 * 60 * 1000;
    act(() => {
      rendered.result.current.dispatch({
        type: 'REGRADE_CLIMBS',
        payload: {
          grades: {
            'climb-current': {
              angle: 45,
              difficulty: 'V4',
              quality_average: '3.0',
              ascensionist_count: 1,
              benchmark_difficulty: null,
            },
          },
        },
      });
    });
    // A hydrate replaces the current item with a richer copy under the same uuid.
    act(() => {
      const { queue, currentClimbQueueItem } = rendered.result.current.state;
      rendered.result.current.dispatch({
        type: 'UPDATE_QUEUE',
        payload: {
          queue: queue.map((item) => ({ ...item, climb: { ...item.climb } })),
          currentClimbQueueItem: currentClimbQueueItem ? { ...currentClimbQueueItem } : null,
        },
      });
    });
    expect(rendered.result.current.state.queue.map((item) => item.uuid)).toContain('tonight');
    expect(rendered.result.current.lastCurrentChange.changedAt).toBe(time.now - 5 * HOUR - 10 * 60 * 1000);
    expect(isStaleCurrentClimb(rendered.result.current.lastCurrentChange, 'current', time.now)).toBe(true);
    await outlastSaveDebounce();
    expect(storage.snapshot?.lastCurrentChangeAt).toBe(new Date(time.now - 5 * HOUR - 10 * 60 * 1000).toISOString());
    rendered.unmount();
  });

  it('holds a climb left in memory for 5 h, and a new current climb starts the clock again', async () => {
    const rendered = renderHook(() => useSoloQueueHarness());
    await outlastSaveDebounce();
    act(() => {
      rendered.result.current.dispatch({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: makeItem('evening'), shouldAddToQueue: true },
      });
    });
    const setAt = time.now;
    expect(rendered.result.current.lastCurrentChange).toEqual({ queueItemUuid: 'evening', changedAt: setAt });
    time.now = setAt + STALE_CURRENT_HOLD_MS + HOUR;
    expect(isStaleCurrentClimb(rendered.result.current.lastCurrentChange, 'evening', time.now)).toBe(true);
    act(() => {
      rendered.result.current.dispatch({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: makeItem('morning'), shouldAddToQueue: true },
      });
    });
    expect(rendered.result.current.lastCurrentChange).toEqual({ queueItemUuid: 'morning', changedAt: time.now });
    expect(isStaleCurrentClimb(rendered.result.current.lastCurrentChange, 'morning', time.now)).toBe(false);
    rendered.unmount();
  });

  it('reports Queue Snapshot Restored once per launch with the line and Up next copies', async () => {
    const current = makeItem('current');
    storage.snapshot = snapshotWithCurrent(current, {
      lastCurrentChangeAt: new Date(time.now - 2 * HOUR).toISOString(),
      savedAt: new Date(time.now - HOUR).toISOString(),
      queue: [
        makeItem('history-1'),
        current,
        makeItem('copy-a', 'climb-repeat'),
        makeItem('copy-b', 'climb-repeat'),
        makeItem('other-angle', 'climb-repeat', 45),
        makeItem('single'),
      ],
    });
    const rendered = await launch();
    const restoredCalls = analytics.track.mock.calls.filter(([event]) => event === SHARED_EVENTS.QueueSnapshotRestored);
    expect(restoredCalls).toEqual([
      [
        SHARED_EVENTS.QueueSnapshotRestored,
        {
          historyCount: 1,
          upNextCount: 4,
          // climb-repeat at 40° twice; the 45° copy is another climb by the match key.
          upNextDuplicates: 1,
          hasCurrent: true,
          lastCurrentChangeAgeHours: 2,
          lastCurrentChangeSource: 'snapshot',
        },
      ],
    ]);
    rendered.unmount();
    const relaunch = await launch();
    expect(analytics.track.mock.calls.filter(([event]) => event === SHARED_EVENTS.QueueSnapshotRestored)).toHaveLength(
      1,
    );
    relaunch.unmount();
  });
});

describe('session: every FullSync reseeds the clock from currentChangedAt', () => {
  const roomChangedAt = '2026-10-20T03:00:00.000Z';

  function fullSync(current: ClimbQueueItem | null, currentChangedAt: string | null) {
    const queue = current ? [makeItem('history-1'), current, makeItem('up-next-1')] : [makeItem('history-1')];
    return {
      type: 'INITIAL_QUEUE_DATA' as const,
      payload: { queue, currentClimbQueueItem: current, historyCount: null, currentChangedAt },
    };
  }

  it('holds on join when the room changed its climb 5 h ago, and keeps holding through reconnect, watchdog and gap resyncs', () => {
    const rendered = renderHook(() => useSessionQueueHarness());
    act(() => {
      rendered.result.current.dispatch(fullSync(makeItem('room-climb'), roomChangedAt));
    });
    expect(rendered.result.current.lastCurrentChange).toEqual({
      queueItemUuid: 'room-climb',
      changedAt: Date.parse(roomChangedAt),
    });
    expect(isStaleCurrentClimb(rendered.result.current.lastCurrentChange, 'room-climb', time.now)).toBe(true);
    // The reconnect FullSync, the watchdog resync and the sequence-gap resync
    // all rebuild the same item and land as the same action, arriving later.
    for (const minutesLater of [2, 30, 61]) {
      time.now += minutesLater * 60 * 1000;
      act(() => {
        rendered.result.current.dispatch(fullSync(makeItem('room-climb'), roomChangedAt));
      });
      expect(rendered.result.current.lastCurrentChange.changedAt).toBe(Date.parse(roomChangedAt));
      expect(isStaleCurrentClimb(rendered.result.current.lastCurrentChange, 'room-climb', time.now)).toBe(true);
    }
    rendered.unmount();
  });

  it('keeps holding when a crewmate adds to Up next, and moves only when the current climb changes', () => {
    const rendered = renderHook(() => useSessionQueueHarness());
    act(() => {
      rendered.result.current.dispatch(fullSync(makeItem('room-climb'), roomChangedAt));
    });
    time.now += 10 * 60 * 1000;
    act(() => {
      rendered.result.current.dispatch({
        type: 'DELTA_ADD_QUEUE_ITEM',
        payload: { item: makeItem('tonight') },
      });
    });
    expect(isStaleCurrentClimb(rendered.result.current.lastCurrentChange, 'room-climb', time.now)).toBe(true);
    // A crewmate's pick arrives as a server delta to another uuid.
    act(() => {
      rendered.result.current.dispatch({
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: makeItem('tonight'), isServerEvent: true },
      });
    });
    expect(rendered.result.current.lastCurrentChange).toEqual({ queueItemUuid: 'tonight', changedAt: time.now });
    rendered.unmount();
  });

  it('without currentChangedAt keeps the local time for the same climb and uses arrival time for another', () => {
    const rendered = renderHook(() => useSessionQueueHarness());
    act(() => {
      rendered.result.current.dispatch(fullSync(makeItem('room-climb'), roomChangedAt));
    });
    time.now += HOUR;
    act(() => {
      rendered.result.current.dispatch(fullSync(makeItem('room-climb'), null));
    });
    expect(rendered.result.current.lastCurrentChange.changedAt).toBe(Date.parse(roomChangedAt));
    act(() => {
      rendered.result.current.dispatch(fullSync(makeItem('other-climb'), null));
    });
    expect(rendered.result.current.lastCurrentChange).toEqual({ queueItemUuid: 'other-climb', changedAt: time.now });
    rendered.unmount();
  });

  it('keeps a solo hold through Start session: the seed stamps the room now, the older time wins', () => {
    const rendered = renderHook(() => useSessionQueueHarness());
    // The solo queue as the clock knows it: the climb went current 5 h ago.
    act(() => {
      rendered.result.current.dispatch(fullSync(makeItem('solo-climb'), roomChangedAt));
    });
    // createSessionWithConfig seeds the room with the same current item, and
    // the room stamps `currentChangedAt = now` for a room with no stored climb.
    act(() => {
      rendered.result.current.dispatch(fullSync(makeItem('solo-climb'), new Date(time.now).toISOString()));
    });
    expect(rendered.result.current.lastCurrentChange).toEqual({
      queueItemUuid: 'solo-climb',
      changedAt: Date.parse(roomChangedAt),
    });
    expect(isStaleCurrentClimb(rendered.result.current.lastCurrentChange, 'solo-climb', time.now)).toBe(true);
    rendered.unmount();
  });

  it('lets an older room time win over a young local one for the same climb', () => {
    const rendered = renderHook(() => useSessionQueueHarness());
    act(() => {
      rendered.result.current.dispatch(fullSync(makeItem('room-climb'), null));
    });
    expect(rendered.result.current.lastCurrentChange.changedAt).toBe(time.now);
    act(() => {
      rendered.result.current.dispatch(fullSync(makeItem('room-climb'), roomChangedAt));
    });
    expect(rendered.result.current.lastCurrentChange.changedAt).toBe(Date.parse(roomChangedAt));
    rendered.unmount();
  });

  it('removing the current climb advances the clock (null counts as a value)', () => {
    const rendered = renderHook(() => useSessionQueueHarness());
    act(() => {
      rendered.result.current.dispatch(fullSync(makeItem('room-climb'), roomChangedAt));
    });
    act(() => {
      rendered.result.current.dispatch({ type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: 'room-climb' } });
    });
    expect(rendered.result.current.lastCurrentChange).toEqual({ queueItemUuid: null, changedAt: time.now });
    rendered.unmount();
  });
});
