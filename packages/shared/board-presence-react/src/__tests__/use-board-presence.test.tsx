import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type {
  BoardConnectionHolder,
  BoardPresenceClimb,
  BoardPresenceEvent,
  BoardPresenceStats,
} from '@boardsesh/shared-schema';
import { useBoardPresence } from '../use-board-presence';
import {
  BoardPresenceProvider,
  useBoardPresenceActions,
  useBoardPresenceCurrent,
  useBoardPresenceFeed,
  useBoardPresenceHasClimb,
} from '../board-presence-provider';
import type { BoardPresenceClient } from '../types';

// Build a BoardPresenceClimb with only the fields the reducer/hook care about.
const climb = (climbUuid: string, seq: number, overrides: Partial<BoardPresenceClimb> = {}): BoardPresenceClimb => ({
  climbUuid,
  seq,
  sentAt: new Date(seq * 1000).toISOString(),
  name: `Climb ${climbUuid}`,
  angle: 40,
  ...overrides,
});

const setEvent = (presenceClimb: BoardPresenceClimb): BoardPresenceEvent => ({
  __typename: 'BoardClimbSet',
  climb: presenceClimb,
});

const clearEvent = (seq: number): BoardPresenceEvent => ({
  __typename: 'BoardClimbCleared',
  clearedAt: new Date(seq * 1000).toISOString(),
  seq,
});

const emptyStats: BoardPresenceStats = {
  climbsSentCount: 0,
  distinctClimbersCount: 0,
  hardestGrade: null,
  topGrade: null,
  lastSentAt: null,
};

const statsEvent = (seq: number, stats: Partial<BoardPresenceStats>): BoardPresenceEvent => ({
  __typename: 'BoardStatsUpdated',
  stats: { ...emptyStats, ...stats },
  seq,
});

const holder = (overrides: Partial<BoardConnectionHolder> = {}): BoardConnectionHolder => ({
  userId: 'user-1',
  displayName: 'Climber',
  avatarUrl: null,
  lastSentAt: null,
  ...overrides,
});

const connectionEvent = (seq: number, nextHolder: BoardConnectionHolder | null): BoardPresenceEvent => ({
  __typename: 'BoardConnectionChanged',
  holder: nextHolder,
  seq,
});

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
  settled: boolean;
};
function deferred<T>(): Deferred<T> {
  const target: Deferred<T> = {
    promise: Promise.resolve(undefined as T),
    reject: () => {},
    resolve: () => {},
    settled: false,
  };
  const promise = new Promise<T>((res, rej) => {
    target.resolve = (value) => {
      if (target.settled) {
        return;
      }
      target.settled = true;
      res(value);
    };
    target.reject = (reason) => {
      if (target.settled) {
        return;
      }
      target.settled = true;
      rej(reason);
    };
  });
  target.promise = promise;
  return target;
}

function pushDeferred<T>(map: Map<number, Array<Deferred<T>>>, boardId: number): Deferred<T> {
  const next = deferred<T>();
  const entries = map.get(boardId);
  if (entries) {
    entries.push(next);
  } else {
    map.set(boardId, [next]);
  }
  return next;
}

function nextPendingDeferred<T>(map: Map<number, Array<Deferred<T>>>, boardId: number): Deferred<T> {
  const existing = map.get(boardId)?.find((entry) => !entry.settled);
  return existing ?? pushDeferred(map, boardId);
}

