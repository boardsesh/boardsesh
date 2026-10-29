// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import {
  BoardPresenceActionsContext,
  BoardPresenceCurrentContext,
  BoardPresenceProvider,
  type BoardPresenceActions,
  type BoardPresenceClient,
  type BoardPresenceCurrentState,
} from '@boardsesh/board-presence-react';
import type { BoardConnectionHolder, BoardPresenceClimb, BoardPresenceStats } from '@boardsesh/shared-schema';

const ctrl = vi.hoisted(() => ({
  sessionId: 'session-1' as string | null,
  sessionMemberUserIds: new Set<string>(['me', 'liz']),
  viewerUserId: 'me' as string | null,
}));

vi.mock('../queue-provider', () => ({
  useQueueSessionControls: () => ({ sessionId: ctrl.sessionId, sessionMemberUserIds: ctrl.sessionMemberUserIds }),
}));
vi.mock('../../hooks/use-viewer-user-id', () => ({ useViewerUserId: () => ctrl.viewerUserId }));

import { CREW_HOLDER_CONFIRM_MS, CREW_HOLDER_RETRY_DELAYS_MS, useCrewHolderSuspicion } from '../crew-holder-suspicion';

type PresenceState = Pick<BoardPresenceCurrentState, 'currentClimb' | 'holder' | 'lastConnectionSeq'>;

function lizClimb(): BoardPresenceClimb {
  return {
    climbUuid: 'propagation',
    name: 'Propagation',
    sentByUserId: 'liz',
    sentAt: new Date().toISOString(),
    seq: 3,
  } as unknown as BoardPresenceClimb;
}

// The Pixel that joined Liz's session: the feed names the climb Liz lit a
// moment ago, and no holder event has named anyone yet.
function joinedState(): PresenceState {
  return { currentClimb: lizClimb(), holder: null, lastConnectionSeq: 0 };
}

function render(initial: PresenceState) {
  let presence = initial;
  const refresh = vi.fn();
  const actions = { refresh } as unknown as BoardPresenceActions;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      BoardPresenceActionsContext.Provider,
      { value: actions },
      createElement(
        BoardPresenceCurrentContext.Provider,
        { value: presence as unknown as BoardPresenceCurrentState },
        children,
      ),
    );
  const hook = renderHook(() => useCrewHolderSuspicion(), { wrapper });
  const setPresence = (next: PresenceState) => {
    presence = next;
    hook.rerender();
  };
  return { ...hook, refresh, setPresence };
}

beforeEach(() => {
  vi.useFakeTimers();
  ctrl.sessionId = 'session-1';
  ctrl.sessionMemberUserIds = new Set(['me', 'liz']);
  ctrl.viewerUserId = 'me';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useCrewHolderSuspicion (#7017 review)', () => {
  it('names the crewmate and asks for the holder once, however often it re-renders', () => {
    const { result, rerender, refresh } = render(joinedState());
    rerender();
    rerender();
    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toBe('liz');
    expect(refresh).toHaveBeenCalledTimes(1);
    // Its own reason, so gap telemetry still counts only dropped live events.
    expect(refresh).toHaveBeenCalledWith('crew-holder-unconfirmed');
  });

  it('clears once any holder event lands, an empty one included', () => {
    const { result, setPresence } = render(joinedState());
    act(() => vi.advanceTimersByTime(0));
    expect(result.current).toBe('liz');
    act(() =>
      setPresence({ ...joinedState(), holder: { userId: null } as BoardConnectionHolder, lastConnectionSeq: 4 }),
    );
    expect(result.current).toBeNull();
  });

  it('retries while unconfirmed, then lets the connect back after the window when every refresh failed', () => {
    // A refresh that fails changes nothing: the feed stays as it was.
    const { result, refresh } = render(joinedState());
    act(() => vi.advanceTimersByTime(CREW_HOLDER_RETRY_DELAYS_MS[CREW_HOLDER_RETRY_DELAYS_MS.length - 1]));
    expect(refresh).toHaveBeenCalledTimes(CREW_HOLDER_RETRY_DELAYS_MS.length);
    expect(result.current).toBe('liz');
    act(() => vi.advanceTimersByTime(CREW_HOLDER_CONFIRM_MS));
    expect(result.current).toBeNull();
    // Released for good: no more catch-ups for this crewmate in this session.
    act(() => vi.advanceTimersByTime(CREW_HOLDER_CONFIRM_MS * 3));
    expect(refresh).toHaveBeenCalledTimes(CREW_HOLDER_RETRY_DELAYS_MS.length);
    expect(result.current).toBeNull();
  });

  it('never suspects this climber’s own climb, as after a relaunch', () => {
    ctrl.viewerUserId = 'liz';
    const { result, refresh } = render(joinedState());
    act(() => vi.advanceTimersByTime(CREW_HOLDER_CONFIRM_MS));
    expect(result.current).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});

// Through the real presence hook and reducer: the catch-up it asks for lands
// a REFRESH_CONNECTION with upToSeq > 0, which settles the suspicion.
describe('useCrewHolderSuspicion with the real presence feed', () => {
  function makeClient(catchUpConnection: () => Promise<BoardConnectionHolder | null>) {
    let connectionCalls = 0;
    const fetchConnection = vi.fn(() => {
      connectionCalls += 1;
      // The seed at subscribe names nobody (the Pixel's first preview).
      return connectionCalls === 1 ? Promise.resolve(null) : catchUpConnection();
    });
    const client: BoardPresenceClient = {
      subscribeNowPlaying: vi.fn(() => () => {}),
      fetchRecentClimbs: vi.fn(() => Promise.resolve([lizClimb()])),
      fetchStats: vi.fn(() => Promise.resolve({} as BoardPresenceStats)),
      fetchConnection,
      reportClimb: vi.fn(() => Promise.resolve(true)),
      resolveBoardForSerial: vi.fn(),
    } as unknown as BoardPresenceClient;
    return { client, fetchConnection };
  }

  function renderWithFeed(client: BoardPresenceClient) {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(BoardPresenceProvider, { boardId: 42, client, children });
    return renderHook(() => useCrewHolderSuspicion(), { wrapper });
  }

  it('settles when the catch-up refreshes the holder, even to nobody', async () => {
    // What the server says when its holder slot is empty while a crewmate's
    // phone holds the link (no Redis, a swallowed slot write): nobody. The
    // suspicion ends and the connect comes back, as before #7017.
    const { client, fetchConnection } = makeClient(() => Promise.resolve(null));
    const { result } = renderWithFeed(client);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Seeded, suspected, then the catch-up's REFRESH_CONNECTION (upToSeq 3) lands.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchConnection).toHaveBeenCalledTimes(2);
    expect(result.current).toBeNull();
  });

  it('stays suspected while every catch-up fails, then releases after the window', async () => {
    const { client } = makeClient(() => Promise.reject(new Error('offline')));
    const { result } = renderWithFeed(client);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe('liz');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREW_HOLDER_CONFIRM_MS);
    });
    expect(result.current).toBeNull();
  });
});
