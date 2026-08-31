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
import type { UserBoard } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  storedActiveBoard: null as UserBoard | null,
  request: vi.fn(),
}));

vi.mock('../../../lib/active-board-store', () => ({
  getStoredActiveBoard: () => Promise.resolve(mocks.storedActiveBoard),
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: mocks.request }) }));
vi.mock('../../../lib/graphql/ws-client', () => ({ getWsClient: () => ({}) }));
vi.mock('../../../lib/graphql/operations', () => ({ CREATE_SESSION: 'CreateSession', END_SESSION: 'EndSession' }));
vi.mock('../../../lib/graphql/extract-error-message', () => ({
  extractGraphqlMessage: () => null,
  isGraphqlRateLimitedError: () => false,
}));
vi.mock('../../../lib/session-store', () => ({
  clearStoredCreatedSessionId: () => Promise.resolve(),
  clearStoredSessionId: () => Promise.resolve(),
  setStoredCreatedSessionId: () => Promise.resolve(),
  setStoredSessionId: () => Promise.resolve(),
}));
vi.mock('../../../lib/queue-snapshot-store', () => ({ clearStoredQueueSnapshot: () => Promise.resolve() }));
vi.mock('../../../lib/device-timezone', () => ({ getDeviceTimezone: () => 'UTC' }));
vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('@boardsesh/graphql-client', () => ({ execute: () => Promise.resolve({}) }));
vi.mock('@boardsesh/graphql/operations/queue-session', () => ({ LEAVE_SESSION: 'LeaveSession' }));

import { useSessionCommands } from '../use-session-commands';

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
    dispatch: vi.fn(),
    setPlaylistSuggestionSourceState: vi.fn(),
    resyncInFlightRef: { current: false },
    resyncPendingRef: { current: false },
    setActiveBoard: vi.fn(() => Promise.resolve()),
    locallyEndingSessionIdRef: { current: null },
    suppressedRemoteEndSessionIdRef: { current: null },
  };
  return renderHook(() => useSessionCommands(params as unknown as SessionCommandsParams));
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
});