// A controllable fake client. `emit` pushes a live event to the current
// subscriber; the recent-climbs / stats fetches return a per-board deferred so a
// test can interleave a live event before the backfill lands AND resolve a
// superseded board's fetch independently (exercising the stale-board guard).
function makeClient() {
  let onEvent: ((event: BoardPresenceEvent) => void) | null = null;
  let onError: ((err: unknown) => void) | null = null;
  let onComplete: (() => void) | null = null;
  const unsubscribe = vi.fn();
  let subscribedBoardId: number | null = null;

  const recentByBoard = new Map<number, Array<Deferred<BoardPresenceClimb[]>>>();
  const statsByBoard = new Map<number, Array<Deferred<BoardPresenceStats>>>();
  const connectionByBoard = new Map<number, Array<Deferred<BoardConnectionHolder | null>>>();

  const reportClimb = vi.fn(async () => true);
  const reportDisconnect = vi.fn(async () => true);
  // Captured separately so assertions reference the bound mock directly
  // (referencing `client.fetchX` trips the unbound-method lint).
  const fetchRecentClimbs = vi.fn((boardId: number) => pushDeferred(recentByBoard, boardId).promise);
  const fetchStats = vi.fn((boardId: number) => pushDeferred(statsByBoard, boardId).promise);
  const fetchConnection = vi.fn((boardId: number) => pushDeferred(connectionByBoard, boardId).promise);
  const subscribeNowPlaying = vi.fn(
    (
      boardId: number,
      handler: (event: BoardPresenceEvent) => void,
      errorHandler?: (err: unknown) => void,
      completeHandler?: () => void,
    ): (() => void) => {
      subscribedBoardId = boardId;
      onEvent = handler;
      onError = errorHandler ?? null;
      onComplete = completeHandler ?? null;
      return unsubscribe;
    },
  );

  const client: BoardPresenceClient = {
    subscribeNowPlaying,
    fetchRecentClimbs,
    fetchStats,
    fetchConnection,
    reportClimb,
    reportDisconnect,
    resolveBoardForSerial: vi.fn(),
  };

  return {
    client,
    unsubscribe,
    reportClimb,
    reportDisconnect,
    fetchRecentClimbs,
    fetchStats,
    fetchConnection,
    subscribeNowPlaying,
    emit: (event: BoardPresenceEvent) => onEvent?.(event),
    emitError: (err: unknown) => onError?.(err),
    emitComplete: () => onComplete?.(),
    getSubscribedBoardId: () => subscribedBoardId,
    resolveRecent: (boardId: number, climbs: BoardPresenceClimb[]) => {
      const target = nextPendingDeferred(recentByBoard, boardId);
      target.resolve(climbs);
      return target.promise;
    },
    rejectRecent: (boardId: number, error: unknown) => {
      const target = nextPendingDeferred(recentByBoard, boardId);
      target.reject(error);
      return target.promise;
    },
    resolveStats: (boardId: number, stats: BoardPresenceStats) => {
      const target = nextPendingDeferred(statsByBoard, boardId);
      target.resolve(stats);
      return target.promise;
    },
    rejectStats: (boardId: number, error: unknown) => {
      const target = nextPendingDeferred(statsByBoard, boardId);
      target.reject(error);
      return target.promise;
    },
    resolveConnection: (boardId: number, nextHolder: BoardConnectionHolder | null) => {
      const target = nextPendingDeferred(connectionByBoard, boardId);
      target.resolve(nextHolder);
      return target.promise;
    },
    rejectConnection: (boardId: number, error: unknown) => {
      const target = nextPendingDeferred(connectionByBoard, boardId);
      target.reject(error);
      return target.promise;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useBoardPresence — null inputs', () => {
  it('stays inert with a null boardId', () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(null, harness.client));
    expect(result.current.currentClimb).toBeNull();
    expect(result.current.history).toEqual([]);
    expect(result.current.isLive).toBe(false);
    // A null boardId must not open a subscription or fire the catch-up fetches.
    expect(harness.getSubscribedBoardId()).toBeNull();
    expect(harness.fetchRecentClimbs).not.toHaveBeenCalled();
  });

  it('stays inert with a null client', () => {
    const { result } = renderHook(() => useBoardPresence(7, null));
    expect(result.current.currentClimb).toBeNull();
    expect(result.current.isLive).toBe(false);
  });

  it('report no-ops (resolves false) when inert', async () => {
    const { result } = renderHook(() => useBoardPresence(null, null));
    await expect(result.current.reportClimb({ uuid: 'q', climb: { uuid: 'c' } } as never, 40)).resolves.toBe(false);
  });
});

