// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, useMemo, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardPresenceClientContext, type BoardPresenceClient } from '@boardsesh/board-presence-react';
import type { BoardConnectionHolder, BoardPresenceEvent, BoardPresenceStats } from '@boardsesh/shared-schema';
import { useCrewGymBoardHeld } from '../use-crew-gym-board-held';

const lifecycle = vi.hoisted(() => ({
  backgrounded: false,
  effectiveOffline: false,
  connectionEndedListeners: new Set<() => void>(),
}));
vi.mock('../../app-visibility', () => ({ useIsAppBackgrounded: () => lifecycle.backgrounded }));
vi.mock('../../connectivity/use-connectivity', () => ({
  useConnectivityField: () => lifecycle.effectiveOffline,
  selectEffectiveOffline: () => lifecycle.effectiveOffline,
}));
vi.mock('../../graphql/ws-client-lifecycle', () => ({
  subscribeWsConnectionEnded: (listener: () => void) => {
    lifecycle.connectionEndedListeners.add(listener);
    return () => {
      lifecycle.connectionEndedListeners.delete(listener);
    };
  },
}));

const TARGET = { boardId: 7, uuid: '11111111-1111-4111-8111-111111111111' };
const CREW_IDS: ReadonlySet<string> = new Set(['crew-holder']);
const CREW_HOLDER = { userId: 'crew-holder', displayName: 'Crewmate' };
const EMPTY_STATS: BoardPresenceStats = {
  climbsSentCount: 0,
  distinctClimbersCount: 0,
  hardestGrade: null,
  topGrade: null,
  lastSentAt: null,
};

function makePresenceHarness(initialHolder: BoardConnectionHolder | null = null) {
  const streams: Array<{
    boardId: number;
    boardUuid: string | null | undefined;
    onEvent: (event: BoardPresenceEvent) => void;
    onError: ((error: unknown) => void) | undefined;
    onComplete: (() => void) | undefined;
    unsubscribe: () => void;
  }> = [];
  const fetchConnection = vi.fn(async () => initialHolder);
  const subscribeNowPlaying = vi.fn<BoardPresenceClient['subscribeNowPlaying']>(
    (boardId, onEvent, onError, onComplete, boardUuid) => {
      const unsubscribe = vi.fn();
      streams.push({ boardId, boardUuid, onEvent, onError, onComplete, unsubscribe });
      return unsubscribe;
    },
  );
  const fetchRecentClimbs = vi.fn(async () => []);
  const fetchStats = vi.fn(async () => EMPTY_STATS);
  const client: BoardPresenceClient = {
    subscribeNowPlaying,
    fetchConnection,
    fetchRecentClimbs,
    fetchStats,
    reportClimb: vi.fn(async () => false),
    resolveBoardForSerial: vi.fn(async () => {
      throw new Error('Reading a gym holder must not resolve or bind a board');
    }),
  };
  // The active board is deliberately different: target ownership cannot borrow
  // the selected Kilter's presence when the player is showing the MoonBoard.
  let scopedClient: BoardPresenceClient | null = client;
  function Wrapper({ children }: { children: ReactNode }) {
    const context = useMemo(() => ({ boardId: 99, boardUuid: 'active-kilter', client: scopedClient }), [scopedClient]);
    return createElement(BoardPresenceClientContext.Provider, { value: context }, children);
  }
  function publish(holder: BoardConnectionHolder | null, seq: number, streamIndex = streams.length - 1) {
    act(() => streams[streamIndex].onEvent({ __typename: 'BoardConnectionChanged', holder, seq }));
  }
  return {
    client,
    fetchConnection,
    fetchRecentClimbs,
    fetchStats,
    subscribeNowPlaying,
    streams,
    Wrapper,
    publish,
    turnOffline: () => {
      scopedClient = null;
    },
  };
}

