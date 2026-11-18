// @vitest-environment jsdom
//
// Coverage for the boardPath a newly-created session carries (#4585).
//
// A gym-linked board is a shared wall, so the session must name it
// (`/b/{slug}/{angle}`). Handed the positional tuple instead, a joiner goes down
// resolveBoardForSession's tuple branch and mints their own private board row —
// a different presence `boardId` — so on a wall with no LEDs the second
// climber's turn never reaches the first climber's feed or the gym kiosk.
//
// The hook is driven directly rather than through QueueProvider: every one of
// its collaborators is an injected param or a module import, so a thin mock
// surface pins the behaviour without the provider harness.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AppWorkoutInitialSeed } from '../queue-contexts';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { UserBoard } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  storedActiveBoard: null as UserBoard | null,
  boardRead: null as (() => Promise<UserBoard | null>) | null,
  activeBoardGeneration: 0,
  credentialGeneration: 0,
  clearStoredQueueSnapshot: vi.fn(() => Promise.resolve()),
  clearStoredSessionId: vi.fn(() => Promise.resolve()),
  clearStoredCreatedSessionId: vi.fn(() => Promise.resolve()),
  execute: vi.fn(() => Promise.resolve({})),
  request: vi.fn(),
  rememberPartnerWorkout: vi.fn(async (_sessionId: string, _workoutId: string) => undefined),
  setStoredSessionId: vi.fn((_sessionId: string) => Promise.resolve()),
  setStoredSessionVisibility: vi.fn((_sessionId: string, _isPublic: boolean) => Promise.resolve()),
}));