describe('useBoardPresence — subscribe before backfill', () => {
  it('subscribes before fetching recent climbs', () => {
    const harness = makeClient();
    renderHook(() => useBoardPresence(1, harness.client));
    // Subscription is attached synchronously in the effect, before the fetches.
    expect(harness.getSubscribedBoardId()).toBe(1);
    expect(harness.fetchRecentClimbs).toHaveBeenCalledWith(1);
    expect(harness.fetchStats).toHaveBeenCalledWith(1);
    expect(harness.subscribeNowPlaying.mock.invocationCallOrder[0]).toBeLessThan(
      harness.fetchRecentClimbs.mock.invocationCallOrder[0],
    );
  });

  it('keeps a live event that lands before the backfill, and a stale backfill does not clobber it', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    // A newer live event (seq 5) arrives DURING catch-up, before the backfill.
    act(() => {
      harness.emit(setEvent(climb('live', 5)));
    });
    expect(result.current.currentClimb?.climbUuid).toBe('live');

    // The backfill resolves with OLDER history (seq 1-3). It must merge into
    // history without regressing the newer live current.
    await act(async () => {
      await harness.resolveRecent(1, [climb('old3', 3), climb('old2', 2), climb('old1', 1)]);
    });

    expect(result.current.currentClimb?.climbUuid).toBe('live');
    expect(result.current.currentClimb?.seq).toBe(5);
    // History contains both the live climb and the backfilled ones, newest-first.
    expect(result.current.history.map((entry) => entry.climbUuid)).toEqual(['live', 'old3', 'old2', 'old1']);
  });

  it('keeps a live clear that lands before backfill from being resurrected by older history', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    act(() => {
      harness.emit(clearEvent(10));
    });
    expect(result.current.currentClimb).toBeNull();

    await act(async () => {
      await harness.resolveRecent(1, [climb('cleared-before-backfill', 9)]);
    });

    expect(result.current.currentClimb).toBeNull();
    expect(result.current.history.map((entry) => entry.climbUuid)).toEqual(['cleared-before-backfill']);
  });

  it('adopts the newest backfilled climb as current when no live event has arrived', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    await act(async () => {
      await harness.resolveRecent(1, [climb('b', 4), climb('a', 2)]);
    });

    expect(result.current.currentClimb?.climbUuid).toBe('b');
    expect(result.current.history.map((entry) => entry.climbUuid)).toEqual(['b', 'a']);
  });

  it('stores stats once the fetch resolves and reports isLive', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));
    expect(result.current.isLive).toBe(true);

    await act(async () => {
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 12, hardestGrade: 'V8' });
    });
    expect(result.current.stats?.climbsSentCount).toBe(12);
    expect(result.current.stats?.hardestGrade).toBe('V8');
  });

  it('updates the stat tiles live from a BoardStatsUpdated push (no re-fetch)', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    await act(async () => {
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 2, distinctClimbersCount: 1 });
    });
    expect(result.current.stats?.climbsSentCount).toBe(2);

    // A tick landed on the wall: the server pushes a fresh snapshot over the
    // subscription. The tiles update without any new fetch call.
    act(() => {
      harness.emit(statsEvent(7, { climbsSentCount: 3, distinctClimbersCount: 2, hardestGrade: 'V9' }));
    });
    expect(result.current.stats?.climbsSentCount).toBe(3);
    expect(result.current.stats?.distinctClimbersCount).toBe(2);
    expect(result.current.stats?.hardestGrade).toBe('V9');
    // The one fetch was the initial seed only — live pushes don't re-fetch.
    expect(harness.fetchStats).toHaveBeenCalledTimes(1);
  });

  it('a live push that arrives before the seed wins; the late seed cannot clobber it', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    // Live stats land first (subscription is attached before the fetch resolves).
    act(() => {
      harness.emit(statsEvent(4, { climbsSentCount: 5 }));
    });
    expect(result.current.stats?.climbsSentCount).toBe(5);

    // The slower cold fetch resolves with a now-stale snapshot — it must not win.
    await act(async () => {
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 1 });
    });
    expect(result.current.stats?.climbsSentCount).toBe(5);
  });

  it('flips isLive false when the subscription reports an error', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));
    expect(result.current.isLive).toBe(true);
    act(() => {
      harness.emitError(new Error('socket dropped'));
    });
    await waitFor(() => expect(result.current.isLive).toBe(false));
  });

  it('flips isLive false when the subscription completes', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));
    expect(result.current.isLive).toBe(true);
    act(() => {
      harness.emitComplete();
    });
    await waitFor(() => expect(result.current.isLive).toBe(false));
  });
});

