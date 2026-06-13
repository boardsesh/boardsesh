/**
 * Tests for the `confirmClimbOnWall` and `setSessionBoardSerial` mutations
 * introduced by the simplified queue-control-bar pivot
 * (docs/queue-control-bar-pivot.md). Both follow the same pattern as the
 * Phase 2 PR1 take/release-control mutations.
 *
 * Behaviors verified:
 *
 *  confirmClimbOnWall
 *  - Server stamps `confirmedAt` (clients cannot forge it) and derives
 *    `confirmedByParticipantId` from the caller's identity.
 *  - Publishes a `WallConfirmedClimb` event with the climb UUID + caller's
 *    participant ID to all session members.
 *  - Any session participant may call (no driver requirement); non-members
 *    are rejected by the membership check.
 *  - Hard-errors when ctx.participantId is missing (refuses to fall back to
 *    connectionId, which rotates across reconnects and would silently leak
 *    the confirmer identity).
 *
 *  setSessionBoardSerial
 *  - Persists the serial via the room manager and publishes
 *    `SessionBoardSerialChanged` when the value changes.
 *  - Idempotent: when the stored serial already equals the incoming value,
 *    no event fires (avoids redundant subscriber work on reconnect storms).
 *  - Rejects non-members via the shared membership check.
 *
 * The room manager + pubsub are mocked so the test focuses on resolver logic
 * (validation, identity stamping, idempotence, broadcast wiring). The Redis-
 * backed persistence path is exercised separately through room-manager unit
 * tests; this file pins the resolver contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

// confirmClimbOnWall now correlates the confirm's climbUuid against the
// per-session recent-climbs ring buffer (last N authoritative wall climbs),
// not the single current climb. Tests on the happy path arrange for
// `isRecentClimb` to return true; mismatch tests return false.
const validClimbUuid = '22222222-2222-2222-2222-222222222222';
const validSerial = 'KB-AB12-CD34';

vi.mock('../services/room-manager', () => ({
  roomManager: {
    setSessionBoardSerialAndReturnPrevious: vi.fn(),
    // The setSessionBoardSerial resolver reads `lastConnectedBoardSerial`
    // back from the room manager rather than echoing the input, so the
    // happy-path mock returns the value the test under exercise just wrote.
    // Individual tests override per-call when they want a different
    // authoritative answer.
    getSessionBoardSerial: vi.fn().mockResolvedValue(null),
    getWallConnections: vi.fn().mockResolvedValue(new Map()),
    // Used by the setSessionBoardPath mutation. Returns the previous
    // boardPath when the value changed; null on no-op writes.
    updateSessionBoardPathIfChanged: vi.fn(),
    // Recent-climbs ring buffer used by confirmClimbOnWall.
    pushRecentClimb: vi.fn().mockResolvedValue(undefined),
    isRecentClimb: vi.fn().mockResolvedValue(true),
    // Mutations now return Session! (matching takeControl / releaseControl)
    // and call these helpers to build the response payload.
    getSessionUsers: vi.fn().mockResolvedValue([]),
    getSessionById: vi.fn().mockResolvedValue({
      name: 'Test Session',
      boardPath: 'kilter/1/1/1/40',
      goal: null,
      isPublic: true,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: null,
      isPermanent: false,
      color: null,
    }),
    getQueueState: vi.fn().mockResolvedValue({
      sequence: 0,
      stateHash: 'hash',
      queue: [],
      currentClimbQueueItem: null,
    }),
    getSessionDriverParticipantId: vi.fn().mockResolvedValue(null),
    getSessionLeaderConnectionId: vi.fn().mockResolvedValue(null),
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

// Import after mocks are wired so the module under test picks them up.
const { sessionMutations } = await import('../graphql/resolvers/sessions/mutations');
const { roomManager } = await import('../services/room-manager');
const { pubsub } = await import('../pubsub/index');
const sharedHelpers = await import('../graphql/resolvers/shared/helpers');

const roomManagerMock = roomManager as unknown as {
  setSessionBoardSerialAndReturnPrevious: ReturnType<typeof vi.fn>;
  getSessionBoardSerial: ReturnType<typeof vi.fn>;
  getQueueState: ReturnType<typeof vi.fn>;
  pushRecentClimb: ReturnType<typeof vi.fn>;
  isRecentClimb: ReturnType<typeof vi.fn>;
  updateSessionBoardPathIfChanged: ReturnType<typeof vi.fn>;
  getSessionById: ReturnType<typeof vi.fn>;
};
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

// Primes `isRecentClimb` to accept the confirm path's climbUuid. The vi.mock
// setup pre-fills this with `true`, but `vi.clearAllMocks` in `beforeEach`
// blows away the resolved value so each happy-path test re-primes it.
function primeRecentClimb(): void {
  roomManagerMock.isRecentClimb.mockResolvedValue(true);
}

describe('confirmClimbOnWall mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionMemberMock.mockResolvedValue(undefined);
    // Default to the happy path: the climbUuid is in the session's recent-
    // climbs ring buffer so the correlation check passes. Tests exercising
    // the mismatch branch override `isRecentClimb` explicitly.
    primeRecentClimb();
  });

  it('publishes WallConfirmedClimb with the caller as confirmedByParticipantId and a server-stamped timestamp, returning a Session', async () => {
    const ctx = makeCtx({ participantId: 'participant-1' });
    const before = Date.now();

    const result = await sessionMutations.confirmClimbOnWall(undefined, { climbUuid: validClimbUuid }, ctx);

    // Resolver now returns Session! (mirrors takeControl / releaseControl).
    expect(result).toMatchObject({
      id: 'session-1',
      participantId: 'participant-1',
    });
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledTimes(1);
    const [publishedSessionId, publishedEvent] = pubsubMock.publishSessionEvent.mock.calls[0] as unknown as [
      string,
      {
        __typename: 'WallConfirmedClimb';
        climbUuid: string;
        confirmedAt: string;
        confirmedByParticipantId: string;
        queueItemUuid: string | null;
      },
    ];
    expect(publishedSessionId).toBe('session-1');
    expect(publishedEvent.__typename).toBe('WallConfirmedClimb');
    expect(publishedEvent.climbUuid).toBe(validClimbUuid);
    expect(publishedEvent.confirmedByParticipantId).toBe('participant-1');
    expect(publishedEvent.queueItemUuid).toBeNull();
    // Server-stamped: confirmedAt is a valid ISO string within a sane window.
    const stampedMs = Date.parse(publishedEvent.confirmedAt);
    expect(Number.isNaN(stampedMs)).toBe(false);
    expect(stampedMs).toBeGreaterThanOrEqual(before);
    expect(stampedMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('throws when ctx.participantId is missing (refuses to fall back to connectionId)', async () => {
    // ConnectionIds rotate on every reconnect — the resolver hard-errors
    // rather than recording a confirmer identity that won't survive a
    // reconnect. Auth is expected to publish a real participantId.
    const ctx = makeCtx({ participantId: undefined, connectionId: 'conn-anon-1' });

    await expect(sessionMutations.confirmClimbOnWall(undefined, { climbUuid: validClimbUuid }, ctx)).rejects.toThrow(
      /requires ctx\.participantId/,
    );
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('rejects non-members (requireSessionMember throws) and does not publish', async () => {
    requireSessionMemberMock.mockRejectedValueOnce(new Error('Not a member of session'));
    const ctx = makeCtx();

    await expect(sessionMutations.confirmClimbOnWall(undefined, { climbUuid: validClimbUuid }, ctx)).rejects.toThrow(
      /Not a member of session/,
    );
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid climb UUID (validation runs before broadcast)', async () => {
    const ctx = makeCtx();
    await expect(sessionMutations.confirmClimbOnWall(undefined, { climbUuid: '' }, ctx)).rejects.toThrow(/climbUuid/i);
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('forwards the optional queueItemUuid argument when supplied', async () => {
    const ctx = makeCtx({ participantId: 'participant-1' });
    const queueItemUuid = '33333333-3333-3333-3333-333333333333';

    await sessionMutations.confirmClimbOnWall(undefined, { climbUuid: validClimbUuid, queueItemUuid }, ctx);

    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        __typename: 'WallConfirmedClimb',
        queueItemUuid,
      }),
    );
  });

  it('rejects when climbUuid is not in the session recent-climbs buffer (grief-vector guard)', async () => {
    // Buffer turns over every wall change, so an arbitrary or forged
    // climbUuid is not in it. Without this guard any member could spam fake
    // confirms for an unrelated climbUuid and suppress everyone's 2 s
    // recovery fallback.
    roomManagerMock.isRecentClimb.mockResolvedValueOnce(false);
    const ctx = makeCtx();

    await expect(sessionMutations.confirmClimbOnWall(undefined, { climbUuid: validClimbUuid }, ctx)).rejects.toThrow(
      /not in session .* recent climbs/i,
    );
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('accepts a confirm for a climb that is no longer current but is still recent (navigate-on race)', async () => {
    // The driver navigated on between BLE write and mutation arrival: the
    // session's current climb has moved past the one being confirmed, but the
    // ring buffer still has the climbUuid because it was authoritative
    // moments ago. confirmClimbOnWall should accept it.
    roomManagerMock.isRecentClimb.mockResolvedValueOnce(true);
    const ctx = makeCtx({ participantId: 'participant-1' });

    await sessionMutations.confirmClimbOnWall(undefined, { climbUuid: validClimbUuid }, ctx);

    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        __typename: 'WallConfirmedClimb',
        climbUuid: validClimbUuid,
        confirmedByParticipantId: 'participant-1',
      }),
    );
  });
});

describe('setSessionBoardSerial mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSessionMemberMock.mockResolvedValue(undefined);
  });

  it('persists the serial and publishes SessionBoardSerialChanged when the value changes, returning a Session', async () => {
    // Previous serial was null → caller sets the first value, an actual transition.
    roomManagerMock.setSessionBoardSerialAndReturnPrevious.mockResolvedValueOnce(null);
    // The resolver re-reads the authoritative value rather than echoing
    // input; mock the read to return the value we just wrote.
    roomManagerMock.getSessionBoardSerial.mockResolvedValueOnce(validSerial);
    const ctx = makeCtx();

    const result = await sessionMutations.setSessionBoardSerial(undefined, { serial: validSerial }, ctx);

    // Resolver now returns Session! (mirrors takeControl / releaseControl).
    expect(result).toMatchObject({
      id: 'session-1',
      lastConnectedBoardSerial: validSerial,
    });
    expect(roomManagerMock.setSessionBoardSerialAndReturnPrevious).toHaveBeenCalledWith('session-1', validSerial);
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith('session-1', {
      __typename: 'SessionBoardSerialChanged',
      lastConnectedBoardSerial: validSerial,
    });
  });

  it('is idempotent — no event fires when the stored serial already matches', async () => {
    // Previous serial equals the incoming value: no transition, no broadcast.
    roomManagerMock.setSessionBoardSerialAndReturnPrevious.mockResolvedValueOnce(validSerial);
    roomManagerMock.getSessionBoardSerial.mockResolvedValueOnce(validSerial);
    const ctx = makeCtx();

    const result = await sessionMutations.setSessionBoardSerial(undefined, { serial: validSerial }, ctx);

    expect(result).toMatchObject({
      id: 'session-1',
      lastConnectedBoardSerial: validSerial,
    });
    expect(roomManagerMock.setSessionBoardSerialAndReturnPrevious).toHaveBeenCalledWith('session-1', validSerial);
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('broadcasts when a participant overwrites a different board serial (e.g. moving to a second board)', async () => {
    roomManagerMock.setSessionBoardSerialAndReturnPrevious.mockResolvedValueOnce('KB-OLD-9999');
    roomManagerMock.getSessionBoardSerial.mockResolvedValueOnce(validSerial);
    const ctx = makeCtx();

    await sessionMutations.setSessionBoardSerial(undefined, { serial: validSerial }, ctx);

    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith('session-1', {
      __typename: 'SessionBoardSerialChanged',
      lastConnectedBoardSerial: validSerial,
    });
  });

  it('returns the authoritative serial from the room manager, not the input (concurrent-writer race)', async () => {
    // Another writer landed between our write and our read-back. The
    // resolver should return what the room manager says is current, not the
    // value we tried to set — matches takeControl/releaseControl/confirm.
    roomManagerMock.setSessionBoardSerialAndReturnPrevious.mockResolvedValueOnce(null);
    roomManagerMock.getSessionBoardSerial.mockResolvedValueOnce('KB-RACER-0001');
    const ctx = makeCtx();

    const result = await sessionMutations.setSessionBoardSerial(undefined, { serial: validSerial }, ctx);

    expect(result).toMatchObject({
      id: 'session-1',
      lastConnectedBoardSerial: 'KB-RACER-0001',
    });
  });

  it('rejects non-members and does not write to the room manager', async () => {
    requireSessionMemberMock.mockRejectedValueOnce(new Error('Not a member of session'));
    const ctx = makeCtx();

    await expect(sessionMutations.setSessionBoardSerial(undefined, { serial: validSerial }, ctx)).rejects.toThrow(
      /Not a member of session/,
    );
    expect(roomManagerMock.setSessionBoardSerialAndReturnPrevious).not.toHaveBeenCalled();
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid serial (validation runs before any write)', async () => {
    const ctx = makeCtx();
    await expect(sessionMutations.setSessionBoardSerial(undefined, { serial: 'has spaces!' }, ctx)).rejects.toThrow(
      /serial/i,
    );
    expect(roomManagerMock.setSessionBoardSerialAndReturnPrevious).not.toHaveBeenCalled();
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('throws when ctx.participantId is missing and does not mutate state or publish', async () => {
    // Regression guard: an earlier revision placed the participantId hard-error
    // AFTER the roomManager write and SessionBoardSerialChanged publish, so
    // anonymous callers still mutated Redis and broadcast before being rejected.
    const ctx = makeCtx({ participantId: undefined, connectionId: 'conn-anon-1' });
    await expect(sessionMutations.setSessionBoardSerial(undefined, { serial: validSerial }, ctx)).rejects.toThrow(
      /requires ctx\.participantId/,
    );
    expect(roomManagerMock.setSessionBoardSerialAndReturnPrevious).not.toHaveBeenCalled();
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });
});

describe('setSessionBoardPath mutation', () => {
  const newPath = '/kilter/1/1/1/35/play/abc-123';
  const oldPath = '/kilter/1/1/1/40/play/abc-123';

  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` only clears call history; queued
    // `mockResolvedValueOnce` from tests that throw early (e.g. the
    // missing-participantId hard-error) survive into the next test and
    // get consumed in the wrong place. Reset implementation explicitly
    // for the mocks this block sets per-test so each test starts clean.
    roomManagerMock.updateSessionBoardPathIfChanged.mockReset();
    requireSessionMemberMock.mockResolvedValue(undefined);
    // Default: the read-back returns the new boardPath that the test wrote.
    roomManagerMock.getSessionById.mockResolvedValue({
      name: 'Test Session',
      boardPath: newPath,
      goal: null,
      isPublic: true,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt: null,
      isPermanent: false,
      color: null,
    });
  });

  it('persists the boardPath and publishes SessionBoardPathChanged when it changes, returning a Session', async () => {
    roomManagerMock.updateSessionBoardPathIfChanged.mockResolvedValueOnce(oldPath);
    const ctx = makeCtx({ participantId: 'participant-1' });

    const result = await sessionMutations.setSessionBoardPath(undefined, { boardPath: newPath }, ctx);

    expect(result).toMatchObject({ id: 'session-1', boardPath: newPath });
    expect(roomManagerMock.updateSessionBoardPathIfChanged).toHaveBeenCalledWith('session-1', newPath);
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith('session-1', {
      __typename: 'SessionBoardPathChanged',
      boardPath: newPath,
      changedByParticipantId: 'participant-1',
    });
  });

  it('is idempotent — no event fires when the stored boardPath already matches', async () => {
    // Room manager reports null = no change.
    roomManagerMock.updateSessionBoardPathIfChanged.mockResolvedValueOnce(null);
    const ctx = makeCtx({ participantId: 'participant-1' });

    await sessionMutations.setSessionBoardPath(undefined, { boardPath: newPath }, ctx);

    expect(roomManagerMock.updateSessionBoardPathIfChanged).toHaveBeenCalledWith('session-1', newPath);
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('rejects non-members and does not write to the room manager', async () => {
    requireSessionMemberMock.mockRejectedValueOnce(new Error('Not a member of session'));
    const ctx = makeCtx({ participantId: 'participant-1' });

    await expect(sessionMutations.setSessionBoardPath(undefined, { boardPath: newPath }, ctx)).rejects.toThrow(
      /Not a member of session/,
    );
    expect(roomManagerMock.updateSessionBoardPathIfChanged).not.toHaveBeenCalled();
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('hard-errors when ctx.participantId is missing (refuses to fall back to connectionId)', async () => {
    const ctx = makeCtx({ participantId: undefined });
    roomManagerMock.updateSessionBoardPathIfChanged.mockResolvedValueOnce(oldPath);

    await expect(sessionMutations.setSessionBoardPath(undefined, { boardPath: newPath }, ctx)).rejects.toThrow(
      /requires ctx.participantId/,
    );
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('throws when the session row vanished between membership check and the response read', async () => {
    // Race scenario: leaveSession (or a sweep) deletes the row after
    // requireSessionMember passed but before the response builder reads
    // sessionData. The resolver throws explicitly rather than returning
    // a malformed Session with an empty-string boardPath next to nullable
    // fields filled with null.
    roomManagerMock.updateSessionBoardPathIfChanged.mockResolvedValueOnce(oldPath);
    roomManagerMock.getSessionById.mockResolvedValueOnce(null);
    const ctx = makeCtx({ participantId: 'participant-1' });

    await expect(sessionMutations.setSessionBoardPath(undefined, { boardPath: newPath }, ctx)).rejects.toThrow(
      /not found after membership check/,
    );
    // The publish already happened (we successfully wrote and broadcast
    // before the read). That's an acceptable outcome — clients receive
    // the new boardPath; the throw only prevents serving back a malformed
    // Session payload to the caller.
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalled();
  });

  it('propagates the room-manager not-found throw without publishing', async () => {
    // `updateSessionBoardPathIfChanged` now distinguishes "not found"
    // (throws) from "unchanged" (returns null). Reaching the throw
    // branch means a race between `requireSessionMember` and the
    // helper's SELECT — surface it cleanly rather than silently
    // dropping the broadcast. No event fires.
    roomManagerMock.updateSessionBoardPathIfChanged.mockRejectedValueOnce(
      new Error('updateSessionBoardPathIfChanged: session session-1 not found'),
    );
    const ctx = makeCtx({ participantId: 'participant-1' });

    await expect(sessionMutations.setSessionBoardPath(undefined, { boardPath: newPath }, ctx)).rejects.toThrow(
      /not found/,
    );
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('pins the concurrent double-publish contract — two interleaved writes both broadcast', async () => {
    // The helper is non-atomic (read-then-write per `session-discovery.ts`).
    // Two callers landing concurrently can both read the same prior value
    // and both publish `SessionBoardPathChanged`. The client tolerates this
    // because `router.replace(newPath)` is a no-op when the URL is already
    // at `newPath`. Pin the contract so a future de-dup change here doesn't
    // silently invalidate the client's assumption.
    roomManagerMock.updateSessionBoardPathIfChanged.mockResolvedValue(oldPath);
    const ctxA = makeCtx({ participantId: 'participant-a', connectionId: 'conn-a' });
    const ctxB = makeCtx({ participantId: 'participant-b', connectionId: 'conn-b' });

    await Promise.all([
      sessionMutations.setSessionBoardPath(undefined, { boardPath: newPath }, ctxA),
      sessionMutations.setSessionBoardPath(undefined, { boardPath: newPath }, ctxB),
    ]);

    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledTimes(2);
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith('session-1', {
      __typename: 'SessionBoardPathChanged',
      boardPath: newPath,
      changedByParticipantId: 'participant-a',
    });
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith('session-1', {
      __typename: 'SessionBoardPathChanged',
      boardPath: newPath,
      changedByParticipantId: 'participant-b',
    });
  });
});