vi.mock('../../../lib/pending-workout-store', () => ({
  rememberPartnerWorkout: mocks.rememberPartnerWorkout,
  clearActivePartnerWorkout: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/active-board-store', () => ({
  getStoredActiveBoard: () => (mocks.boardRead ? mocks.boardRead() : Promise.resolve(mocks.storedActiveBoard)),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({
  getActiveBoardWriteGeneration: () => mocks.activeBoardGeneration,
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../../lib/graphql/ws-client', () => ({ getWsClient: () => ({}) }));
vi.mock('../../../lib/graphql/operations', () => ({
  CREATE_SESSION: 'CreateSession',
  CREATE_PARTNER_WORKOUT_SESSION: 'CreatePartnerWorkoutSession',
  END_SESSION: 'EndSession',
}));
vi.mock('../../../lib/privacy/privacy-cache', () => ({
  getCredentialGeneration: () => mocks.credentialGeneration,
  subscribeToCredentialChanges: () => () => undefined,
}));
vi.mock('../../../lib/graphql/extract-error-message', () => ({
  extractGraphqlMessage: () => null,
  isGraphqlRateLimitedError: () => false,
}));
vi.mock('../../../lib/session-store', () => ({
  clearStoredCreatedSessionId: mocks.clearStoredCreatedSessionId,
  clearStoredSessionId: mocks.clearStoredSessionId,
  setStoredCreatedSessionId: () => Promise.resolve(),
  setStoredSessionId: mocks.setStoredSessionId,
  setStoredSessionVisibility: mocks.setStoredSessionVisibility,
}));
vi.mock('../../../lib/queue-snapshot-store', () => ({ clearStoredQueueSnapshot: mocks.clearStoredQueueSnapshot }));
vi.mock('../../../lib/device-timezone', () => ({ getDeviceTimezone: () => 'UTC' }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('@boardsesh/graphql-client', () => ({ execute: mocks.execute }));
vi.mock('@boardsesh/graphql/operations/queue-session', () => ({ LEAVE_SESSION: 'LeaveSession' }));

import { useSessionCommands } from '../use-session-commands';
import { resolveBoardForSession } from '../../../lib/board-path-to-user-board';

type SessionCommandsParams = Parameters<typeof useSessionCommands>[0];

/** A gym wall: `gymId` is the only field that reliably marks one as shared. */
function gymLinkedBoard(): UserBoard {
  return {
    uuid: 'gym-board-uuid',
    slug: 'boiler-room-kilter-c937dad5',
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '27,28',
    angle: 40,
    gymId: 12,
    // Public on its own says nothing: the private rows joiners mint are public too.
    isPublic: true,
  } as unknown as UserBoard;
}

function homeBoard(): UserBoard {
  return {
    uuid: 'home-board-uuid',
    slug: 'marcos-kilter-1f2e3d4c',
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '27,28',
    angle: 40,
    gymId: null,
    isPublic: true,
  } as unknown as UserBoard;
}

function renderSessionCommands() {
  const params = {
    showToast: vi.fn(),
    t: (key: string) => key,
    stateRef: { current: { queue: [], currentClimbQueueItem: null } },
    ensureJoined: vi.fn(() => Promise.resolve()),
    setQueueMutation: vi.fn(() => Promise.resolve()),
    seedFailedSessionIdRef: { current: null },
    setSessionId: vi.fn(),
    sessionIdRef: { current: null },
    onSessionContextChanging: vi.fn(),
    dispatch: vi.fn(),
    setPlaylistSuggestionSourceState: vi.fn(),
    setActiveBoard: vi.fn(() => Promise.resolve(true)),
    locallyEndingSessionIdRef: { current: null },
    suppressedRemoteEndSessionIdRef: { current: null },
  };
  return { ...renderHook(() => useSessionCommands(params as unknown as SessionCommandsParams)), params };
}

/** The boardPath the last CreateSession mutation was sent with. */
function lastCreatedBoardPath(): string | undefined {
  const variables = mocks.request.mock.calls.at(-1)?.[1] as { input?: { boardPath?: string } } | undefined;
  return variables?.input?.boardPath;
}

describe('useSessionCommands — createSessionWithConfig boardPath', () => {
  beforeEach(() => {
    mocks.storedActiveBoard = null;
    mocks.request.mockReset().mockResolvedValue({ createSession: { id: 'session-1' } });
    mocks.setStoredSessionId.mockClear();
    mocks.clearStoredQueueSnapshot.mockClear();
  });

  it('names a gym-linked board so every joiner lands on the same board row', async () => {
    mocks.storedActiveBoard = gymLinkedBoard();
    const { result } = renderSessionCommands();

    await act(async () => {
      await result.current.createSessionWithConfig();
    });

    expect(lastCreatedBoardPath()).toBe('/b/boiler-room-kilter-c937dad5/40');
  });

  it('keeps the positional tuple for a board that belongs to no gym', async () => {
    mocks.storedActiveBoard = homeBoard();
    const { result } = renderSessionCommands();

    await act(async () => {
      await result.current.createSessionWithConfig();
    });

    expect(lastCreatedBoardPath()).toBe('kilter/8/17/27,28/40');
  });

  it('keeps a personal ledless wall and its capability when another climber joins', async () => {
    const hostBoard = { ...homeBoard(), hasLeds: false };
    mocks.storedActiveBoard = hostBoard;
    const host = renderSessionCommands();
    let createdSessionId: string | null = null;
    await act(async () => {
      createdSessionId = await host.result.current.createSessionWithConfig();
    });
    const boardPath = lastCreatedBoardPath();
    expect(boardPath).toBe('/b/marcos-kilter-1f2e3d4c/40');
    if (!boardPath || !createdSessionId) throw new Error('Session was not created');
    const sessionToJoin = createdSessionId;

    const createBoard = vi.fn();
    const fetchBoardBySlug = vi.fn(async () => hostBoard);
    const joinedBoard = await resolveBoardForSession(boardPath, {
      // A matching owned LED board must not replace the host's physical wall.
      loadOwnedBoards: async () => ({
        viewerId: 'joiner',
        boards: [{ ...homeBoard(), uuid: 'joiners-own-board', hasLeds: true }],
      }),
      createBoard,
      fetchBoardBySlug,
    });
    const joiner = renderSessionCommands();
    await act(async () => {
      await joiner.result.current.joinSession(sessionToJoin, { boardPath, userBoard: joinedBoard });
    });

    expect(fetchBoardBySlug).toHaveBeenCalledWith(hostBoard.slug);
    expect(createBoard).not.toHaveBeenCalled();
    expect(joiner.params.setActiveBoard).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: hostBoard.uuid, hasLeds: false }),
      expect.any(Function),
    );
    expect(joiner.params.setSessionId).toHaveBeenCalledWith(sessionToJoin);
    expect(joiner.params.onSessionContextChanging).toHaveBeenCalledTimes(1);
    expect(joiner.params.setActiveBoard.mock.invocationCallOrder[0]).toBeLessThan(
      joiner.params.onSessionContextChanging.mock.invocationCallOrder[0],
    );
    expect(joiner.params.onSessionContextChanging.mock.invocationCallOrder[0]).toBeLessThan(
      joiner.params.setSessionId.mock.invocationCallOrder[0],
    );
  });

  it('does not claim the session after the auth generation expires during active-board persistence', async () => {
    let resolveActiveBoardWrite: (accepted: boolean) => void = () => {};
    const activeBoardWrite = new Promise<boolean>((resolve) => {
      resolveActiveBoardWrite = resolve;
    });
    const { result, params } = renderSessionCommands();
    vi.mocked(params.setActiveBoard).mockReturnValueOnce(activeBoardWrite);
    let operationCurrent = true;

    let joinResult = true;
    const pendingJoin = result.current.joinSession('session-next', {
      boardPath: 'kilter/8/17/27,28/40',
      userBoard: homeBoard(),
      isOperationCurrent: () => operationCurrent,
    });
    expect(params.setActiveBoard).toHaveBeenCalledWith(homeBoard(), expect.any(Function));

    operationCurrent = false;
    resolveActiveBoardWrite(true);
    await act(async () => {
      joinResult = await pendingJoin;
    });

    expect(joinResult).toBe(false);
    expect(params.sessionIdRef.current).toBeNull();
    expect(params.setSessionId).not.toHaveBeenCalled();
    expect(params.onSessionContextChanging).not.toHaveBeenCalled();
    expect(mocks.setStoredSessionId).not.toHaveBeenCalled();
    expect(mocks.clearStoredQueueSnapshot).not.toHaveBeenCalled();
  });

  it('does not publish a session when the active-board write is superseded', async () => {
    const { result, params } = renderSessionCommands();
    vi.mocked(params.setActiveBoard).mockResolvedValueOnce(false);

    let joinResult = true;
    await act(async () => {
      joinResult = await result.current.joinSession('session-next', {
        boardPath: 'kilter/8/17/27,28/40',
        userBoard: homeBoard(),
        isOperationCurrent: () => true,
      });
    });

    expect(joinResult).toBe(false);
    expect(params.sessionIdRef.current).toBeNull();
    expect(params.onSessionContextChanging).not.toHaveBeenCalled();
    expect(params.setSessionId).not.toHaveBeenCalled();
    expect(mocks.setStoredSessionId).not.toHaveBeenCalled();
    expect(mocks.clearStoredQueueSnapshot).not.toHaveBeenCalled();
  });
});

describe('useSessionCommands — createSessionWithConfig visibility', () => {
  beforeEach(() => {
    mocks.storedActiveBoard = homeBoard();
    mocks.request.mockReset().mockResolvedValue({ createSession: { id: 'session-1' } });
    mocks.setStoredSessionVisibility.mockClear();
  });

  function lastCreateInput(): Record<string, unknown> | undefined {
    const variables = mocks.request.mock.calls.at(-1)?.[1] as { input?: Record<string, unknown> } | undefined;
    return variables?.input;
  }

  it('sends isPublic: false when the climber turned "Show this session live" off', async () => {
    const { result } = renderSessionCommands();

    await act(async () => {
      await result.current.createSessionWithConfig({ isPublic: false });
    });

    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(lastCreateInput()).toMatchObject({ isPublic: false });
    // Remembered on the device so the in-session switch can show it while the
    // server's session query is still empty.
    expect(mocks.setStoredSessionVisibility).toHaveBeenCalledWith('session-1', false);
  });

  it('leaves isPublic out for a live session, since absent means public server-side', async () => {
    const { result } = renderSessionCommands();

    await act(async () => {
      await result.current.createSessionWithConfig({ isPublic: true });
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(lastCreateInput()).not.toHaveProperty('isPublic');
    expect(mocks.setStoredSessionVisibility).toHaveBeenLastCalledWith('session-1', true);

    const unconfigured = renderSessionCommands();
    await act(async () => {
      await unconfigured.result.current.createSessionWithConfig();
    });
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(lastCreateInput()).not.toHaveProperty('isPublic');
    expect(mocks.setStoredSessionVisibility).toHaveBeenLastCalledWith('session-1', true);
  });
});

describe('clearSession after active board removal', () => {
  beforeEach(() => {
    mocks.clearStoredQueueSnapshot.mockReset().mockResolvedValue(undefined);
    mocks.clearStoredSessionId.mockClear();
    mocks.clearStoredCreatedSessionId.mockClear();
    mocks.execute.mockReset().mockResolvedValue({});
    mocks.activeBoardGeneration = 0;
  });

  it('clears the solo queue and persisted climb, cancelling pending appends', async () => {
    const { result, params } = renderSessionCommands();
    await act(async () => {
      await result.current.clearSession({ notifyServer: true });
    });

    expect(params.onSessionContextChanging).toHaveBeenCalledTimes(1);
    expect(params.dispatch).toHaveBeenCalledWith({
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue: [], currentClimbQueueItem: null },
    });
    expect(params.setPlaylistSuggestionSourceState).toHaveBeenCalledWith(null);
    expect(mocks.clearStoredQueueSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('does not clear a newer session while the old leave request is pending', async () => {
    const { result, params } = renderSessionCommands();
    const sessionRef = params.sessionIdRef as { current: string | null };
    sessionRef.current = 'old-room';
    let finishLeave: (() => void) | undefined;
    mocks.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLeave = () => resolve({});
        }),
    );
    let leaving: Promise<void> | undefined;
    act(() => {
      leaving = result.current.clearSession({ notifyServer: true });
    });
    expect(params.onSessionContextChanging).toHaveBeenCalledTimes(1);
    expect(params.dispatch).not.toHaveBeenCalled();
    sessionRef.current = 'new-room';
    await act(async () => {
      finishLeave?.();
      await leaving;
    });
    expect(sessionRef.current).toBe('new-room');
    expect(params.dispatch).not.toHaveBeenCalled();
    expect(mocks.clearStoredQueueSnapshot).not.toHaveBeenCalled();
  });

  it('preserves the new persisted session while snapshot removal is pending', async () => {
    const { result, params } = renderSessionCommands();
    let finishRemoval: (() => void) | undefined;
    mocks.clearStoredQueueSnapshot.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRemoval = resolve;
        }),
    );
    let clearing: Promise<void> | undefined;
    act(() => {
      clearing = result.current.clearSession();
    });
    (params.sessionIdRef as { current: string | null }).current = 'new-room';
    await act(async () => {
      finishRemoval?.();
      await clearing;
    });
    expect(mocks.clearStoredSessionId).not.toHaveBeenCalled();
    expect(mocks.clearStoredCreatedSessionId).not.toHaveBeenCalled();
  });

  it('leaves a shared room instead of ending it for other climbers', async () => {
    const { result, params } = renderSessionCommands();
    (params.sessionIdRef as { current: string | null }).current = 'crew-session';
    mocks.request.mockClear();
    await act(async () => {
      await result.current.clearSession({ notifyServer: true });
    });

    expect(mocks.execute).toHaveBeenCalledWith(expect.any(Function), { query: 'LeaveSession' }, 5000);
    expect(params.sessionIdRef.current).toBeNull();
    expect(params.setSessionId).toHaveBeenCalledWith(null);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.clearStoredQueueSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('partner initial seed recovery', () => {
  const seed: AppWorkoutInitialSeed = {
    queue: [{ uuid: 'candidate', climb: { uuid: 'candidate-climb', angle: 40 } } as ClimbQueueItem],
    currentClimbQueueItem: null,
    historyCount: 0,
    plan: [{ index: 0, climbUuids: ['candidate-climb'] }],
    sessionPlan: {
      version: 1,
      stages: [
        {
          id: 'wk:0',
          kind: 'volume',
          items: [{ queueItemUuid: 'candidate', climbUuid: 'candidate-climb', angle: 40 }],
        },
      ],
    },
  };
  beforeEach(() => {
    mocks.storedActiveBoard = homeBoard();
    mocks.activeBoardGeneration = 0;
    mocks.credentialGeneration = 0;
    mocks.request.mockReset();
    mocks.rememberPartnerWorkout.mockClear();
    mocks.setStoredSessionId.mockClear();
    mocks.clearStoredQueueSnapshot.mockClear();
  });

  it('after a lost response, hydrates only the original server winner without seeding again', async () => {
    mocks.request.mockRejectedValueOnce(new Error('lost create reply')).mockResolvedValueOnce({
      createSession: {
        id: 'original-session',
        isPublic: false,
        queueState: {
          sequence: 1,
          historyCount: 2,
          queue: [{ uuid: 'original-preview', climb: { uuid: 'original-climb', angle: 40 } }],
          currentClimbQueueItem: null,
        },
      },
    });
    const { result, params } = renderSessionCommands();
    await act(async () => {
      expect(await result.current.createSessionWithConfig({ appWorkoutId: 'wk', appWorkoutSeed: seed })).toBeNull();
    });
    expect(params.dispatch).not.toHaveBeenCalled();
    await act(async () => {
      expect(await result.current.createSessionWithConfig({ appWorkoutId: 'wk', appWorkoutSeed: seed })).toBe(
        'original-session',
      );
    });
    expect(mocks.request).toHaveBeenLastCalledWith(
      'CreatePartnerWorkoutSession',
      expect.objectContaining({ input: expect.objectContaining({ appWorkoutSeed: seed }) }),
    );
    expect(params.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: 'INITIAL_QUEUE_DATA',
        serverSequence: 1,
        payload: expect.objectContaining({
          historyCount: 2,
          queue: [expect.objectContaining({ uuid: 'original-preview' })],
        }),
      }),
    );
    expect(params.ensureJoined).not.toHaveBeenCalled();
    expect(params.setQueueMutation).not.toHaveBeenCalled();
    expect(mocks.setStoredSessionVisibility).toHaveBeenLastCalledWith('original-session', false);
    expect(mocks.clearStoredQueueSnapshot).toHaveBeenCalledOnce();
  });

  it('does not hydrate a create reply after the account changes', async () => {
    let resolveResponse: (response: unknown) => void = () => {};
    mocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const { result, params } = renderSessionCommands();
    let start: Promise<string | null>;
    await act(async () => {
      start = result.current.createSessionWithConfig({ appWorkoutId: 'wk', appWorkoutSeed: seed });
      await Promise.resolve();
    });
    mocks.credentialGeneration += 1;
    await act(async () => {
      resolveResponse({ createSession: { id: 'old-account-session' } });
      expect(await start!).toBeNull();
    });
    expect(params.dispatch).not.toHaveBeenCalled();
    expect(mocks.setStoredSessionId).not.toHaveBeenCalled();
    expect(mocks.rememberPartnerWorkout).not.toHaveBeenCalled();
    expect(params.setSessionId).not.toHaveBeenCalled();
  });
  it('can retry when storing the committed session id initially fails', async () => {
    mocks.request.mockResolvedValue({
      createSession: {
        id: 'original-session',
        isPublic: false,
        queueState: { sequence: 1, queue: [], currentClimbQueueItem: null },
      },
    });
    mocks.setStoredSessionId.mockRejectedValueOnce(new Error('storage unavailable'));
    const { result, params } = renderSessionCommands();
    await act(async () => {
      expect(await result.current.createSessionWithConfig({ appWorkoutId: 'wk', appWorkoutSeed: seed })).toBeNull();
    });
    expect(params.sessionIdRef.current).toBeNull();
    expect(mocks.rememberPartnerWorkout).toHaveBeenCalledWith('original-session', 'wk');
    await act(async () => {
      expect(await result.current.createSessionWithConfig({ appWorkoutId: 'wk', appWorkoutSeed: seed })).toBe(
        'original-session',
      );
    });
    expect(params.setSessionId).toHaveBeenCalledExactlyOnceWith('original-session');
  });

  it('completes the committed Start even if deleting its old solo snapshot fails', async () => {
    mocks.request.mockResolvedValue({
      createSession: {
        id: 'original-session',
        isPublic: true,
        queueState: { sequence: 1, queue: [], currentClimbQueueItem: null },
      },
    });
    mocks.clearStoredQueueSnapshot.mockRejectedValueOnce(new Error('cleanup unavailable'));
    const { result, params } = renderSessionCommands();
    await act(async () => {
      expect(await result.current.createSessionWithConfig({ appWorkoutId: 'wk', appWorkoutSeed: seed })).toBe(
        'original-session',
      );
    });
    expect(params.sessionIdRef.current).toBe('original-session');
    expect(params.setSessionId).toHaveBeenCalledWith('original-session');
    expect(params.dispatch).toHaveBeenCalledOnce();
  });

  it('preserves another joined session that wins while the create request is pending', async () => {
    let resolveResponse: (response: unknown) => void = () => {};
    mocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const { result, params } = renderSessionCommands();
    let start: Promise<string | null>;
    await act(async () => {
      start = result.current.createSessionWithConfig({ appWorkoutId: 'wk', appWorkoutSeed: seed });
      await Promise.resolve();
    });
    (params.sessionIdRef as { current: string | null }).current = 'joined-session';
    await act(async () => {
      resolveResponse({
        createSession: {
          id: 'original-session',
          isPublic: true,
          queueState: { sequence: 1, queue: [], currentClimbQueueItem: null },
        },
      });
      expect(await start!).toBeNull();
    });
    expect(mocks.rememberPartnerWorkout).toHaveBeenCalledWith('original-session', 'wk');
    expect(params.sessionIdRef.current).toBe('joined-session');
    expect(params.dispatch).not.toHaveBeenCalled();
    expect(mocks.setStoredSessionId).not.toHaveBeenCalled();
  });

  it.each(['board', 'account'])(
    'clears the create flight after a %s change during the first board read',
    async (scope) => {
      let finishRead: (board: UserBoard | null) => void = () => {};
      mocks.boardRead = () =>
        new Promise((resolve) => {
          finishRead = resolve;
        });
      const { result, params } = renderSessionCommands();
      let start: Promise<string | null>;
      await act(async () => {
        start = result.current.createSessionWithConfig({ appWorkoutId: 'wk', appWorkoutSeed: seed });
        await Promise.resolve();
      });
      if (scope === 'board') mocks.activeBoardGeneration += 1;
      else mocks.credentialGeneration += 1;
      await act(async () => {
        finishRead(homeBoard());
        expect(await start!).toBeNull();
      });
      expect(mocks.request).not.toHaveBeenCalled();
      mocks.boardRead = null;
      mocks.request.mockResolvedValue({
        createSession: {
          id: 'retry-session',
          isPublic: true,
          queueState: { sequence: 1, queue: [], currentClimbQueueItem: null },
        },
      });
      await act(async () => {
        expect(await result.current.createSessionWithConfig({ appWorkoutId: 'wk', appWorkoutSeed: seed })).toBe(
          'retry-session',
        );
      });
      expect(params.setSessionId).toHaveBeenCalledWith('retry-session');
    },
  );
});