describe('useBoardPresence — sequence gap recovery', () => {
  it('does not run gap catch-up before the initial recent-climbs fetch establishes a sequence baseline', () => {
    const harness = makeClient();
    renderHook(() => useBoardPresence(1, harness.client));

    act(() => {
      harness.emit(statsEvent(7, { climbsSentCount: 3 }));
    });

    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(1);
    expect(harness.fetchStats).toHaveBeenCalledTimes(1);
    expect(harness.fetchConnection).toHaveBeenCalledTimes(1);
  });

  it('repairs a missed live sequence with a hot-feed catch-up', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    await act(async () => {
      await harness.resolveRecent(1, [climb('first', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 1 });
      await harness.resolveConnection(1, holder({ userId: 'seed-holder' }));
    });

    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(1);
    expect(result.current.history.map((entry) => entry.seq)).toEqual([1]);

    act(() => {
      harness.emit(setEvent(climb('live-newest', 4)));
    });

    expect(result.current.currentClimb?.climbUuid).toBe('live-newest');
    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(2);
    expect(harness.fetchStats).toHaveBeenCalledTimes(2);
    expect(harness.fetchConnection).toHaveBeenCalledTimes(2);

    await act(async () => {
      await harness.resolveRecent(1, [climb('live-newest', 4), climb('missed', 3), climb('first', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 2, hardestGrade: 'V8' });
      await harness.resolveConnection(1, holder({ userId: 'catch-up-holder' }));
    });

    await waitFor(() => expect(result.current.history.map((entry) => entry.seq)).toEqual([4, 3, 1]));
    expect(result.current.currentClimb?.climbUuid).toBe('live-newest');
    expect(result.current.stats?.climbsSentCount).toBe(2);
    expect(result.current.stats?.hardestGrade).toBe('V8');
    expect(result.current.holder?.userId).toBe('catch-up-holder');
  });

  it('does not catch up for duplicate or out-of-order events', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    await act(async () => {
      await harness.resolveRecent(1, [climb('current', 5)]);
    });
    expect(result.current.history.map((entry) => entry.seq)).toEqual([5]);

    act(() => {
      harness.emit(setEvent(climb('older', 4)));
      harness.emit(setEvent(climb('current', 5)));
    });

    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(1);
    expect(harness.fetchStats).toHaveBeenCalledTimes(1);
    expect(harness.fetchConnection).toHaveBeenCalledTimes(1);
  });

  it('repairs history while keeping stale stats and holder when partial catch-up fetches fail', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    await act(async () => {
      await harness.resolveRecent(1, [climb('first', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 1 });
      await harness.resolveConnection(1, holder({ userId: 'seed-holder' }));
    });

    act(() => {
      harness.emit(setEvent(climb('live-newest', 4)));
    });

    await act(async () => {
      await harness.resolveRecent(1, [climb('live-newest', 4), climb('missed', 3), climb('first', 1)]);
      await Promise.all([
        harness.rejectStats(1, new Error('stats fetch failed')).catch(() => undefined),
        harness.rejectConnection(1, new Error('connection fetch failed')).catch(() => undefined),
      ]);
    });

    await waitFor(() => expect(result.current.history.map((entry) => entry.seq)).toEqual([4, 3, 1]));
    expect(result.current.stats?.climbsSentCount).toBe(1);
    expect(result.current.holder?.userId).toBe('seed-holder');
  });

  it('coalesces multiple gaps while a catch-up is already in flight and reruns once', async () => {
    const harness = makeClient();
    renderHook(() => useBoardPresence(1, harness.client));

    await act(async () => {
      await harness.resolveRecent(1, [climb('first', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 1 });
      await harness.resolveConnection(1, holder({ userId: 'seed-holder' }));
    });

    act(() => {
      harness.emit(statsEvent(3, { climbsSentCount: 2 }));
    });
    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(2);

    act(() => {
      harness.emit(connectionEvent(5, holder({ userId: 'second-gap' })));
    });
    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(2);

    await act(async () => {
      await harness.resolveRecent(1, [climb('first', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 2 });
      await harness.resolveConnection(1, holder({ userId: 'first-catch-up' }));
    });

    await waitFor(() => expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(3));

    await act(async () => {
      await harness.resolveRecent(1, [climb('first', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 2 });
      await harness.resolveConnection(1, holder({ userId: 'second-catch-up' }));
    });

    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(3);
  });
});

describe('useBoardPresence — switching boards', () => {
  it('resets state, resubscribes, and ignores the old board’s late async', async () => {
    const harness = makeClient();
    const { result, rerender } = renderHook(({ boardId }) => useBoardPresence(boardId, harness.client), {
      initialProps: { boardId: 1 },
    });

    act(() => {
      harness.emit(setEvent(climb('board1', 9)));
    });
    expect(result.current.currentClimb?.climbUuid).toBe('board1');

    // Switch to board 2 BEFORE board 1's fetch resolves.
    rerender({ boardId: 2 });

    // State reset for the new board; resubscribed to board 2.
    expect(result.current.currentClimb).toBeNull();
    expect(result.current.history).toEqual([]);
    expect(harness.getSubscribedBoardId()).toBe(2);
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);

    // Board 1's late backfill resolves AFTER the switch — it must be ignored
    // (the stale-board guard rejects a result for a superseded boardId).
    await act(async () => {
      await harness.resolveRecent(1, [climb('board1-late', 3)]);
    });
    expect(result.current.history).toEqual([]);
    expect(result.current.currentClimb).toBeNull();

    // Board 2's own live event applies normally.
    act(() => {
      harness.emit(setEvent(climb('board2', 2)));
    });
    expect(result.current.currentClimb?.climbUuid).toBe('board2');
  });

  it('resets stats on board switch and ignores the old board’s late stats fetch', async () => {
    const harness = makeClient();
    const { result, rerender } = renderHook(({ boardId }) => useBoardPresence(boardId, harness.client), {
      initialProps: { boardId: 1 },
    });

    await act(async () => {
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 7, hardestGrade: 'V7' });
    });
    expect(result.current.stats?.climbsSentCount).toBe(7);

    // Switch to board 2: the prior wall's tiles must not bleed into the next.
    rerender({ boardId: 2 });
    expect(result.current.stats).toBeNull();

    // A late stats fetch for board 1 resolving after the switch is ignored.
    await act(async () => {
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 99 });
    });
    expect(result.current.stats).toBeNull();

    // Board 2's own stats seed populates normally.
    await act(async () => {
      await harness.resolveStats(2, { ...emptyStats, climbsSentCount: 1 });
    });
    expect(result.current.stats?.climbsSentCount).toBe(1);
  });

  it('ignores a late gap catch-up from the previous board after switching boards', async () => {
    const harness = makeClient();
    const { result, rerender } = renderHook(({ boardId }) => useBoardPresence(boardId, harness.client), {
      initialProps: { boardId: 1 },
    });

    await act(async () => {
      await harness.resolveRecent(1, [climb('board1-current', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 1 });
      await harness.resolveConnection(1, holder({ userId: 'board1-holder' }));
    });

    act(() => {
      harness.emit(setEvent(climb('board1-gap', 4)));
    });
    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(2);

    rerender({ boardId: 2 });
    expect(result.current.currentClimb).toBeNull();
    expect(result.current.history).toEqual([]);

    await act(async () => {
      await harness.resolveRecent(1, [climb('board1-gap', 4), climb('board1-missed', 3)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 2 });
      await harness.resolveConnection(1, holder({ userId: 'late-board1-holder' }));
    });

    expect(result.current.currentClimb).toBeNull();
    expect(result.current.history).toEqual([]);
    expect(result.current.stats).toBeNull();
    expect(result.current.holder).toBeNull();
  });

  it('unsubscribes on unmount', () => {
    const harness = makeClient();
    const { unmount } = renderHook(() => useBoardPresence(1, harness.client));
    expect(harness.unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('useBoardPresence — actions', () => {
  it('reportClimb forwards the active boardId, climb, and angle', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(3, harness.client));
    const input = { uuid: 'q1', climb: { uuid: 'c1' } } as never;

    await act(async () => {
      await result.current.reportClimb(input, 25);
    });

    expect(harness.reportClimb).toHaveBeenCalledWith(3, input, 25);
  });

  it('reportClimbWithUndoTarget captures the current climb before the report resolves', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(3, harness.client));
    act(() => {
      harness.emit(setEvent(climb('restore-me', 1, { angle: 30, queueItemUuid: 'qi-restore' })));
    });

    let reportResult = { accepted: false, undoTarget: null as BoardPresenceClimb | null };
    await act(async () => {
      reportResult = await result.current.reportClimbWithUndoTarget(
        { uuid: 'q2', climb: { uuid: 'takeover' } } as never,
        40,
      );
    });

    expect(reportResult.accepted).toBe(true);
    expect(reportResult.undoTarget?.climbUuid).toBe('restore-me');
    expect(result.current.undoTarget?.climbUuid).toBe('restore-me');
    expect(result.current.getUndoTarget()?.climbUuid).toBe('restore-me');
  });

  it('reportDisconnect forwards the active boardId to the client', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(3, harness.client));

    let accepted = false;
    await act(async () => {
      accepted = await result.current.reportDisconnect();
    });

    expect(accepted).toBe(true);
    expect(harness.reportDisconnect).toHaveBeenCalledWith(3);
  });

  it('reportDisconnect resolves false when inert', async () => {
    const { result } = renderHook(() => useBoardPresence(null, null));
    await expect(result.current.reportDisconnect()).resolves.toBe(false);
  });
});