beforeEach(() => {
  lifecycle.backgrounded = false;
  lifecycle.effectiveOffline = false;
  lifecycle.connectionEndedListeners.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCrewGymBoardHeld (#7181)', () => {
  it('reads the target board by both id and held link, independently of the active board', async () => {
    const harness = makePresenceHarness(CREW_HOLDER);
    const { result } = renderHook(() => useCrewGymBoardHeld(TARGET, CREW_IDS), { wrapper: harness.Wrapper });

    await waitFor(() => expect(result.current).toBe(true));
    expect(harness.streams[0]).toMatchObject({ boardId: TARGET.boardId, boardUuid: TARGET.uuid });
    expect(harness.fetchConnection).toHaveBeenCalledWith(TARGET.boardId, TARGET.uuid);
    expect(harness.fetchRecentClimbs).not.toHaveBeenCalled();
    expect(harness.fetchStats).not.toHaveBeenCalled();
  });

  it.each([
    ['a cancelled or failed picker', null],
    ['a holder outside the crew', { userId: 'stranger' }],
    ['an anonymous holder', { userId: null }],
  ])('does not claim the crew holds the wall after %s', async (_scenario, holder) => {
    const harness = makePresenceHarness(holder);
    const { result } = renderHook(() => useCrewGymBoardHeld(TARGET, CREW_IDS), { wrapper: harness.Wrapper });

    await act(async () => {});
    expect(harness.fetchConnection).toHaveBeenCalledOnce();
    expect(result.current).toBe(false);
  });

  it('starts no extra feed without a matching crew target', () => {
    const harness = makePresenceHarness(CREW_HOLDER);
    const { result } = renderHook(() => useCrewGymBoardHeld(null, CREW_IDS), { wrapper: harness.Wrapper });

    expect(result.current).toBe(false);
    expect(harness.subscribeNowPlaying).not.toHaveBeenCalled();
    expect(harness.fetchConnection).not.toHaveBeenCalled();
  });

  it('follows a live peer connection and disconnect, ignoring an older holder push', () => {
    const harness = makePresenceHarness();
    const { result } = renderHook(() => useCrewGymBoardHeld(TARGET, CREW_IDS), { wrapper: harness.Wrapper });

    harness.publish(CREW_HOLDER, 1);
    expect(result.current).toBe(true);
    harness.publish(null, 2);
    expect(result.current).toBe(false);
    harness.publish(CREW_HOLDER, 1);
    expect(result.current).toBe(false);
  });

  it('never lets a late holder snapshot overwrite a disconnect', async () => {
    const harness = makePresenceHarness();
    let resolveSnapshot: (holder: BoardConnectionHolder | null) => void = () => {};
    harness.fetchConnection.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const { result } = renderHook(() => useCrewGymBoardHeld(TARGET, CREW_IDS), { wrapper: harness.Wrapper });

    harness.publish(null, 1);
    await act(async () => resolveSnapshot(CREW_HOLDER));
    expect(result.current).toBe(false);
  });

  it('stops recognizing a holder who leaves the crew without opening another feed', async () => {
    const harness = makePresenceHarness(CREW_HOLDER);
    const { result, rerender } = renderHook(({ members }) => useCrewGymBoardHeld(TARGET, members), {
      wrapper: harness.Wrapper,
      initialProps: { members: CREW_IDS },
    });
    await waitFor(() => expect(result.current).toBe(true));

    rerender({ members: new Set<string>() });
    expect(result.current).toBe(false);
    expect(harness.subscribeNowPlaying).toHaveBeenCalledOnce();
  });

  it('clears the previous target and ignores its late events when the board changes', () => {
    const harness = makePresenceHarness();
    const { result, rerender } = renderHook(({ board }) => useCrewGymBoardHeld(board, CREW_IDS), {
      wrapper: harness.Wrapper,
      initialProps: { board: TARGET },
    });
    harness.publish(CREW_HOLDER, 1);
    expect(result.current).toBe(true);

    rerender({ board: { boardId: 8, uuid: '22222222-2222-4222-8222-222222222222' } });
    expect(result.current).toBe(false);
    expect(harness.streams[0].unsubscribe).toHaveBeenCalledOnce();
    harness.publish(CREW_HOLDER, 2, 0);
    expect(result.current).toBe(false);
  });

  it('does not keep a holder authoritative when offline mode removes the client', async () => {
    const harness = makePresenceHarness(CREW_HOLDER);
    const { result, rerender } = renderHook(() => useCrewGymBoardHeld(TARGET, CREW_IDS), { wrapper: harness.Wrapper });
    await waitFor(() => expect(result.current).toBe(true));

    harness.turnOffline();
    rerender();
    expect(result.current).toBe(false);
    expect(harness.streams[0].unsubscribe).toHaveBeenCalledOnce();
  });

  it('offers a move again if the target feed is denied', () => {
    const harness = makePresenceHarness();
    const { result } = renderHook(() => useCrewGymBoardHeld(TARGET, CREW_IDS), { wrapper: harness.Wrapper });
    harness.publish(CREW_HOLDER, 1);
    expect(result.current).toBe(true);

    act(() => harness.streams[0].onError?.({ extensions: { code: 'NOT_FOUND' } }));
    expect(result.current).toBe(false);
    expect(harness.streams[0].unsubscribe).toHaveBeenCalledOnce();
  });

  it('rereads a missed background release without waiting for a clean reconnect', async () => {
    const harness = makePresenceHarness(CREW_HOLDER);
    let resolveForegroundRead: (holder: BoardConnectionHolder | null) => void = () => {};
    harness.fetchConnection.mockResolvedValueOnce(CREW_HOLDER).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveForegroundRead = resolve;
        }),
    );
    const { result, rerender } = renderHook(() => useCrewGymBoardHeld(TARGET, CREW_IDS), { wrapper: harness.Wrapper });
    await act(async () => {});
    expect(result.current).toBe(true);

    lifecycle.backgrounded = true;
    rerender();
    expect(result.current).toBe(false);
    lifecycle.backgrounded = false;
    rerender();
    expect(result.current).toBe(false);
    expect(harness.fetchConnection).toHaveBeenCalledTimes(2);
    await act(async () => resolveForegroundRead(null));
    expect(result.current).toBe(false);
  });

  it('stays unconfirmed after socket close and a rejected retry read', async () => {
    vi.useFakeTimers();
    const harness = makePresenceHarness(CREW_HOLDER);
    let rejectRetryRead: (error: unknown) => void = () => {};
    harness.fetchConnection.mockResolvedValueOnce(CREW_HOLDER).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRetryRead = reject;
        }),
    );
    const { result } = renderHook(() => useCrewGymBoardHeld(TARGET, CREW_IDS), { wrapper: harness.Wrapper });
    await act(async () => {});
    expect(result.current).toBe(true);

    act(() => {
      for (const listener of lifecycle.connectionEndedListeners) listener();
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(false);
    await act(async () => rejectRetryRead(new Error('Retry read failed')));
    expect(result.current).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does not authorize a cached holder while the server is unreachable', async () => {
    const harness = makePresenceHarness(CREW_HOLDER);
    const { result, rerender } = renderHook(() => useCrewGymBoardHeld(TARGET, CREW_IDS), { wrapper: harness.Wrapper });
    await act(async () => {});
    expect(result.current).toBe(true);

    lifecycle.effectiveOffline = true;
    rerender();
    expect(result.current).toBe(false);
    expect(harness.streams[0].unsubscribe).toHaveBeenCalledOnce();
  });
});
