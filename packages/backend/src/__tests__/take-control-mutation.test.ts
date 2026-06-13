/**
 * Tests for the takeControl + releaseControl mutations introduced by Phase 2
 * of the queue-control-bar pivot (docs/queue-control-bar-pivot.md). These
 * mutations underpin the lightbulb gesture: any session participant may claim
 * the wall (yank-on-press), and the current driver may release it.
 *
 * Behaviors verified:
 *  1. takeControl({}) without a climb: sets driverParticipantId, publishes
 *     DriverChanged, returns the session shape with the new driver.
 *  2. takeControl({ climb }) with a climb: as above PLUS appends-and-sets
 *     the climb via setCurrentClimbAndPublish (mirroring the existing
 *     setCurrentClimb side effects).
 *  3. takeControl is a no-op for DriverChanged when the caller is already
 *     the driver (avoids redundant wire events on self-reclaim).
 *  4. releaseControl: clears driverParticipantId and publishes
 *     DriverChanged{null} only when the caller is the current driver
 *     (idempotent otherwise — no spurious null broadcasts).
 *  5. takeControl requires session membership (requireSessionMember).
 *
 * The room manager + pubsub + queue-navigation helper are mocked so the test
 * focuses on resolver logic. The disconnect-side driver cleanup (clears the
 * driver when the driver participant fully leaves) is exercised through the
 * room-manager class, not this resolver test.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext, ClimbQueueItem } from '@boardsesh/shared-schema';

vi.mock('../services/room-manager', () => ({
  roomManager: {
    getSessionDriverParticipantId: vi.fn(),
    setSessionDriverAndReturnPrevious: vi.fn(),
    clearSessionDriverIf: vi.fn(),
    getSessionUsers: vi.fn().mockResolvedValue([]),
    getSessionById: vi.fn().mockResolvedValue({
      name: 'Test Sesh',
      boardPath: '/kilter/1/2/3/40',
      goal: null,
      isPublic: true,
      startedAt: new Date('2026-05-16T12:00:00Z'),
      endedAt: null,
      isPermanent: false,
      color: null,
    }),
    getQueueState: vi.fn().mockResolvedValue({
      sequence: 0,
      stateHash: 'hash-0',
      queue: [],
      currentClimbQueueItem: null,
      version: 0,
    }),
    getSessionLeaderConnectionId: vi.fn().mockResolvedValue('some-other-connection'),
    // Board-serial plumbing (Phase 2 simplified pivot). The takeControl /
    // releaseControl resolvers now hydrate `lastConnectedBoardSerial` on the
    // session payload, so this needs to resolve to a value (null is fine —
    // the test doesn't assert on it).
    getSessionBoardSerial: vi.fn().mockResolvedValue(null),
    getWallConnections: vi.fn().mockResolvedValue(new Map()),
  },
}));

vi.mock('../pubsub/index', () => ({
  pubsub: {
    publishSessionEvent: vi.fn(),
    publishQueueEvent: vi.fn(),
  },
}));

vi.mock('../graphql/context', () => ({
  updateContext: vi.fn(),
  getContext: vi.fn(() => ({ sessionId: 'session-1' })),
}));

// Bypass the auth-check helper's distributed-state lookup; the existence of
// ctx.sessionId is enough for these tests since we control the context. By
// default `requireSessionMember` resolves; specific tests override it to
// reject to exercise the auth-bypass guard.
vi.mock('../graphql/resolvers/shared/helpers', async () => {
  const actual = await vi.importActual<typeof import('../graphql/resolvers/shared/helpers')>(
    '../graphql/resolvers/shared/helpers',
  );
  return {
    ...actual,
    requireSessionMember: vi.fn().mockResolvedValue(undefined),
    applyRateLimit: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../services/queue-navigation', () => ({
  setCurrentClimbAndPublish: vi.fn().mockResolvedValue({
    sequence: 1,
    stateHash: 'hash-1',
    queue: [],
    addedToQueue: true,
  }),
  navigateToQueueItem: vi.fn(),
}));

vi.mock('../services/apns', () => ({
  endLiveActivity: vi.fn().mockResolvedValue(undefined),
}));

// Import after the mocks are wired so the module under test picks them up.
const { sessionMutations } = await import('../graphql/resolvers/sessions/mutations');
const { roomManager } = await import('../services/room-manager');
const { pubsub } = await import('../pubsub/index');
const { setCurrentClimbAndPublish } = await import('../services/queue-navigation');
const sharedHelpers = await import('../graphql/resolvers/shared/helpers');

const roomManagerMock = roomManager as unknown as {
  getSessionDriverParticipantId: ReturnType<typeof vi.fn>;
  setSessionDriverAndReturnPrevious: ReturnType<typeof vi.fn>;
  clearSessionDriverIf: ReturnType<typeof vi.fn>;
  getSessionUsers: ReturnType<typeof vi.fn>;
  getQueueState: ReturnType<typeof vi.fn>;
  getSessionLeaderConnectionId: ReturnType<typeof vi.fn>;
};
const pubsubMock = pubsub as unknown as { publishSessionEvent: ReturnType<typeof vi.fn> };
const setCurrentClimbAndPublishMock = setCurrentClimbAndPublish as unknown as ReturnType<typeof vi.fn>;
const requireSessionMemberMock = sharedHelpers.requireSessionMember as unknown as ReturnType<typeof vi.fn>;

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    transport: 'ws',
    sessionId: 'session-1',
    participantId: 'participant-1',
    userId: undefined,
    isAuthenticated: false,
    ...overrides,
  };
}

const sampleClimb: ClimbQueueItem = {
  uuid: 'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789',
  climb: {
    uuid: '22222222-2222-2222-2222-222222222222',
    setter_username: 'tester',
    name: 'V5 Test Climb',
    frames: 'p1r1,p2r2',
    angle: 40,
    ascensionist_count: 10,
    // Schema treats numeric ladder fields as strings (matches Aurora payload shape).
    difficulty: '18',
    quality_average: '3.5',
    stars: 3,
    difficulty_error: '0.3',
    mirrored: false,
    benchmark_difficulty: null,
    is_no_match: null,
  },
  addedBy: 'participant-1',
  addedByUser: undefined,
  tickedBy: undefined,
  suggested: false,
};

describe('takeControl mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no prior driver (atomic swap returns null).
    roomManagerMock.setSessionDriverAndReturnPrevious.mockResolvedValue(null);
    // The `requireSessionMember` mock is recreated by `vi.clearAllMocks()`;
    // restore its default resolve so most tests run without the auth-bypass
    // path firing. Tests that exercise the rejection branch override this
    // explicitly via `mockRejectedValueOnce`.
    requireSessionMemberMock.mockResolvedValue(undefined);
  });

  it('sets the driver and publishes DriverChanged when there was no prior driver', async () => {
    const ctx = makeCtx();
    const result = await sessionMutations.takeControl(undefined, { climb: null }, ctx);

    expect(roomManagerMock.setSessionDriverAndReturnPrevious).toHaveBeenCalledWith('session-1', 'participant-1');
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith('session-1', {
      __typename: 'DriverChanged',
      driverParticipantId: 'participant-1',
      // No prior driver → server emits previous=null so subscribers can render
      // "X claimed the wall" toasts without local memoisation.
      previousDriverParticipantId: null,
    });
    // The resolver returns the Session payload with the new driver in place.
    // Pin the shape so a regression that drops fields (or returns `true`)
    // would surface here instead of slipping through silently.
    expect(result).toMatchObject({
      id: 'session-1',
      driverParticipantId: 'participant-1',
      participantId: 'participant-1',
      lastConnectedBoardSerial: null,
      queueState: expect.objectContaining({ sequence: 0, stateHash: 'hash-0' }),
    });
    // No climb means no queue-side publish.
    expect(setCurrentClimbAndPublishMock).not.toHaveBeenCalled();
  });

  it('yanks an existing driver and publishes DriverChanged with the new participant id', async () => {
    // The atomic swap returns the previous driver — the resolver compares
    // it to the caller to decide whether this is a transition.
    roomManagerMock.setSessionDriverAndReturnPrevious.mockResolvedValue('participant-other');
    const ctx = makeCtx({ participantId: 'participant-1' });

    await sessionMutations.takeControl(undefined, {}, ctx);

    expect(roomManagerMock.setSessionDriverAndReturnPrevious).toHaveBeenCalledWith('session-1', 'participant-1');
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith('session-1', {
      __typename: 'DriverChanged',
      driverParticipantId: 'participant-1',
      // Yanked from `participant-other` — the wire event carries the prior
      // driver so subscribers can render "X took the wall from Y" toasts.
      previousDriverParticipantId: 'participant-other',
    });
  });

  it('suppresses the DriverChanged broadcast when the caller is already the driver', async () => {
    roomManagerMock.setSessionDriverAndReturnPrevious.mockResolvedValue('participant-1');
    const ctx = makeCtx({ participantId: 'participant-1' });

    await sessionMutations.takeControl(undefined, {}, ctx);

    // The driver-state write still happens (idempotent self-set) — but the
    // wire event must NOT fire for a self-reclaim. Other party members
    // should not see a redundant DriverChanged that says "still you."
    expect(roomManagerMock.setSessionDriverAndReturnPrevious).toHaveBeenCalledWith('session-1', 'participant-1');
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('also broadcasts the climb via setCurrentClimbAndPublish when a climb is provided', async () => {
    const ctx = makeCtx();
    await sessionMutations.takeControl(undefined, { climb: sampleClimb }, ctx);

    expect(setCurrentClimbAndPublishMock).toHaveBeenCalledTimes(1);
    const [sessionId, item, shouldAdd] = setCurrentClimbAndPublishMock.mock.calls[0] as unknown as [
      string,
      ClimbQueueItem,
      boolean,
    ];
    expect(sessionId).toBe('session-1');
    expect(item.uuid).toBe(sampleClimb.uuid);
    expect(shouldAdd).toBe(true);
  });

  it('throws when ctx.participantId is missing (refuses to fall back to connectionId)', async () => {
    // ConnectionIds rotate on every reconnect — falling back would leak the
    // driver assignment because clearSessionDriverIf/releaseDriverIfMatches
    // wouldn't match after a reconnect. The resolver hard-errors instead
    // so the failure surfaces and auth gets a chance to publish a real
    // participantId.
    const ctx = makeCtx({ participantId: undefined });
    await expect(sessionMutations.takeControl(undefined, {}, ctx)).rejects.toThrow(/requires ctx\.participantId/);
    expect(roomManagerMock.setSessionDriverAndReturnPrevious).not.toHaveBeenCalled();
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('throws when called outside a session', async () => {
    const ctx = makeCtx({ sessionId: undefined });
    await expect(sessionMutations.takeControl(undefined, {}, ctx)).rejects.toThrow(/Must be in a session/);
    expect(roomManagerMock.setSessionDriverAndReturnPrevious).not.toHaveBeenCalled();
  });

  it('rejects when requireSessionMember throws (auth-bypass guard)', async () => {
    // The global mock resolves by default, which previously meant every test
    // ran with the session-membership check stubbed out — an auth-bypass
    // regression in the resolver would slip through unnoticed. Override the
    // mock to reject and assert the resolver propagates the throw without
    // mutating any state.
    requireSessionMemberMock.mockRejectedValueOnce(new Error('Not a member of session'));
    const ctx = makeCtx();

    await expect(sessionMutations.takeControl(undefined, {}, ctx)).rejects.toThrow(/Not a member of session/);
    expect(roomManagerMock.setSessionDriverAndReturnPrevious).not.toHaveBeenCalled();
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('two concurrent take-control calls produce a deterministic single winner', async () => {
    // Models two participants pressing the lightbulb at the exact same
    // moment. The atomic GETSET semantics in the room manager guarantee one
    // arrives first; the second sees the first's participantId as `previous`.
    // Each call only emits DriverChanged when it observed a transition, so
    // there are exactly two events on the wire: A taking from null, then B
    // taking from A.
    const swapCalls: { participantId: string; previous: string | null }[] = [];
    roomManagerMock.setSessionDriverAndReturnPrevious.mockImplementation(
      async (_sessionId: string, participantId: string) => {
        // Simulate the atomic swap: first call sees null, second sees the
        // first caller's participantId. Order is captured in `swapCalls`.
        const previous = swapCalls.length === 0 ? null : swapCalls[swapCalls.length - 1].participantId;
        swapCalls.push({ participantId, previous });
        return previous;
      },
    );

    const ctxA = makeCtx({ participantId: 'A', connectionId: 'conn-A' });
    const ctxB = makeCtx({ participantId: 'B', connectionId: 'conn-B' });

    await Promise.all([
      sessionMutations.takeControl(undefined, {}, ctxA),
      sessionMutations.takeControl(undefined, {}, ctxB),
    ]);

    // Two swaps, two events. Each event carries the previous driver returned
    // by the atomic swap so subscribers can build a "Y took it from X" toast.
    expect(roomManagerMock.setSessionDriverAndReturnPrevious).toHaveBeenCalledTimes(2);
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledTimes(2);
    const driverChangedEvents = pubsubMock.publishSessionEvent.mock.calls.map(
      ([, event]) =>
        event as { __typename: string; driverParticipantId: string; previousDriverParticipantId: string | null },
    );
    expect(driverChangedEvents).toEqual([
      {
        __typename: 'DriverChanged',
        driverParticipantId: swapCalls[0].participantId,
        previousDriverParticipantId: null,
      },
      {
        __typename: 'DriverChanged',
        driverParticipantId: swapCalls[1].participantId,
        previousDriverParticipantId: swapCalls[0].participantId,
      },
    ]);
  });
});

describe('releaseControl mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionMemberMock.mockResolvedValue(undefined);
  });

  it('clears the driver and publishes DriverChanged{null} when the caller is the driver', async () => {
    roomManagerMock.clearSessionDriverIf.mockResolvedValue(true);
    const ctx = makeCtx({ participantId: 'participant-1' });

    await sessionMutations.releaseControl(undefined, {}, ctx);

    expect(roomManagerMock.clearSessionDriverIf).toHaveBeenCalledWith('session-1', 'participant-1');
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith('session-1', {
      __typename: 'DriverChanged',
      driverParticipantId: null,
      // `cleared = true` means the caller was the driver, so they're the
      // previousDriverParticipantId carried on the event.
      previousDriverParticipantId: 'participant-1',
    });
  });

  it('is a no-op (no broadcast) when the caller is not the current driver', async () => {
    // clearSessionDriverIf returns false when the caller doesn't hold the
    // driver role — the conditional clear is the server-side guard against
    // a stale "release" from someone who never owned the wall.
    roomManagerMock.clearSessionDriverIf.mockResolvedValue(false);
    const ctx = makeCtx({ participantId: 'participant-2' });

    await sessionMutations.releaseControl(undefined, {}, ctx);

    expect(roomManagerMock.clearSessionDriverIf).toHaveBeenCalledWith('session-1', 'participant-2');
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('throws when called outside a session', async () => {
    const ctx = makeCtx({ sessionId: undefined });
    await expect(sessionMutations.releaseControl(undefined, {}, ctx)).rejects.toThrow(/Must be in a session/);
    expect(roomManagerMock.clearSessionDriverIf).not.toHaveBeenCalled();
  });
});