describe('useBoardPresence — hydrating & refresh', () => {
  it('reports isHydrating until both the recent-climbs and stats seeds settle', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));
    // Skeleton flag is up from the moment the board binds.
    expect(result.current.isHydrating).toBe(true);

    // Only the recent fetch settled — stats still pending keeps hydration up.
    await act(async () => {
      await harness.resolveRecent(1, [climb('a', 2)]);
    });
    expect(result.current.isHydrating).toBe(true);

    await act(async () => {
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 1 });
    });
    await waitFor(() => expect(result.current.isHydrating).toBe(false));
  });

  it('re-raises isHydrating synchronously on a board switch (no empty-state frame)', async () => {
    const harness = makeClient();
    const { result, rerender } = renderHook(({ boardId }) => useBoardPresence(boardId, harness.client), {
      initialProps: { boardId: 1 as number | null },
    });

    await act(async () => {
      await harness.resolveRecent(1, [climb('a', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 1 });
    });
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    // Switching boards shows the skeleton again immediately — the render-phase
    // reset raises it before the bind effect runs, so no empty-state flash.
    rerender({ boardId: 2 });
    expect(result.current.isHydrating).toBe(true);

    await act(async () => {
      await harness.resolveRecent(2, [climb('b', 1)]);
      await harness.resolveStats(2, { ...emptyStats, climbsSentCount: 1 });
    });
    await waitFor(() => expect(result.current.isHydrating).toBe(false));

    // Unbinding (null board) drops the skeleton too.
    rerender({ boardId: null });
    expect(result.current.isHydrating).toBe(false);
  });

  it('refresh re-fetches and merges recent climbs, stats, and holder while toggling isRefreshing', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    await act(async () => {
      await harness.resolveRecent(1, [climb('first', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 1 });
      await harness.resolveConnection(1, holder({ userId: 'seed' }));
    });
    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(1);
    expect(result.current.isRefreshing).toBe(false);

    let refreshPromise: Promise<void> = Promise.resolve();
    act(() => {
      refreshPromise = result.current.refresh();
    });
    // The synchronous part of refresh sets the flag and fires the fetches.
    expect(result.current.isRefreshing).toBe(true);
    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(2);
    expect(harness.fetchStats).toHaveBeenCalledTimes(2);

    await act(async () => {
      await harness.resolveRecent(1, [climb('second', 2), climb('first', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 5, hardestGrade: 'V5' });
      await harness.resolveConnection(1, holder({ userId: 'after-refresh' }));
      await refreshPromise;
    });

    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.history.map((entry) => entry.seq)).toEqual([2, 1]);
    expect(result.current.stats?.climbsSentCount).toBe(5);
    expect(result.current.holder?.userId).toBe('after-refresh');
  });

  it('coalesces a refresh requested while one is already in flight (no double fetch)', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    await act(async () => {
      await harness.resolveRecent(1, [climb('first', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 1 });
      await harness.resolveConnection(1, holder({ userId: 'seed' }));
    });

    let firstRefresh: Promise<void> = Promise.resolve();
    act(() => {
      firstRefresh = result.current.refresh();
    });
    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(2);

    // A second tap while the first is in flight is a no-op (guarded by the ref).
    act(() => {
      void result.current.refresh();
    });
    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(2);

    await act(async () => {
      await harness.resolveRecent(1, [climb('first', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 1 });
      await harness.resolveConnection(1, holder({ userId: 'seed' }));
      await firstRefresh;
    });
    expect(result.current.isRefreshing).toBe(false);
  });

  it('ignores a refresh result for a board that was switched away mid-flight', async () => {
    const harness = makeClient();
    const { result, rerender } = renderHook(({ boardId }) => useBoardPresence(boardId, harness.client), {
      initialProps: { boardId: 1 },
    });

    await act(async () => {
      await harness.resolveRecent(1, [climb('b1', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 1 });
      await harness.resolveConnection(1, holder({ userId: 'b1' }));
    });

    let refreshPromise: Promise<void> = Promise.resolve();
    act(() => {
      refreshPromise = result.current.refresh();
    });

    // Switch boards before board 1's refresh resolves.
    rerender({ boardId: 2 });
    expect(result.current.history).toEqual([]);

    await act(async () => {
      await harness.resolveRecent(1, [climb('b1-late', 9)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 99 });
      await harness.resolveConnection(1, holder({ userId: 'b1-late' }));
      await refreshPromise;
    });

    // The stale board-1 refresh must not write into board 2's state.
    expect(result.current.history).toEqual([]);
    expect(result.current.stats).toBeNull();
    expect(result.current.holder).toBeNull();
  });

  it('refresh is a no-op when inert', async () => {
    const { result } = renderHook(() => useBoardPresence(null, null));
    await expect(result.current.refresh()).resolves.toBeUndefined();
    expect(result.current.isRefreshing).toBe(false);
  });

  it('refresh applies the successful fetches even when one (stats) fails', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    await act(async () => {
      await harness.resolveRecent(1, [climb('first', 1)]);
      await harness.resolveStats(1, { ...emptyStats, climbsSentCount: 1 });
      await harness.resolveConnection(1, holder({ userId: 'seed' }));
    });

    let refreshPromise: Promise<void> = Promise.resolve();
    act(() => {
      refreshPromise = result.current.refresh();
    });

    await act(async () => {
      await harness.resolveRecent(1, [climb('second', 2), climb('first', 1)]);
      await harness.rejectStats(1, new Error('stats 503')).catch(() => undefined);
      await harness.resolveConnection(1, holder({ userId: 'after' }));
      await refreshPromise;
    });

    // History and holder update from the fulfilled fetches; stats keeps its prior
    // value rather than clobbering it with a half-failed snapshot.
    expect(result.current.history.map((entry) => entry.seq)).toEqual([2, 1]);
    expect(result.current.stats?.climbsSentCount).toBe(1);
    expect(result.current.holder?.userId).toBe('after');
    expect(result.current.isRefreshing).toBe(false);
  });

  it('refresh is a no-op while the initial hydration is still in flight', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));
    // Seeds are still pending, so the board is hydrating.
    expect(result.current.isHydrating).toBe(true);
    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });

    // The refresh bailed: no extra fetches piled on top of the in-flight seeds.
    expect(harness.fetchRecentClimbs).toHaveBeenCalledTimes(1);
    expect(harness.fetchStats).toHaveBeenCalledTimes(1);
    expect(result.current.isRefreshing).toBe(false);
  });
});

