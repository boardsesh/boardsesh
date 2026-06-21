/**
 * Tests for the `reportWallDisconnect` mutation — the session-scoped wall
 * disconnect signal in always-live sessions. The device that was relaying the
 * session's current climb to the wall over BLE lost its link, so peers clear
 * their "climb is lit" lightbulb state. The current climb is unchanged.
 *
 * Behaviours verified:
 *  1. Publishes `WallDisconnected { disconnectedByParticipantId }` to the
 *     session and returns the resolved Session payload.
 *  2. Requires a session (requireSession) and membership (requireSessionMember).
 *  3. Hard-errors when ctx.participantId is missing (refuses connectionId
 *     fallback), mirroring confirmClimbOnWall.
 *
 * The room manager + pubsub are mocked so the test focuses on resolver logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

vi.mock('../services/room-manager', () => ({
  roomManager: {
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
    getSessionBoardSerial: vi.fn().mockResolvedValue(null),
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

// Bypass the auth-check helper's distributed-state lookup; ctx.sessionId is
// enough for these tests since we control the context. By default
// `requireSessionMember` resolves; specific tests override it to reject.
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

vi.mock('../services/apns', () => ({
  endLiveActivity: vi.fn().mockResolvedValue(undefined),
}));

const { sessionMutations } = await import('../graphql/resolvers/sessions/mutations');
const { pubsub } = await import('../pubsub/index');
const sharedHelpers = await import('../graphql/resolvers/shared/helpers');

const pubsubMock = pubsub as unknown as { publishSessionEvent: ReturnType<typeof vi.fn> };
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

describe('reportWallDisconnect mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionMemberMock.mockResolvedValue(undefined);
  });

  it('publishes WallDisconnected with the caller participantId and returns the Session', async () => {
    const ctx = makeCtx({ participantId: 'participant-1' });

    const result = await sessionMutations.reportWallDisconnect(undefined, {}, ctx);

    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledTimes(1);
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith('session-1', {
      __typename: 'WallDisconnected',
      disconnectedByParticipantId: 'participant-1',
    });
    // The resolver returns the resolved Session payload. Pin the shape so a
    // regression that returns `true` or drops fields surfaces here.
    expect(result).toMatchObject({
      id: 'session-1',
      participantId: 'participant-1',
      lastConnectedBoardSerial: null,
      queueState: expect.objectContaining({ sequence: 0, stateHash: 'hash-0' }),
    });
  });

  it('throws when ctx.participantId is missing (refuses to fall back to connectionId)', async () => {
    const ctx = makeCtx({ participantId: undefined });
    await expect(sessionMutations.reportWallDisconnect(undefined, {}, ctx)).rejects.toThrow(
      /requires ctx\.participantId/,
    );
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('throws when called outside a session', async () => {
    const ctx = makeCtx({ sessionId: undefined });
    await expect(sessionMutations.reportWallDisconnect(undefined, {}, ctx)).rejects.toThrow(/Must be in a session/);
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('rejects when requireSessionMember throws (auth-bypass guard)', async () => {
    requireSessionMemberMock.mockRejectedValueOnce(new Error('Not a member of session'));
    const ctx = makeCtx();

    await expect(sessionMutations.reportWallDisconnect(undefined, {}, ctx)).rejects.toThrow(/Not a member of session/);
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });
});