describe('useBoardPresence — connection holder', () => {
  it('seeds the holder from fetchConnection for a late joiner', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));
    expect(harness.fetchConnection).toHaveBeenCalledWith(1);
    expect(result.current.holder).toBeNull();

    await act(async () => {
      await harness.resolveConnection(1, holder({ userId: 'alice', displayName: 'Alice' }));
    });
    expect(result.current.holder?.userId).toBe('alice');
    expect(result.current.holder?.displayName).toBe('Alice');
  });

  it('updates the holder live from a BoardConnectionChanged push', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    act(() => {
      harness.emit(connectionEvent(2, holder({ userId: 'bob', displayName: 'Bob' })));
    });
    expect(result.current.holder?.userId).toBe('bob');

    // A later push frees the board.
    act(() => {
      harness.emit(connectionEvent(3, null));
    });
    expect(result.current.holder).toBeNull();
  });

  it('a live push that arrives before the seed wins; the late seed cannot clobber it', async () => {
    const harness = makeClient();
    const { result } = renderHook(() => useBoardPresence(1, harness.client));

    act(() => {
      harness.emit(connectionEvent(4, holder({ userId: 'live' })));
    });
    expect(result.current.holder?.userId).toBe('live');

    await act(async () => {
      await harness.resolveConnection(1, holder({ userId: 'stale-seed' }));
    });
    expect(result.current.holder?.userId).toBe('live');
  });

  it('resets the holder on board switch', async () => {
    const harness = makeClient();
    const { result, rerender } = renderHook(({ boardId }) => useBoardPresence(boardId, harness.client), {
      initialProps: { boardId: 1 },
    });

    act(() => {
      harness.emit(connectionEvent(2, holder({ userId: 'board1-holder' })));
    });
    expect(result.current.holder?.userId).toBe('board1-holder');

    rerender({ boardId: 2 });
    expect(result.current.holder).toBeNull();
  });
});

describe('BoardPresenceProvider — split contexts', () => {
  it('keeps action-only consumers stable when current/feed state changes', async () => {
    const harness = makeClient();
    const renderCounts = { actions: 0, current: 0, feed: 0 };
    const currentSnapshots: Array<ReturnType<typeof useBoardPresenceCurrent>> = [];
    const feedSnapshots: Array<ReturnType<typeof useBoardPresenceFeed>> = [];

    function ActionConsumer() {
      renderCounts.actions += 1;
      useBoardPresenceActions();
      return null;
    }

    function CurrentConsumer() {
      renderCounts.current += 1;
      currentSnapshots.push(useBoardPresenceCurrent());
      return null;
    }

    function FeedConsumer() {
      renderCounts.feed += 1;
      feedSnapshots.push(useBoardPresenceFeed());
      return null;
    }

    function Consumers() {
      return (
        <>
          <ActionConsumer />
          <CurrentConsumer />
          <FeedConsumer />
        </>
      );
    }

    render(
      <BoardPresenceProvider boardId={1} client={harness.client}>
        <Consumers />
      </BoardPresenceProvider>,
    );

    await waitFor(() => expect(currentSnapshots.at(-1)?.isLive).toBe(true));
    const actionRenderCountAfterAttach = renderCounts.actions;

    act(() => {
      harness.emit(setEvent(climb('live-context', 4)));
    });

    await waitFor(() => expect(currentSnapshots.at(-1)?.currentClimb?.climbUuid).toBe('live-context'));
    expect(feedSnapshots.at(-1)?.history.map((entry) => entry.climbUuid)).toEqual(['live-context']);
    expect(renderCounts.actions).toBe(actionRenderCountAfterAttach);
    expect(renderCounts.current).toBeGreaterThan(1);
    expect(renderCounts.feed).toBeGreaterThan(1);
  });

  it('exposes a presence-only hasClimb that flips on appear/disappear, not on climb identity', async () => {
    const harness = makeClient();
    let hasClimbRenderCount = 0;
    const hasClimbSnapshots: boolean[] = [];

    function HasClimbConsumer() {
      hasClimbRenderCount += 1;
      hasClimbSnapshots.push(useBoardPresenceHasClimb());
      return null;
    }

    render(
      <BoardPresenceProvider boardId={1} client={harness.client}>
        <HasClimbConsumer />
      </BoardPresenceProvider>,
    );

    // Live feed, no climb yet → false.
    await waitFor(() => expect(hasClimbSnapshots.at(-1)).toBe(false));

    // A climb appears → flips true (one re-render of the hasClimb consumer).
    act(() => {
      harness.emit(setEvent(climb('first', 1)));
    });
    await waitFor(() => expect(hasClimbSnapshots.at(-1)).toBe(true));
    const rendersAfterAppear = hasClimbRenderCount;

    // The climb CHANGES identity (board-level climb change). hasClimb stays true,
    // so the presence-only consumer must NOT re-render — this is what keeps the
    // accessory host mounted across a change (no doubled snapshot).
    act(() => {
      harness.emit(setEvent(climb('second', 2)));
    });
    expect(hasClimbSnapshots.at(-1)).toBe(true);
    expect(hasClimbRenderCount).toBe(rendersAfterAppear);

    // Clearing the wall flips it back to false.
    act(() => {
      harness.emit(clearEvent(3));
    });
    await waitFor(() => expect(hasClimbSnapshots.at(-1)).toBe(false));
  });
});
